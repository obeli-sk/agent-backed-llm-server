// Long-running session workflow: one per conversation. It owns the docker
// container + warm claude/codex CLI (via the exec activities) and is driven, one
// turn at a time, by the chat-completions webhook through a pair of stub
// activities. See README.md for the full design.
//
// Each turn:
//   1. submit turn.response (respId) and turn.request (carrying respId + the
//      committed-history hash) so the webhook can find us and where to reply;
//   2. await turn.request, raced against a persistent sleep (idle cleanup);
//   3. render the delta into an agent-input, send it to the CLI, recv the reply;
//   4. self-fulfil turn.response(respId) with the reply via obelisk.stub;
//   5. roll the delta and the reply into the committed hash and loop.
//
// The webhook never parses LLM JSON: the reply is already the normalized
// { final } | { tool_calls } shape produced by the container's server.js.

import * as claude from "agent-llm:agent/claude";
import * as codex from "agent-llm:agent/codex";
import * as session from "agent-llm:agent/session";

const TURN_REQUEST_FFQN = "agent-llm:session/turn.request";
const TURN_RESPONSE_FFQN = "agent-llm:session/turn.response";
const STARTERS = { claude: claude.start, codex: codex.start };

const RECV_TIMEOUT_MS = 30000;
const IDLE_TIMEOUT = { minutes: 10 };   // persistent sleep: reclaim an abandoned session
const MAX_TURNS = 200;                  // safety bound on a single conversation
const MAX_CORRECTIONS = 3;

export default function sessionWorkflow(backend, systemPrompt) {
    const which = (typeof backend === "string" && backend) ? backend : "claude";
    const start = STARTERS[which];
    if (!start) throw `unknown backend: ${which} (expected claude or codex)`;
    if (typeof systemPrompt !== "string") throw "system-prompt is required";

    const executionId = obelisk.executionIdCurrent();
    const sessionId = sanitize(executionId);
    const containerName = `agent-llm-${sessionId}`;
    const socketPath = `/tmp/agent-llm/${sessionId}.sock`;

    let workflowError = null;
    let outcome = "session ended";
    try {
        const startInfo = start(containerName, socketPath, systemPrompt);
        console.log(`Started ${which} agent ${startInfo.container} from ${startInfo.image}`);

        let committed = seedHash(systemPrompt);
        for (let turn = 0; turn < MAX_TURNS; turn += 1) {
            const next = awaitTurn(committed);
            if (next === null) { outcome = "session idle; cleaned up"; break; }
            if (next.teardown) { outcome = "session torn down by operator"; break; }

            const input = parseInput(next.delta);
            committed = rollHash(committed, canonicalInput(input));

            const reply = sendAndDrain(socketPath, input);
            obelisk.stub(next.respId, { ok: JSON.stringify(reply) });
            committed = rollHash(committed, canonicalReply(reply));
            console.log(`--- turn ${turn} done (${replyKind(reply)}) ---`);
        }
    } catch (error) {
        workflowError = error;
    } finally {
        try {
            session.cleanup(containerName, socketPath);
            console.log(`Cleaned up ${containerName}`);
        } catch (error) {
            console.log(`Cleanup failed for ${containerName}: ${String(error)}`);
            if (workflowError === null) workflowError = error;
        }
    }
    if (workflowError !== null) throw workflowError;
    return outcome;
}

// Publish the two stubs for this turn and block until either the webhook
// delivers the next turn (via turn.request) or the idle sleep fires. Returns
//   { respId, delta } | { respId, teardown: true } | null (idle timeout).
function awaitTurn(committed) {
    const respSet = obelisk.createJoinSet({ name: "response" });
    const respId = respSet.submit(TURN_RESPONSE_FFQN, []);

    const raceSet = obelisk.createJoinSet({ name: "request" });
    const reqId = raceSet.submit(TURN_REQUEST_FFQN, [respId, committed]);
    raceSet.submitDelay(IDLE_TIMEOUT);

    try {
        const winner = raceSet.joinNext();
        if (winner.type === "delay") {
            // Idle: no request arrived in time. Drop the unanswered response stub.
            obelisk.stub(respId, { err: "session idle timeout" });
            return null;
        }
        const value = obelisk.getResult(reqId);   // variant { delta(string), teardown }
        if (value === "teardown" || (value && value.teardown !== undefined)) {
            obelisk.stub(respId, { err: "session torn down" });
            return { respId, teardown: true };
        }
        const delta = (value && typeof value.delta === "string") ? value.delta : null;
        if (delta === null) throw `turn.request returned an unexpected value: ${JSON.stringify(value)}`;
        return { respId, delta };
    } finally {
        try { raceSet.close(); } catch (e) { console.log(`request join set close failed: ${String(e)}`); }
        try { respSet.close(); } catch (e) { console.log(`response join set close failed: ${String(e)}`); }
    }
}

// Send one agent-input and drain a full turn, returning the normalized reply
// { final: string } | { tool_calls: [{ name, arguments_json }] }. Handles the
// CLI's session-limit (durable sleep + resend) and a malformed reply (re-prompt).
function sendAndDrain(socketPath, input) {
    let pending = input;
    let corrections = 0;
    while (true) {
        session.send(socketPath, pending, []);
        try {
            const reply = drainTurn(socketPath);
            // The { error } envelope has no chat-completions equivalent; surface
            // it as ordinary assistant content so the mapping stays reversible.
            if (typeof reply.error === "string") return { final: reply.error };
            return reply;
        } catch (error) {
            const limit = rateLimited(error);
            if (limit) {
                const seconds = limit.retry_after_seconds > 0 ? limit.retry_after_seconds : 1;
                console.log(`session limit reached (${limit.message}); sleeping ${seconds}s`);
                obelisk.sleep({ seconds });
                continue;
            }
            const malformed = malformedReply(error);
            if (malformed && corrections < MAX_CORRECTIONS) {
                corrections += 1;
                console.log(`malformed reply (correction ${corrections}/${MAX_CORRECTIONS}): ${malformed}`);
                pending = { prompt: correctionPrompt(malformed) };
                continue;
            }
            throw error;
        }
    }
}

function drainTurn(socketPath) {
    const outcome = session.recv(socketPath, RECV_TIMEOUT_MS);
    if (outcome && typeof outcome === "object" && outcome.reply) {
        const r = outcome.reply;
        return (r && typeof r === "object" && "reply" in r) ? r.reply : r;
    }
    throw `unexpected recv outcome: ${JSON.stringify(outcome)}`;
}

function correctionPrompt(detail) {
    return [
        "Your previous reply looked like it requested tools but the JSON could not be parsed.",
        `Parse error: ${detail}`,
        "To call tools, emit a valid JSON object with tool_calls, each containing name and args.",
        "If you are not calling tools, reply with a final answer.",
    ].join(" ");
}

// ---- error classification (recv err variant, JSON-encoded in the message) ----
function errPayload(error) {
    const raw = (error && typeof error === "object" && typeof error.message === "string")
        ? error.message
        : (typeof error === "string" ? error : null);
    if (raw === null) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_) { return null; }
}
function rateLimited(error) {
    const p = errPayload(error);
    return p && p.permanent_rate_limited && typeof p.permanent_rate_limited === "object"
        ? p.permanent_rate_limited : null;
}
function malformedReply(error) {
    const p = errPayload(error);
    return p && typeof p.permanent_malformed_reply === "string" ? p.permanent_malformed_reply : null;
}

// ---- committed-history hash --------------------------------------------------
// Both the workflow and the webhook roll a hash over the SAME canonical objects
// (agent-inputs and replies) so the webhook can pair a request by recomputing
// the hash from the conversation history. Keep these functions byte-identical
// with the copies in webhook/chat.js.

function seedHash(systemPrompt) { return hash64("agent-llm:v1 " + String(systemPrompt || "")); }
function rollHash(prev, item) { return hash64(prev + " " + item); }

function canonicalInput(input) {
    if (input && typeof input.prompt === "string") return "P:" + input.prompt;
    if (input && Array.isArray(input.tool_results)) {
        const parts = input.tool_results.map((tr) => {
            const o = tr && tr.outcome;
            const body = o && "ok" in o ? "ok:" + String(o.ok) : "err:" + String(o && o.err);
            return String(tr && tr.name) + "=" + body;
        });
        return "T:" + parts.join("");
    }
    return "?:" + JSON.stringify(input);
}
function canonicalReply(reply) {
    if (reply && typeof reply.final === "string") return "F:" + reply.final;
    if (reply && Array.isArray(reply.tool_calls)) {
        const parts = reply.tool_calls.map((c) => String(c && c.name) + "(" + String(c && c.arguments_json) + ")");
        return "C:" + parts.join("");
    }
    return "?:" + JSON.stringify(reply);
}

// 64-bit string hash (cyrb-style). Deterministic; no Date/Math.random, so it is
// safe inside a workflow. Returns 16 hex chars.
function hash64(str) {
    let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
    for (let i = 0; i < str.length; i += 1) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    const hi = (h2 >>> 0).toString(16).padStart(8, "0");
    const lo = (h1 >>> 0).toString(16).padStart(8, "0");
    return hi + lo;
}

function parseInput(deltaJson) {
    let input;
    try { input = JSON.parse(deltaJson); }
    catch (e) { throw `delta is not valid JSON: ${String(e)}`; }
    const valid = input && typeof input === "object" &&
        (typeof input.prompt === "string" || Array.isArray(input.tool_results));
    if (!valid) throw "delta must decode to { prompt } or { tool_results }";
    return input;
}
function replyKind(reply) { return Array.isArray(reply.tool_calls) ? `${reply.tool_calls.length} tool_call(s)` : "final"; }
function sanitize(value) { return String(value).replace(/[^A-Za-z0-9_.-]/g, "-"); }
