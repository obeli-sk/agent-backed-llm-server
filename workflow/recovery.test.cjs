const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWorkflow } = require("./test-helpers.cjs");

const opening = { role: "user", content: "Inspect the project" };
const calls = [{ name: "bash", arguments_json: '{"script":"ls"}' }];
const messages = [
    { role: "system", content: "Test system" }, opening,
    { role: "assistant", content: "I’ll list files.", tool_calls: [{ id: "call_0", type: "function", function: { name: "bash", arguments: '{"script":"ls"}' } }] },
    { role: "tool", tool_call_id: "call_0", content: "README.md" },
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "Continue the work" },
];

async function driveLoop(system, inputs, replies, recovery = null) {
    const hashes = [];
    const sent = [];
    let turn = 0;
    const loop = await loadWorkflow("agent-loop.js", {
        "agent-backed-llm:agent/session": {
            send(socket, input) { sent.push(JSON.parse(JSON.stringify(input))); },
            recv() { return { reply: { reply: replies[turn++] } }; },
        },
        "agent-backed-llm:session-obelisk-ext/turn": {
            responseSubmit() { return "response"; },
            requestSubmit(set, id, hash) { hashes.push(hash); return "request"; },
        },
        "agent-backed-llm:session-obelisk-stub/turn": { responseStub() {} },
        "obelisk:workflow@1.0.0": {
            createJoinSet() {
                return {
                    lastId: "request",
                    submitDelay() { return "delay"; },
                    joinNext() {
                        if (turn === inputs.length) { this.lastId = "delay"; return null; }
                        return JSON.stringify(inputs[turn]);
                    },
                    close() {},
                };
            },
        },
    });
    loop("socket", system, inputs.length + 1, recovery);
    return { hashes, sent };
}

async function fixture(mode) {
    const scheduled = [];
    const deliveries = [];
    let hash;
    let warming = true;
    let old = mode !== "missing";
    const requestId = "E_old.loop.request";
    const responseId = "E_old.loop.response";
    let race = mode === "race";
    const handle = await loadWorkflow("../webhook/chat.js", {
        "obelisk:webhook@1.0.0": {
            executionIdGenerate() { return warming ? "E_warm" : "E_new"; },
            executionIdCurrent() { return "E_http"; },
            get(id) {
                if (id === requestId) {
                    if (mode === "tool-idle") throw { value: "execution_failed" };
                    return JSON.stringify({ prompt: mode === "new-after-stop" ? "Previous request" : "Continue the work" });
                }
                if (id === responseId) {
                    if (mode === "idle" || mode === "tool-idle" || mode === "race" || mode === "recovery-expired") throw { value: { permanent_error: "session idle timeout" } };
                    if (mode === "error") throw { value: { permanent_error: "Unsupported model" } };
                    if (mode === "stopped" || mode === "new-after-stop") throw { value: "execution_failed" };
                    return JSON.stringify({ final: "Cached answer" });
                }
                if (!warming && mode === "recovery-expired") throw { value: { permanent_error: "session idle timeout" } };
                return JSON.stringify({ final: warming ? "Earlier answer" : "Recovered answer" });
            },
            getStatus() { return { finishedStatus: mode.includes("stop") ? "executionFailure" : "err" }; },
        },
        "obelisk:webhook-dynamic@1.0.0": { schedule(id, ffqn, params) { scheduled.push({ id, ffqn, params }); } },
    }, {
        Response,
        process: { env: { OBELISK_API_TOKEN: "test" } },
        fetch: async (url, options) => {
            const parsed = new URL(url);
            if (options.method === "PUT") {
                if (old && race) { race = false; return new Response("already cancelled", { status: 409 }); }
                deliveries.push(JSON.parse(options.body).ok);
                return Response.json(null);
            }
            if (parsed.pathname.endsWith("/events")) {
                if (mode === "params-error" && !warming) return new Response("API unavailable", { status: 503 });
                return Response.json({ events: [{ event: { created: { params: [old && !warming ? responseId : "response-new", hash] } } }] });
            }
            if (parsed.searchParams.has("execution_id_prefix")) {
                old = false;
                return Response.json([{ execution_id: "E_new.loop.request" }]);
            }
            if (mode === "lookup-error" && !warming) return new Response("API unavailable", { status: 503 });
            const pending = parsed.searchParams.has("hide_finished");
            return Response.json(old && (!pending || mode === "race" || mode === "live") ? [{ execution_id: requestId }] : []);
        },
    });
    const request = (history) => handle({ method: "POST", text: async () => JSON.stringify({ model: "codex/model", messages: history }) });
    await request(messages.slice(0, 2));
    const system = scheduled[0].params[1];
    const warm = await driveLoop(system,
        [{ prompt: opening.content }, { tool_results: [{ name: "bash", outcome: { ok: "README.md" } }] }],
        [{ tool_calls: calls }, { final: "Earlier answer" }]);
    hash = mode === "tool-idle" ? warm.hashes[1] : warm.hashes.at(-1);
    warming = false;
    old = mode !== "missing";
    scheduled.length = 0;
    deliveries.length = 0;
    return { request, scheduled, deliveries, system, hash };
}

for (const mode of ["idle", "missing", "race", "new-after-stop"]) {
    test(`HTTP continuation restores full history for ${mode}`, async () => {
        const f = await fixture(mode);
        const response = await f.request(messages);
        assert.equal(response.status, 200);
        assert.equal((await response.json()).choices[0].message.content, "Recovered answer");
        assert.equal(response.headers.get("x-obelisk-execution-id"), "E_new");
        assert.equal(f.scheduled.length, 1);
        const params = f.scheduled[0].params;
        assert.equal(params[0], "codex");
        assert.equal(params[3], "model");
        const recovery = JSON.parse(params[4]);
        assert.deepEqual(recovery.messages, messages);
        assert.equal(recovery.prefix_hash, f.hash);
        assert.deepEqual(JSON.parse(f.deliveries[0]), { prompt: "Continue the work" });
        const restored = await driveLoop(f.system,
            [{ prompt: "Continue the work" }, { prompt: "Next message" }],
            [{ final: "Recovered answer" }, { final: "Next answer" }], params[4]);
        assert.deepEqual(JSON.parse(restored.sent[0].prompt.split("\n\n")[1]), messages);
        assert.deepEqual(restored.sent[1], { prompt: "Next message" });
        const normal = await driveLoop(f.system,
            [{ prompt: opening.content }, { tool_results: [{ name: "bash", outcome: { ok: "README.md" } }] }, { prompt: "Continue the work" }, { prompt: "Next message" }],
            [{ tool_calls: calls }, { final: "Earlier answer" }, { final: "Recovered answer" }, { final: "Next answer" }]);
        assert.equal(restored.hashes.at(-1), normal.hashes.at(-1));
    });
}

test("recovery after a tool call retains tool IDs, arguments, and the latest result", async () => {
    const f = await fixture("tool-idle");
    const history = messages.slice(0, 4);
    const response = await f.request(history);
    assert.equal(response.status, 200);
    const recovery = f.scheduled[0].params[4];
    assert.deepEqual(JSON.parse(recovery).messages, history);
    const delta = JSON.parse(f.deliveries[0]);
    assert.deepEqual(delta, { tool_results: [{ name: "bash", outcome: { ok: "README.md" } }] });
    const restored = await driveLoop(f.system, [delta], [{ final: "Recovered answer" }], recovery);
    assert.deepEqual(JSON.parse(restored.sent[0].prompt.split("\n\n")[1]), history);
    const normal = await driveLoop(f.system, [{ prompt: opening.content }, delta], [{ tool_calls: calls }, { final: "Recovered answer" }]);
    assert.equal(restored.hashes.at(-1), normal.hashes.at(-1));
});

for (const [mode, status] of [["live", 200], ["cached", 200], ["stopped", 409], ["error", 502], ["lookup-error", 502], ["params-error", 502]]) {
    test(`HTTP continuation retains ${mode} outcome without restarting`, async () => {
        const f = await fixture(mode);
        const response = await f.request(messages);
        assert.equal(response.status, status);
        const body = await response.json();
        if (status === 200) assert.equal(body.choices[0].message.content, "Cached answer");
        else assert.match(body.error.message, mode === "stopped" ? /stopped/ : mode.endsWith("-error") ? /API unavailable/ : /Unsupported model/);
        assert.equal(f.scheduled.length, 0);
        assert.equal(f.deliveries.length, mode === "live" ? 1 : 0);
    });
}

test("an expired replacement session does not cause repeated restarts", async () => {
    const f = await fixture("recovery-expired");
    const response = await f.request(messages);
    assert.equal(response.status, 502);
    assert.equal(f.scheduled.length, 1);
    assert.equal(response.headers.get("x-obelisk-execution-id"), "E_new");
});
