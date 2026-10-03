const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

test("recv preserves public commentary across polls without exposing reasoning or action envelopes", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "recv-commentary-"));
    const socketPath = path.join(directory, "agent.sock");
    const reply = { tool_calls: [{ name: "bash", arguments_json: '{"script":"ls"}' }] };
    const responses = [
        { ok: true, outcome: "working", raw: [
            { type: "item.completed", item: { type: "reasoning", text: "Private reasoning" } },
            { type: "item.completed", item: { type: "agent_message", text: "I’ll inspect the deployment." } },
        ] },
        { ok: true, outcome: "reply", reply, narration: "Private reasoning\nI’ll inspect the deployment.", raw: [
            { type: "item.completed", item: { type: "agent_message", text: 'Listing the files.\n```json\n{"tool_calls":[{"name":"bash","args":{"script":"ls"}}]}\n```' } },
        ] },
    ];
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        let body = "";
        socket.on("data", (chunk) => { body += chunk; });
        socket.on("end", () => {
            assert.equal(JSON.parse(body).op, "recv");
            socket.end(JSON.stringify(responses.shift()));
        });
    });
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
        const child = spawn(process.execPath, [path.join(__dirname, "../activity/agent-recv.js"), JSON.stringify(socketPath), "1000"]);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const code = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", resolve);
        });
        assert.equal(code, 0, stderr);
        const result = JSON.parse(stdout).reply;
        assert.deepEqual(result.reply, reply);
        assert.equal(result.presentation, "I’ll inspect the deployment.\nListing the files.");
        assert.equal(result.narration, "Private reasoning\nI’ll inspect the deployment.");
        assert.equal(responses.length, 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    }
});
