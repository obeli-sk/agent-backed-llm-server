const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("startup waits for readiness, submits discovery, and forwards termination to the server", { timeout: 10000 }, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "model-inventory-startup-"));
    const logPath = path.join(directory, "requests.jsonl");
    const stopPath = path.join(directory, "stopped");
    await fs.writeFile(path.join(directory, "obelisk"), `#!/usr/bin/env node
const fs = require("node:fs");
process.on("SIGTERM", () => { fs.writeFileSync(process.env.TEST_STOP_PATH, "stopped"); process.exit(0); });
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    await fs.writeFile(path.join(directory, "curl"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const previous = fs.existsSync(process.env.TEST_LOG_PATH) ? fs.readFileSync(process.env.TEST_LOG_PATH, "utf8") : "";
fs.appendFileSync(process.env.TEST_LOG_PATH, JSON.stringify(args) + "\\n");
if (!args.includes("-d")) process.exit(previous ? 0 : 22);
process.stdout.write(JSON.stringify({ ok: "E_discovery" }));
`, { mode: 0o755 });
    const launcher = spawn("bash", [path.join(__dirname, "serve.sh")], {
        env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, OBELISK_API_TOKEN: "test-token", TEST_LOG_PATH: logPath, TEST_STOP_PATH: stopPath },
        stdio: ["ignore", "ignore", "pipe"],
    });
    const closed = once(launcher, "close");
    try {
        await new Promise((resolve, reject) => {
            launcher.on("error", reject);
            launcher.on("exit", (code) => reject(new Error(`launcher exited early (${code})`)));
            launcher.stderr.on("data", (chunk) => {
                if (chunk.toString().includes("Startup model discovery submitted: E_discovery")) resolve();
            });
        });
        const calls = (await fs.readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(calls.length, 3);
        assert.ok(calls[0].at(-1).endsWith("/v1/deployment-id"));
        assert.ok(calls[1].at(-1).endsWith("/v1/deployment-id"));
        const submission = calls[2];
        assert.ok(submission.includes("Authorization: Bearer test-token"));
        assert.deepEqual(JSON.parse(submission[submission.indexOf("-d") + 1]), {
            ffqn: "agent-backed-llm:models/workflow.refresh-model-inventory", params: [],
        });
        launcher.kill("SIGTERM");
        const [code] = await closed;
        assert.equal(code, 143);
        assert.equal(await fs.readFile(stopPath, "utf8"), "stopped");
    } finally {
        launcher.kill("SIGTERM");
        await closed;
        await fs.rm(directory, { recursive: true, force: true });
    }
});
