const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWorkflow } = require("./test-helpers.cjs");

class ChildError extends Error {
    constructor(value) {
        super("child execution failed");
        this.value = value;
    }
}

test("receive errors retain their variant in the response stub and workflow", async () => {
    const message = "The requested model is not supported with this account.";
    const responses = [];
    const closed = [];
    const loop = await loadWorkflow("agent-loop.js", {
        "agent-backed-llm:agent/session": {
            send() {},
            recv() { throw new ChildError({ permanent_error: message }); },
        },
        "agent-backed-llm:session-obelisk-ext/turn": {
            responseSubmit() { return "response-id"; },
            requestSubmit() { return "request-id"; },
        },
        "agent-backed-llm:session-obelisk-stub/turn": {
            responseStub(id, result) { responses.push({ id, result }); },
        },
        "obelisk:workflow@1.0.0": {
            createJoinSet({ name }) {
                return {
                    lastId: "request-id",
                    submitDelay() { return "delay-id"; },
                    joinNext() { return JSON.stringify({ prompt: "hello" }); },
                    close() { closed.push(name); },
                };
            },
        },
    });
    assert.throws(() => loop("socket", "system prompt", 1), (error) => error.permanent_error === message);
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, "response-id");
    assert.equal(responses[0].result.err.permanent_error, message);
    assert.deepEqual(closed, ["request-0", "response-0"]);
});

test("session preserves typed child errors after cleaning up the container", async () => {
    const message = "The requested model is not supported with this account.";
    let cleanedUp = false;
    const start = () => ({ container: "test-container", image: "test-image" });
    const session = await loadWorkflow("session.js", {
        "agent-backed-llm:agent/claude": { start },
        "agent-backed-llm:agent/codex": { start },
        "agent-backed-llm:agent/session": { cleanup() { cleanedUp = true; } },
        "agent-backed-llm:session/loop": {
            agentLoopCancellable() { throw new ChildError({ permanent_agent_exited: message }); },
        },
        "obelisk:workflow@1.0.0": { executionIdCurrent() { return "E_test"; } },
    });
    assert.throws(() => session("codex", "system prompt", 1, "model"), (error) => error.permanent_agent_exited === message);
    assert.equal(cleanedUp, true);
});

test("platform failures retain execution-failed when cleanup also fails", async () => {
    let cleanedUp = false;
    const start = () => ({ container: "test-container", image: "test-image" });
    const session = await loadWorkflow("session.js", {
        "agent-backed-llm:agent/claude": { start },
        "agent-backed-llm:agent/codex": { start },
        "agent-backed-llm:agent/session": {
            cleanup() {
                cleanedUp = true;
                throw new ChildError("cleanup failed");
            },
        },
        "agent-backed-llm:session/loop": {
            agentLoopCancellable() { throw new ChildError("execution_failed"); },
        },
        "obelisk:workflow@1.0.0": { executionIdCurrent() { return "E_test"; } },
    });
    assert.throws(() => session("codex", "system prompt", 1, "model"), (error) => error === "execution_failed");
    assert.equal(cleanedUp, true);
});

test("startup and cleanup failures are mapped to distinct variants", async () => {
    for (const stage of ["start", "cleanup"]) {
        let cleanedUp = false;
        const start = () => {
            if (stage === "start") throw new ChildError("container could not start");
            return { container: "test-container", image: "test-image" };
        };
        const session = await loadWorkflow("session.js", {
            "agent-backed-llm:agent/claude": { start },
            "agent-backed-llm:agent/codex": { start },
            "agent-backed-llm:agent/session": {
                cleanup() {
                    cleanedUp = true;
                    if (stage === "cleanup") throw new ChildError("container could not stop");
                },
            },
            "agent-backed-llm:session/loop": { agentLoopCancellable() { return "session ended"; } },
            "obelisk:workflow@1.0.0": { executionIdCurrent() { return "E_test"; } },
        });
        const kind = stage === "start" ? "permanent_start_failed" : "permanent_cleanup_failed";
        const message = stage === "start" ? "container could not start" : "container could not stop";
        assert.throws(() => session("codex", "system prompt", 1, "model"), (error) => error[kind] === message);
        assert.equal(cleanedUp, true);
    }
});

test("HTTP boundary renders the typed error message and includes the session id", async () => {
    const message = "The requested model is not supported with this account.";
    const handle = await loadWorkflow("../webhook/chat.js", {
        "obelisk:webhook@1.0.0": {
            executionIdGenerate() { return "E_test"; },
            get() { throw new ChildError({ permanent_error: message }); },
            getStatus() { return { finishedStatus: "err" }; },
        },
        "obelisk:webhook-dynamic@1.0.0": { schedule() {} },
    }, {
        Response,
        process: { env: { OBELISK_API_TOKEN: "test" } },
        fetch: async (url, options) => {
            if (options.method === "PUT") return new Response("null");
            if (url.includes("/events?")) {
                return Response.json({ events: [{ event: { created: { params: ["response-id", "hash"] } } }] });
            }
            return Response.json([{ execution_id: "request-id" }]);
        },
    });
    const response = await handle({ method: "POST", text: async () => JSON.stringify({ messages: [{ role: "user", content: "hello" }] }) });
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("x-obelisk-execution-id"), "E_test");
    assert.equal((await response.json()).error.message, `session ended without a reply: ${message}`);
});
