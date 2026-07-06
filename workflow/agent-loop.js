// Cancellable child workflow: the per-conversation turn loop. Its parent
// (workflow.session) owns the docker container + warm CLI and does the cleanup;
// this workflow only drives turns over the already-open socket. The
// `-cancellable` suffix (loop.agent-loop-cancellable) lets an external party
// stop it with the cancel RPC, which is how the frontend closes a session,
// including mid-turn while it is blocked awaiting the LLM reply. The parent
// still awaits and outlives this child (structured concurrency is unchanged);
// cancellation just gives the frontend a clean stop that used to require an
// in-band teardown message.
//
// Each turn:
//   1. submit turn.response (respId) and turn.request (carrying respId + the
//      committed-history hash) so the webhook can find us and where to reply;
//   2. await turn.request, raced against a persistent sleep (idle cleanup);
//   3. render the delta into an agent-input, send it to the CLI, recv the reply;
//   4. self-fulfil turn.response(respId) with the reply via responseStub;
//   5. roll the delta and the reply into the committed hash and loop.
//
// The webhook never parses LLM JSON: the reply is already the normalized
// { final } | { tool_calls } shape produced by the container's server.js.

import * as session from "agent-backed-llm:agent/session";
import { requestSubmit, responseSubmit } from "agent-backed-llm:session-obelisk-ext/turn";
import { responseStub } from "agent-backed-llm:session-obelisk-stub/turn";

const RECV_TIMEOUT_MS = 30000;
const IDLE_TIMEOUT = { minutes: 10 };   // persistent sleep: reclaim an abandoned session
const DEFAULT_MAX_TURNS = 200;          // safety bound when the webhook passes nothing usable
const MAX_CORRECTIONS = 3;

// maxTurns comes from the webhook (which reads AGENT_MAX_TURNS); workflows can't
// read env, so it arrives as a scheduled param. It bounds a session's lifetime.
export default function agentLoopCancellable(socketPath, systemPrompt, maxTurns) {
    if (typeof socketPath !== "string" || !socketPath) throw "socket is required";
    if (typeof systemPrompt !== "string") throw "system-prompt is required";
    const turnCap = Number.isInteger(maxTurns) && maxTurns > 0 ? maxTurns : DEFAULT_MAX_TURNS;

    let committed = seedHash(systemPrompt);
    for (let turn = 0; turn < turnCap; turn += 1) {
        const next = awaitTurn(committed, turn);
        if (next === null) return "session idle; cleaned up";

        const input = parseInput(next.delta);
        committed = rollHash(committed, canonicalInput(input));

        // Invariant: respId lives in next.respSet, a join set owned by THIS
        // cancellable child. On a frontend cancel mid-turn none of the handlers
        // below run (a cancelled workflow is not advanced again) -- the webhook's
        // blocking read of respId is unblocked only because cancelling this child
        // closes respSet from the log, which cancels the pending turn.response
        // stub. Do not move respId to a parent-owned or -scheduled join set: that
        // would leave the webhook hanging forever on a cancel.
        try {
            const reply = sendAndDrain(socketPath, input);
            responseStub(next.respId, { ok: JSON.stringify(reply) });
            committed = rollHash(committed, canonicalReply(reply));
            console.log(`--- turn ${turn} done (${replyKind(reply)}) ---`);
        } catch (error) {
            try { responseStub(next.respId, { err: String(error) }); } catch (_) {}
            throw error;
        } finally {
            next.respSet.close();
        }
    }
    return "session ended";
}

// Publish the two stubs for this turn and block until either the webhook
// delivers the next turn (via turn.request) or the idle sleep fires. Returns
//   { respSet, respId, delta } | null (idle timeout).
function awaitTurn(committed, turn) {
    const respSet = obelisk.createJoinSet({ name: `response-${turn}` });
    const respId = responseSubmit(respSet);

    const raceSet = obelisk.createJoinSet({ name: `request-${turn}` });
    const reqId = requestSubmit(raceSet, respId, committed);
    raceSet.submitDelay(IDLE_TIMEOUT);

    try {
        const winner = raceSet.joinNext();
        if (winner.type === "delay") {
            // Idle: no request arrived in time. Drop the unanswered response stub.
            responseStub(respId, { err: "session idle timeout" });
            respSet.close();
            return null;
        }
        const delta = obelisk.getResult(reqId);   // ok = the delta JSON string
        if (typeof delta !== "string") throw `turn.request returned an unexpected value: ${JSON.stringify(delta)}`;
        return { respSet, respId, delta };
    } finally {
        // Cancel the losing idle delay once the request stub has completed.
        raceSet.close();
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

function seedHash(systemPrompt) { return hash64("agent-backed-llm:v1\0" + String(systemPrompt || "")); }
function rollHash(prev, item) { return hash64(prev + "\0" + item); }

function canonicalInput(input) {
    if (input && typeof input.prompt === "string") return "P:" + input.prompt;
    if (input && Array.isArray(input.tool_results)) {
        const parts = input.tool_results.map((tr) => {
            const o = tr && tr.outcome;
            const body = o && "ok" in o ? "ok:" + String(o.ok) : "err:" + String(o && o.err);
            return String(tr && tr.name) + "=" + body;
        });
        return "T:" + parts.join("\x01");
    }
    return "?:" + JSON.stringify(input);
}
function canonicalReply(reply) {
    if (reply && typeof reply.final === "string") return "F:" + reply.final;
    if (reply && Array.isArray(reply.tool_calls)) {
        const parts = reply.tool_calls.map((c) => String(c && c.name) + "(" + String(c && c.arguments_json) + ")");
        return "C:" + parts.join("\x01");
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
