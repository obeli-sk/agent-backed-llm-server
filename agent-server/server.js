#!/usr/bin/env node

// Runs Codex turns and normalizes their events over a Unix socket.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const SOCKET_PATH = process.argv[2];
if (!SOCKET_PATH) {
  console.error("usage: server.js <socket-path>");
  process.exit(2);
}

const MODEL = process.env.AGENT_MODEL || "";
// Orphan guard: self-terminate if no op arrives for this long, so a container
// cannot outlive a wedged session workflow (a failed auto-upgrade, a crash, or
// a bug that skips session.cleanup). Keep it well above the workflow idle
// timeout so a healthy idle session is always reclaimed by the workflow first.
const CONTAINER_IDLE_MS = (() => {
  const n = parseInt(process.env.AGENT_CONTAINER_IDLE_MS, 10);
  return Number.isInteger(n) && n > 0 ? n : 45 * 60 * 1000;
})();
const EXTRA = (process.env.AGENT_EXTRA_ARGS || "").trim();
const SYSTEM_PROMPT_PATH = process.env.AGENT_SYSTEM_PROMPT_PATH;
if (!SYSTEM_PROMPT_PATH) {
  console.error("AGENT_SYSTEM_PROMPT_PATH is required");
  process.exit(2);
}

// ---- shared event buffer ----------------------------------------------------

// All native events emitted by the backend(s), in arrival order.
const events = [];
// Number of events already returned to a recv() caller (for the raw stderr echo).
let consumed = 0;
// Index in `events` where the current turn's events begin (set on each send).
let turnStart = 0;
// Number of turns sent so far (the codex backend prepends the system prompt on
// turn 0 and switches to `exec resume` afterward).
let turnCount = 0;

// Parse a child's stdout as newline-delimited JSON, pushing each event onto the
// shared buffer. `onEvent` lets a backend react to events as they arrive.
function attachStdout(child, onEvent) {
  let buf = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch (e) { parsed = { type: "_unparseable", raw: line, parse_error: e.message }; }
      events.push(parsed);
      if (onEvent) onEvent(parsed);
    }
  });
}

function attachStderr(child, label) {
  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => process.stderr.write(`[${label} stderr] ${chunk}`));
}

// ---- shared parsing helpers -------------------------------------------------

function tryParse(value) {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

// Render the common `agent-input` into the user-message text. `prompt` is sent
// verbatim; `tool_results` becomes the JSON envelope the system prompt expects.
//
// A tool result whose ok value carries a `raw_body` string (e.g. file source)
// is not JSON-escaped into the envelope: the body is emitted verbatim *after*
// the JSON, wrapped in a per-message random nonce fence, and the envelope keeps
// only the marker under `body`. This keeps source readable and token-cheap for
// the model instead of a `\n`-escaped string. (The wire transport into this
// process is still JSON; this only changes what the model sees.)
function renderUserText(input) {
  if (input && typeof input.prompt === "string") return input.prompt;
  if (input && Array.isArray(input.tool_results)) {
    const nonce = randomBytes(4).toString("hex");
    const bodies = [];
    const results = input.tool_results.map((tr) => {
      const outcome = tr && tr.outcome;
      if (!outcome || !("ok" in outcome)) return { name: tr.name, err: outcome ? outcome.err : "error" };
      const val = tryParse(outcome.ok);
      if (val && typeof val === "object" && typeof val.raw_body === "string") {
        const marker = `${nonce}-${bodies.length}`;
        bodies.push({ marker, body: val.raw_body });
        const { raw_body, ...meta } = val;
        return { name: tr.name, ok: { ...meta, body: `@@${marker}@@` } };
      }
      return { name: tr.name, ok: val };
    });
    let msg = JSON.stringify({ tool_results: results });
    for (const b of bodies) {
      msg += `\n\n@@${b.marker}@@\n${b.body}\n@@/${b.marker}@@`;
    }
    return msg;
  }
  return null;
}

// Parse a turn's final assistant text into the common agent-reply shape:
//   { tool_calls: [{ name, arguments_json }] } | { final: string } |
//   { error: string }, or null.
//
// The model is free to think and narrate; we only fish the structured intent
// out of its prose:
//   - any {"tool_calls":[...]} object (bare or fenced, one or several) becomes
//     a single ordered tool_calls batch;
//   - a clean {"error":"..."} envelope requests an Err workflow result;
//   - otherwise the message *is* the final answer (prose), unwrapping a clean
//     {"final":"..."} envelope if that is all the model sent;
//   - null is returned only when the model clearly attempted a tool_calls
//     envelope we could not parse, so the workflow can re-prompt.
function extractReply(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;

  const calls = [];
  for (const obj of scanJsonObjects(trimmed)) {
    if (Array.isArray(obj.tool_calls)) {
      for (const c of obj.tool_calls) {
        calls.push({
          name: c && typeof c.name === "string" ? c.name : "",
          arguments_json: JSON.stringify(c && typeof c.args === "object" && c.args !== null ? c.args : {}),
        });
      }
    }
  }
  if (calls.length > 0) return { tool_calls: calls };

  // A tool-call was intended but did not parse: signal malformed so we re-prompt.
  if (/"tool_calls"\s*:/.test(trimmed)) return null;

  const requestedError = unwrapStringEnvelope(trimmed, "error");
  if (requestedError !== null) return { error: requestedError };

  // Final answer: unwrap a clean {"final":"..."} envelope, else use prose as-is.
  const unwrapped = unwrapStringEnvelope(trimmed, "final");
  return { final: unwrapped !== null ? unwrapped : trimmed };
}

// Every balanced top-level {...} JSON object in `text`, parsed, in order.
// Fences and surrounding prose are ignored: we scan for `{` and try to parse
// the balanced region. Objects that fail to parse are skipped.
function scanJsonObjects(text) {
  const objs = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i += 1; continue; }
    const end = findMatchingBrace(text, i);
    if (end === -1) break;
    try {
      const obj = JSON.parse(text.slice(i, end + 1));
      if (obj && typeof obj === "object") objs.push(obj);
    } catch (_) {}
    i = end + 1;
  }
  return objs;
}

// If the whole message is exactly a single string-valued action envelope
// (optionally wrapped in one ```...``` fence), return the string.
function unwrapStringEnvelope(text, key) {
  let body = text.trim();
  const fence = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (fence) body = fence[1].trim();
  try {
    const obj = JSON.parse(body);
    if (obj && typeof obj === "object" && typeof obj[key] === "string"
      && Object.keys(obj).length === 1) {
      return obj[key];
    }
  } catch (_) {}
  return null;
}

function findMatchingBrace(s, start) {
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < s.length; i += 1) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

// Remove balanced {tool_calls|final|error} envelope objects from assistant prose,
// keeping any other text/JSON. Used to derive narration (what the model said
// around its structured intent) without echoing the envelope itself.
function stripEnvelopes(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { out += text[i]; i += 1; continue; }
    const end = findMatchingBrace(text, i);
    if (end === -1) { out += text.slice(i); break; }
    const slice = text.slice(i, end + 1);
    let isEnvelope = false;
    try {
      const obj = JSON.parse(slice);
      if (obj && typeof obj === "object"
        && (Array.isArray(obj.tool_calls) || typeof obj.final === "string"
          || typeof obj.error === "string")) isEnvelope = true;
    } catch (_) {}
    if (!isEnvelope) out += slice;
    i = end + 1;
  }
  // Drop now-empty code fences left behind by a removed envelope.
  return out.replace(/```(?:json)?\s*```/g, "");
}

// Bound narration so a verbose turn cannot bloat the recv result. It rides back
// on recv stdout only (never re-sent to the model), so this is just hygiene.
const MAX_NARRATION_BYTES = 16 * 1024;
function boundNarration(text) {
  const t = (text || "").trim();
  return t.length > MAX_NARRATION_BYTES ? t.slice(0, MAX_NARRATION_BYTES) + "\n[...truncated]" : t;
}

// On a final turn the answer is plain prose, so it lands in the collected text
// too. Remove it so narration carries only thinking/reasoning, never a copy of
// the answer the UI already shows as the final bubble.
function dropFinalAnswer(text, reply) {
  if (reply && typeof reply.final === "string" && reply.final) {
    return text.split(reply.final).join("");
  }
  return text;
}

// Text of the last codex `agent_message` item in a turn slice. A codex turn can
// emit several agent_message items (preambles between tool calls); the final
// one carries the envelope.
function lastCodexAgentMessage(turnSlice) {
  for (let i = turnSlice.length - 1; i >= 0; i -= 1) {
    const e = turnSlice[i];
    if (e && e.type === "item.completed" && e.item && e.item.type === "agent_message"
      && typeof e.item.text === "string") {
      return e.item.text;
    }
  }
  return "";
}

// Parse "... resets 3:50pm (UTC)" into seconds from now until that UTC time.
// Falls back to one hour when the reset time is missing or unparseable.
const DEFAULT_RETRY_AFTER_SECONDS = 3600;
const RESET_BUFFER_SECONDS = 30;

function secondsUntilReset(message) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*([ap]m)?\s*\(?\s*UTC\s*\)?/i.exec(message || "");
  if (!m) return DEFAULT_RETRY_AFTER_SECONDS;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3] ? m[3].toLowerCase() : null;
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return DEFAULT_RETRY_AFTER_SECONDS;
  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0,
  ));
  if (target.getTime() <= now.getTime()) target.setUTCDate(target.getUTCDate() + 1);
  const seconds = Math.ceil((target.getTime() - now.getTime()) / 1000) + RESET_BUFFER_SECONDS;
  return seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

function looksRateLimited(message) {
  return /\b(429|too many requests|rate limit|usage limit|quota|session limit)\b/i.test(message || "");
}

// ---- codex backend (one `codex exec` process per turn) ----------------------

function makeCodexBackend() {
  let threadId = null;
  let turnChild = null;
  let turnTerminated = false;
  // Resolves when the previous turn's process has fully closed. A turn's session
  // file is only flushed to $CODEX_HOME on close, so the next `exec resume` must
  // wait for it or it resumes a half-written session and runs an empty turn.
  let prevClose = Promise.resolve();

  return {
    init() {
      fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8"); // fail fast if missing
      console.error(`[server] codex backend ready (model=${MODEL || "config default"})`);
    },
    async send(text, turnIndex) {
      // Wait for the previous turn's process to fully close (session flushed)
      // before resuming, otherwise resume loads a half-written session.
      await prevClose;

      // Prepend the system prompt on the first turn only; codex exec has no
      // --append-system-prompt, so it rides along in the first user message.
      let prompt = text;
      if (turnIndex === 0) {
        const sp = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
        prompt = `${sp}\n\n# User request\n${text}`;
      }

      const args = ["exec"];
      if (threadId) args.push("resume", threadId);
      args.push("--json", "--skip-git-repo-check");
      if (MODEL) args.push("-m", MODEL);
      if (!threadId) {
        // First turn: open the sandbox/approvals so codex can run its tools
        // unattended (the container is the real sandbox). resume inherits this.
        args.push("--dangerously-bypass-approvals-and-sandbox");
        if (EXTRA) args.push(...EXTRA.split(/\s+/));
      }
      args.push("-"); // read the prompt from stdin (avoids argv length limits)

      console.error(`[server] codex exec ${threadId ? `resume ${threadId}` : "(new session)"} turn=${turnIndex}`);
      const ch = spawn("codex", args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
      turnChild = ch;
      turnTerminated = false;
      attachStdout(ch, (ev) => {
        if (ev && ev.type === "thread.started" && typeof ev.thread_id === "string") threadId = ev.thread_id;
        if (ev && (ev.type === "turn.completed" || ev.type === "turn.failed")) turnTerminated = true;
      });
      attachStderr(ch, "codex");
      // Resolve prevClose on `close` (not `exit`): close fires only after stdout
      // has fully drained, so the real terminator line is parsed and the session
      // file is flushed before the next resume runs.
      prevClose = new Promise((resolve) => {
        ch.on("close", (code, signal) => {
          console.error(`[server] codex turn closed code=${code} signal=${signal}`);
          // If the process died without a terminating event, synthesize one so
          // recv resolves the turn as an error instead of hanging.
          if (!turnTerminated) {
            events.push({ type: "turn.failed", error: { message: `codex exited code=${code} signal=${signal}` } });
          }
          resolve();
        });
      });
      ch.on("error", (err) => {
        events.push({ type: "turn.failed", error: { message: `codex spawn error: ${err.message}` } });
      });
      ch.stdin.write(prompt);
      ch.stdin.end();
    },
    isTerminator(ev) { return !!ev && (ev.type === "turn.completed" || ev.type === "turn.failed"); },
    classify(turnSlice, termEv) {
      if (termEv.type === "turn.failed") {
        const message = (termEv.error && termEv.error.message) || "codex turn failed";
        if (looksRateLimited(message)) {
          return { kind: "rate_limited", rate_limit: { retry_after_seconds: secondsUntilReset(message), message } };
        }
        return { kind: "error", error: message };
      }
      const text = lastCodexAgentMessage(turnSlice);
      const reply = extractReply(text);
      if (!reply) return { kind: "malformed", error: `reply did not match envelope: ${(text || "").slice(0, 500)}` };
      return { kind: "reply", reply };
    },
    // Reasoning items + any preamble agent_messages (the last agent_message is
    // the envelope, so it is excluded).
    narrate(turnSlice, reply) {
      let lastAgentIdx = -1;
      for (let i = 0; i < turnSlice.length; i += 1) {
        const e = turnSlice[i];
        if (e && e.type === "item.completed" && e.item && e.item.type === "agent_message") lastAgentIdx = i;
      }
      const parts = [];
      for (let i = 0; i < turnSlice.length; i += 1) {
        const e = turnSlice[i];
        if (!e || e.type !== "item.completed" || !e.item) continue;
        const it = e.item;
        const itText = typeof it.text === "string" ? it.text : (typeof it.summary === "string" ? it.summary : "");
        if (it.type === "reasoning" && itText) parts.push(itText);
        else if (it.type === "agent_message" && itText && i !== lastAgentIdx) parts.push(stripEnvelopes(itText));
      }
      return boundNarration(dropFinalAnswer(parts.join("\n"), reply));
    },
    shutdown() { try { if (turnChild) turnChild.kill("SIGTERM"); } catch (_) {} },
    status() { return { thread_id: threadId }; },
  };
}

const backend = makeCodexBackend();
backend.init();

// ---- socket ops -------------------------------------------------------------

async function opSend({ input, operator_messages }) {
  let text = renderUserText(input);
  if (text === null) return { ok: false, error: "input must be { prompt } or { tool_results }" };
  if (!Array.isArray(operator_messages) ||
      operator_messages.some((message) => typeof message !== "string" || !message.trim())) {
    return { ok: false, error: "operator_messages must contain only non-empty strings" };
  }
  if (operator_messages.length > 0) {
    text += "\n\n" + operator_messages
      .map((message) => `[Operator message]: ${message.trim()}`)
      .join("\n\n");
  }
  try {
    turnStart = events.length; // a new turn's events accumulate from here
    await backend.send(text, turnCount);
    turnCount += 1;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Index of the event that terminates the current turn, or -1.
function findTerminator() {
  for (let i = turnStart; i < events.length; i += 1) {
    if (backend.isTerminator(events[i])) return i;
  }
  return -1;
}

async function opRecv({ timeout_ms }) {
  const timeout = Number.isFinite(timeout_ms) && timeout_ms > 0 ? timeout_ms : 30000;
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const hasNew = events.length > consumed;
    if (findTerminator() !== -1) break;
    if (hasNew && Date.now() - start > 500) break;
    await sleep(100);
  }

  const raw = events.slice(consumed);
  consumed = events.length;

  const idx = findTerminator();
  if (idx !== -1) {
    const termEv = events[idx];
    const turnSlice = events.slice(turnStart, idx + 1);
    turnStart = idx + 1; // next turn parses from a fresh window
    const c = backend.classify(turnSlice, termEv);
    if (c.kind === "rate_limited") return { ok: true, outcome: "rate_limited", rate_limit: c.rate_limit, raw };
    if (c.kind === "malformed") return { ok: true, outcome: "malformed", error: c.error, raw };
    if (c.kind === "error") return { ok: true, outcome: "error", error: c.error, raw };
    const narration = backend.narrate(turnSlice, c.reply);
    return { ok: true, outcome: "reply", reply: c.reply, narration, raw };
  }

  return { ok: true, outcome: "working", raw };
}

function opStatus() {
  return {
    ok: true,
    backend: "codex",
    model: MODEL || null,
    events_total: events.length,
    consumed,
    turn_count: turnCount,
    ...backend.status(),
  };
}

let shuttingDown = false;
async function opShutdown() {
  if (shuttingDown) return { ok: true };
  shuttingDown = true;
  backend.shutdown();
  setTimeout(() => process.exit(0), 200).unref();
  return { ok: true };
}

let lastActivityAt = Date.now();
async function dispatch(line) {
  lastActivityAt = Date.now();
  let cmd;
  try { cmd = JSON.parse(line); }
  catch (e) { return { ok: false, error: `bad json: ${e.message}` }; }
  switch (cmd.op) {
    case "send": return await opSend(cmd);
    case "recv": return await opRecv(cmd);
    case "status": return opStatus();
    case "shutdown": return await opShutdown();
    default: return { ok: false, error: `unknown op: ${cmd.op}` };
  }
}

const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  socket.on("error", () => {});
  let buf = "";
  socket.on("data", (chunk) => { buf += chunk; });
  socket.on("end", () => {
    const line = buf.trim();
    if (!line) { socket.destroy(); return; }
    dispatch(line)
      .then((res) => { if (!socket.destroyed) socket.end(JSON.stringify(res) + "\n"); })
      .catch((err) => { if (!socket.destroyed) socket.end(JSON.stringify({ ok: false, error: err.message }) + "\n"); });
  });
});

fs.mkdirSync(path.dirname(SOCKET_PATH), { recursive: true });
try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}

server.listen(SOCKET_PATH, () => {
  try { fs.chmodSync(SOCKET_PATH, 0o600); } catch (_) {}
  console.error(`[server] listening on ${SOCKET_PATH} (backend=codex)`);
});

// unref so the watchdog itself never keeps the process alive.
const idleWatch = setInterval(() => {
  if (shuttingDown) return;
  const idleMs = Date.now() - lastActivityAt;
  if (idleMs >= CONTAINER_IDLE_MS) {
    console.error(`[server] no op for ${idleMs}ms (limit ${CONTAINER_IDLE_MS}ms); self-terminating (orphan guard)`);
    opShutdown();
  }
}, 60000);
idleWatch.unref();

function shutdownAndExit(signal) {
  console.error(`[server] received ${signal}, shutting down`);
  opShutdown();
  server.close();
  try { fs.unlinkSync(SOCKET_PATH); } catch (_) {}
}
process.on("SIGTERM", () => shutdownAndExit("SIGTERM"));
process.on("SIGINT", () => shutdownAndExit("SIGINT"));
