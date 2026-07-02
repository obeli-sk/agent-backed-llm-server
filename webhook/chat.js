// OpenAI-compatible chat-completions endpoint backed by a warm claude/codex CLI.
//
//   POST /v1/chat/completions   { model, messages, tools? }  ->  chat.completion
//
// It is stateless per request: the client resends the whole history every turn.
// We pair each request to a long-running session workflow purely by history
// content (no session header), deliver the newest messages through that
// session's turn.request stub, and read the reply from its turn.response stub.
// See README.md for the design and the stub pair.

const WORKFLOW_FFQN = "agent-llm:session/workflow.session";
const TURN_REQUEST_FFQN = "agent-llm:session/turn.request";

const API_BASE = (process.env["OBELISK_API_URL"] || "http://127.0.0.1:5005").replace(/\/$/, "");
const START_POLL_BUDGET_MS = 90000;   // cold container start on turn 0

export default async function handle(request) {
    if (request.method !== "POST") return jsonError(405, "method not allowed");
    let body;
    try { body = JSON.parse(await request.text()); }
    catch (e) { return jsonError(400, `body must be JSON: ${String(e)}`); }

    const messages = Array.isArray(body?.messages) ? body.messages : null;
    if (!messages || messages.length === 0) return jsonError(400, "messages is required");
    const model = typeof body?.model === "string" ? body.model : "";
    const tools = Array.isArray(body?.tools) ? body.tools : [];

    try {
        const system = messages.find((m) => m && m.role === "system");
        const systemPrompt = system ? contentString(system.content) : "";
        const lastAssistant = lastIndex(messages, (m) => m && m.role === "assistant");

        let respId;
        if (lastAssistant === -1) {
            respId = await turnZero(messages, systemPrompt, tools, model);
        } else {
            respId = await continuation(messages, systemPrompt, lastAssistant);
        }

        const reply = getReply(respId);   // { final } | { tool_calls }
        return jsonResponse(openaiResponse(reply, model));
    } catch (e) {
        if (e && e.httpStatus) return jsonError(e.httpStatus, e.message);
        return jsonError(502, String(e && e.message ? e.message : e));
    }
}

// Turn 0: no assistant in the history yet. Start a new session workflow, then
// deliver the opening user message(s) through its first turn.request.
async function turnZero(messages, systemPrompt, tools, model) {
    const backend = pickBackend(model);
    const sessionId = obelisk.executionIdGenerate();
    const workflowSystem = systemPrompt + renderToolsPrompt(tools);
    obelisk.schedule(sessionId, WORKFLOW_FFQN, [backend, workflowSystem]);

    const req = await pollForSessionRequest(sessionId);
    const delta = messagesToInput(messagesAfterSystem(messages), null);
    await injectStub(req.reqId, { ok: { delta: JSON.stringify(delta) } });
    return req.respId;
}

// Turn k>=1: pair by the committed-history hash, deliver the delta (idempotently),
// and return the response-stub id to read the reply from.
async function continuation(messages, systemPrompt, lastAssistant) {
    const prefixHash = computePrefixHash(systemPrompt, messages, lastAssistant);
    const priorToolCalls = toolCallsOf(messages[lastAssistant]);
    const delta = messagesToInput(messages.slice(lastAssistant + 1), priorToolCalls);

    // Prefer a still-pending request stub (deliver the delta). If none matches but
    // a finished one does, the delta was already delivered (a retry): just re-read.
    const pending = await findRequestByHash(prefixHash, true);
    if (pending) {
        await injectStub(pending.reqId, { ok: { delta: JSON.stringify(delta) } });
        return pending.respId;
    }
    const finished = await findRequestByHash(prefixHash, false);
    if (finished) return finished.respId;
    throw httpError(409, "no open session matches this conversation history");
}

// Block until the session's reply arrives. obelisk.get waits for the stub to be
// fulfilled; the workflow injects { ok: <reply JSON> } or an err (idle/teardown).
function getReply(respId) {
    let raw;
    try { raw = obelisk.get(respId); }
    catch (e) { throw httpError(502, `session ended without a reply: ${String(e)}`); }
    try { return JSON.parse(raw); }
    catch (e) { throw httpError(502, `reply was not valid JSON: ${String(e)}`); }
}

// ---- pairing: rolling hash over canonical agent-inputs and replies -----------
// Must stay byte-identical with the copies in workflow/session.js.

function computePrefixHash(systemPrompt, messages, lastAssistant) {
    let h = seedHash(systemPrompt);
    let buffer = [];
    let priorToolCalls = null;
    for (let i = firstNonSystem(messages); i <= lastAssistant; i += 1) {
        const m = messages[i];
        if (m && m.role === "assistant") {
            h = rollHash(h, canonicalInput(messagesToInput(buffer, priorToolCalls)));
            h = rollHash(h, canonicalReply(assistantToReply(m)));
            priorToolCalls = toolCallsOf(m);
            buffer = [];
        } else if (m && m.role !== "system") {
            buffer.push(m);
        }
    }
    return h;
}

function seedHash(systemPrompt) { return hash64("agent-llm:v1 " + String(systemPrompt || "")); }
function rollHash(prev, item) { return hash64(prev + " " + item); }

function canonicalInput(input) {
    if (input && typeof input.prompt === "string") return "P:" + input.prompt;
    if (input && Array.isArray(input.tool_results)) {
        const parts = input.tool_results.map((tr) => {
            const o = tr && tr.outcome;
            const body = o && "ok" in o ? "ok:" + String(o.ok) : "err:" + String(o && o.err);
            return String(tr && tr.name) + "=" + body;
        });
        return "T:" + parts.join("");
    }
    return "?:" + JSON.stringify(input);
}
function canonicalReply(reply) {
    if (reply && typeof reply.final === "string") return "F:" + reply.final;
    if (reply && Array.isArray(reply.tool_calls)) {
        const parts = reply.tool_calls.map((c) => String(c && c.name) + "(" + String(c && c.arguments_json) + ")");
        return "C:" + parts.join("");
    }
    return "?:" + JSON.stringify(reply);
}
function hash64(str) {
    let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
    for (let i = 0; i < str.length; i += 1) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

// ---- OpenAI <-> common shapes ------------------------------------------------

// A group of messages since the last assistant becomes one agent-input:
// tool messages -> { tool_results }, otherwise the user text -> { prompt }.
function messagesToInput(group, priorToolCalls) {
    const tools = group.filter((m) => m && m.role === "tool");
    if (tools.length > 0) {
        const idToName = {};
        for (const c of (priorToolCalls || [])) if (c && c.id) idToName[c.id] = (c.function && c.function.name) || "";
        return {
            tool_results: tools.map((m) => ({
                name: idToName[m.tool_call_id] || "",
                outcome: { ok: contentString(m.content) },
            })),
        };
    }
    const users = group.filter((m) => m && m.role === "user");
    return { prompt: users.map((m) => contentString(m.content)).join("\n") };
}

function assistantToReply(m) {
    const calls = toolCallsOf(m);
    if (calls.length > 0) {
        return { tool_calls: calls.map((c) => ({ name: (c.function && c.function.name) || "", arguments_json: (c.function && c.function.arguments) || "{}" })) };
    }
    return { final: contentString(m.content) };
}

function openaiResponse(reply, model) {
    let message;
    let finish;
    if (Array.isArray(reply.tool_calls)) {
        message = {
            role: "assistant",
            content: null,
            tool_calls: reply.tool_calls.map((c, i) => ({
                id: "call_" + i,
                type: "function",
                function: { name: c.name, arguments: c.arguments_json },
            })),
        };
        finish = "tool_calls";
    } else {
        message = { role: "assistant", content: typeof reply.final === "string" ? reply.final : "" };
        finish = "stop";
    }
    return {
        id: "chatcmpl-" + obelisk.executionIdCurrent(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model || "agent-llm",
        choices: [{ index: 0, message, finish_reason: finish }],
    };
}

// Render the request's tools[] into the envelope instructions the CLI shim
// (server.js) parses. The CLI keeps its own inner FS/shell loop; these are the
// durable, workflow-visible tools it surfaces via the {"tool_calls"} envelope.
function renderToolsPrompt(tools) {
    if (!tools || tools.length === 0) return "";
    const lines = tools.map((t) => {
        const f = t && t.function ? t.function : {};
        return `- ${f.name}: ${f.description || ""}\n  parameters: ${JSON.stringify(f.parameters || {})}`;
    });
    return [
        "",
        "",
        "# Tools",
        'To call tools, reply with a JSON object {"tool_calls":[{"name":"...","args":{...}}]}.',
        'To answer, reply with {"final":"..."} or plain prose. One batch of tool_calls per reply.',
        "",
        "Available tools:",
        lines.join("\n"),
    ].join("\n");
}

// ---- REST helpers (fetch to the local Obelisk API) ---------------------------

async function pollForSessionRequest(sessionId) {
    const deadline = Date.now() + START_POLL_BUDGET_MS;
    while (Date.now() < deadline) {
        const found = await findRequest(`ffqn_prefix=${enc(TURN_REQUEST_FFQN)}&execution_id_prefix=${enc(sessionId)}&hide_finished=true`,
            () => true);
        if (found) return found;
    }
    throw httpError(504, "timed out waiting for the session to start");
}

async function findRequestByHash(prefixHash, pendingOnly) {
    const filter = `ffqn_prefix=${enc(TURN_REQUEST_FFQN)}${pendingOnly ? "&hide_finished=true" : ""}&length=200`;
    return findRequest(filter, (params) => params.expected === prefixHash);
}

// List turn.request executions, read each one's created params, return the first
// whose params satisfy `match` as { reqId, respId, expected }.
async function findRequest(filter, match) {
    let list;
    try { list = await apiGetJson(`GET /v1/executions?${filter}`); }
    catch (_) { return null; }
    const rows = Array.isArray(list) ? list : (list.executions || []);
    for (const row of rows) {
        const id = row.execution_id;
        if (!id) continue;
        const params = await readParams(id);
        if (!params) continue;
        if (match(params)) return { reqId: id, respId: params.response_id, expected: params.expected };
    }
    return null;
}

// The turn.request created params are [response-id, expected-prefix-hash].
async function readParams(id) {
    let payload;
    try { payload = await apiGetJson(`GET /v1/executions/${enc(id)}/events?version_from=0&including_cursor=true&length=1`); }
    catch (_) { return null; }
    const p = payload.events?.[0]?.event?.created?.params;
    if (!Array.isArray(p) || p.length < 2) return null;
    return { response_id: String(p[0]), expected: String(p[1]) };
}

async function injectStub(id, result) {
    const resp = await fetch(`${API_BASE}/v1/executions/${enc(id)}/stub`, {
        method: "PUT",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(result),
    });
    if (!resp.ok) throw httpError(502, `stub delivery failed: HTTP ${resp.status}: ${await resp.text()}`);
}

async function apiGetJson(methodPath) {
    const path = methodPath.replace(/^GET /, "");
    const resp = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" } });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text}`);
    return JSON.parse(text);
}

// ---- misc --------------------------------------------------------------------

function pickBackend(model) {
    const m = (model || "").toLowerCase();
    if (m.includes("codex") || m.startsWith("gpt") || m.startsWith("o1") || m.startsWith("o3")) return "codex";
    return "claude";
}
function contentString(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
    }
    return content == null ? "" : String(content);
}
function toolCallsOf(m) { return m && Array.isArray(m.tool_calls) ? m.tool_calls : []; }
function messagesAfterSystem(messages) { return messages.slice(firstNonSystem(messages)); }
function firstNonSystem(messages) {
    let i = 0;
    while (i < messages.length && messages[i] && messages[i].role === "system") i += 1;
    return i;
}
function lastIndex(arr, pred) { for (let i = arr.length - 1; i >= 0; i -= 1) if (pred(arr[i])) return i; return -1; }
function enc(v) { return encodeURIComponent(v); }

function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function jsonError(status, message) { return jsonResponse({ error: { message, type: "invalid_request_error" } }, status); }
function httpError(status, message) { const e = new Error(message); e.httpStatus = status; return e; }
