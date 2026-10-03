const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("discovery activity mounts credentials, returns a typed JSON string, and cleans up failed probes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "model-inventory-activity-"));
    const logPath = path.join(directory, "docker.jsonl");
    await fs.writeFile(path.join(directory, "docker"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_LOG_PATH, JSON.stringify(args) + "\\n");
if (args[0] === "run") {
  if (process.env.TEST_FAIL) { console.error("probe failed"); process.exit(1); }
  process.stdout.write(JSON.stringify([{ id: "codex/discovered-model" }]));
}
`, { mode: 0o755 });
    try {
        for (const failed of [false, true]) {
            await fs.writeFile(logPath, "");
            const result = spawnSync(process.execPath, [path.join(__dirname, "../activity/discover-models.js")], {
                encoding: "utf8",
                env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, AGENT_BACKEND: "codex", AGENT_IMAGE: "test-image", AGENT_HOST_CODEX_DIR: directory, TEST_LOG_PATH: logPath, TEST_FAIL: failed ? "1" : "" },
            });
            assert.equal(result.status, failed ? 1 : 0);
            const payload = JSON.parse(result.stdout);
            assert.equal(typeof payload, "string");
            if (failed) assert.match(payload, /probe failed/);
            else assert.equal(JSON.parse(payload).models[0].id, "codex/discovered-model");
            const commands = (await fs.readFile(logPath, "utf8")).trim().split("\n").map(JSON.parse);
            assert.ok(commands[0].includes(`type=bind,src=${directory},dst=/host-codex`));
            assert.deepEqual(commands[0].slice(-2), ["test-image", "discover-models"]);
            assert.deepEqual(commands[1].slice(0, 2), ["rm", "-f"]);
            assert.equal(commands[1][2], commands[0][commands[0].indexOf("--name") + 1]);
        }
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
