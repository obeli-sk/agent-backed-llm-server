const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadWorkflow } = require("./test-helpers.cjs");

test("refresh reports Codex discovery success and failure", async () => {
    for (const failed of [false, true]) {
        const refresh = await loadWorkflow("refresh-model-inventory.js", {
            "agent-backed-llm:models/codex": { discoverModels() {
                if (failed) throw { value: "credentials expired" };
                return JSON.stringify({ discovered_at: "2026-10-03T20:00:00Z", models: [{ id: "codex/example" }] });
            } },
        });
        const [result] = JSON.parse(refresh());
        assert.equal(result.backend, "codex");
        assert.equal(result.status, failed ? "unavailable" : "ready");
        if (failed) assert.equal(result.error, "credentials expired");
        else assert.equal(result.model_count, 1);
    }
});

test("models endpoint preserves the last good inventory after a failed refresh", async () => {
    const handle = await loadWorkflow("../webhook/models.js", {}, {
        Response,
        process: { env: { OBELISK_API_URL: "http://127.0.0.1:5105", OBELISK_API_TOKEN: "test" } },
        fetch: async (url, options) => {
            assert.equal(options.headers.authorization, "Bearer test");
            const parsed = new URL(url);
            if (parsed.pathname === "/v1/executions") {
                assert.ok(parsed.searchParams.get("ffqn_prefix").includes("/codex."));
                const successful = parsed.searchParams.get("state") === "finished_ok";
                const id = !successful ? "codex-failed" : "codex-ok";
                return Response.json([{ execution_id: id, created_at: "2026-10-03T20:00:00Z" }]);
            }
            if (url.endsWith("codex-failed")) return Response.json({ err: "credentials expired" });
            const backend = "codex";
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
    assert.equal(body.data.length, 1);
    assert.equal(body.backends.codex.status, "stale");
    assert.equal(body.backends.codex.error, "credentials expired");
    assert.deepEqual(Object.keys(body.backends), ["codex"]);
    assert.equal(body.data[0].created, Date.parse("2026-10-03T19:00:00Z") / 1000);
});

test("models endpoint reports pending discovery when no inventory exists", async () => {
    const handle = await loadWorkflow("../webhook/models.js", {}, {
        Response, process: { env: { OBELISK_API_URL: "http://127.0.0.1:5105", OBELISK_API_TOKEN: "test" } },
        fetch: async () => Response.json([]),
    });
    const response = await handle({ method: "GET" });
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).data, []);
});
