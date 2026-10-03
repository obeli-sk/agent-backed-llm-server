const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWorkflow } = require("./test-helpers.cjs");

test("refresh submits both backend probes before awaiting and isolates their failures", async () => {
    const submitted = [];
    const closed = [];
    const refresh = await loadWorkflow("refresh-model-inventory.js", {
        "agent-backed-llm:models-obelisk-ext/claude": { discoverModelsSubmit() { submitted.push("claude"); } },
        "agent-backed-llm:models-obelisk-ext/codex": { discoverModelsSubmit() { submitted.push("codex"); } },
        "obelisk:workflow@1.0.0": {
            createJoinSet({ name }) {
                return {
                    joinNext() {
                        assert.deepEqual(submitted, ["claude", "codex"]);
                        if (name === "claude") throw { value: "credentials expired" };
                        return JSON.stringify({ discovered_at: "2026-10-03T20:00:00Z", models: [{ id: "codex/example" }] });
                    },
                    close() { closed.push(name); },
                };
            },
        },
    });
    const results = JSON.parse(refresh());
    assert.equal(results[0].error, "credentials expired");
    assert.equal(results[1].model_count, 1);
    assert.deepEqual(closed, ["claude", "codex"]);
});

test("models endpoint preserves the last good inventory after a failed refresh", async () => {
    const handle = await loadWorkflow("../webhook/models.js", {}, {
        Response,
        process: { env: { OBELISK_API_TOKEN: "test" } },
        fetch: async (url, options) => {
            assert.equal(options.headers.authorization, "Bearer test");
            const parsed = new URL(url);
            if (parsed.pathname === "/v1/executions") {
                const backend = parsed.searchParams.get("ffqn_prefix").includes("/claude.") ? "claude" : "codex";
                const successful = parsed.searchParams.get("state") === "finished_ok";
                const id = backend === "claude" && !successful ? "claude-failed" : backend + "-ok";
                return Response.json([{ execution_id: id, created_at: "2026-10-03T20:00:00Z" }]);
            }
            if (url.endsWith("claude-failed")) return Response.json({ err: "credentials expired" });
            const backend = url.endsWith("claude-ok") ? "claude" : "codex";
            return Response.json({ ok: JSON.stringify({
                backend, image: "test-image", discovered_at: "2026-10-03T19:00:00Z",
                models: [{ id: `${backend}/discovered`, object: "model", owned_by: backend }],
            }) });
        },
    });
    const response = await handle({ method: "GET" });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.object, "list");
    assert.equal(body.data.length, 2);
    assert.equal(body.backends.claude.status, "stale");
    assert.equal(body.backends.claude.error, "credentials expired");
    assert.equal(body.backends.codex.status, "ready");
    assert.equal(body.data[0].created, Date.parse("2026-10-03T19:00:00Z") / 1000);
});

test("models endpoint reports pending discovery when no inventory exists", async () => {
    const handle = await loadWorkflow("../webhook/models.js", {}, {
        Response, process: { env: { OBELISK_API_TOKEN: "test" } },
        fetch: async () => Response.json([]),
    });
    const response = await handle({ method: "GET" });
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).data, []);
});
