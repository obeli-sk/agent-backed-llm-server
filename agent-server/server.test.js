import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function request(socketPath, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("socket request timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.end(JSON.stringify(command)));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("end", () => {
      try { resolve(JSON.parse(response)); }
      catch (error) { reject(error); }
    });
  });
}

test("Codex resume preserves the configured model over the CLI default", { timeout: 15000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-resume-model-"));
  const socketPath = path.join(directory, "agent.sock");
  const promptPath = path.join(directory, "prompt.txt");
  const argumentsPath = path.join(directory, "arguments.jsonl");
  await fs.writeFile(promptPath, "Return a final reply.");
  await fs.writeFile(path.join(directory, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_ARGUMENTS_PATH, JSON.stringify(args) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "test-thread" }));
  const modelIndex = args.indexOf("-m");
  const model = modelIndex < 0 ? "unsupported-default" : args[modelIndex + 1];
  if (model !== "gpt-5.5") {
    console.log(JSON.stringify({ type: "turn.failed", error: { message: "unsupported model" } }));
  } else {
    console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"final":"ok"}' } }));
    console.log(JSON.stringify({ type: "turn.completed" }));
  }
});
`, { mode: 0o755 });
  const server = spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname, socketPath], {
    env: {
      ...process.env,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
      AGENT_BACKEND: "codex",
      AGENT_MODEL: "gpt-5.5",
      AGENT_EXTRA_ARGS: "",
      AGENT_SYSTEM_PROMPT_PATH: promptPath,
      TEST_ARGUMENTS_PATH: argumentsPath,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const closed = once(server, "close");
  try {
    await new Promise((resolve, reject) => {
      server.on("error", reject);
      server.on("exit", (code) => reject(new Error(`server exited: ${code}`)));
      server.stderr.on("data", (chunk) => {
        if (chunk.toString().includes("[server] listening")) resolve();
      });
    });
    for (const prompt of ["first", "second"]) {
      assert.deepEqual(await request(socketPath, { op: "send", input: { prompt }, operator_messages: [] }), { ok: true });
      const reply = await request(socketPath, { op: "recv", timeout_ms: 3000 });
      assert.equal(reply.outcome, "reply");
      assert.deepEqual(reply.reply, { final: "ok" });
    }
    const calls = (await fs.readFile(argumentsPath, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].slice(0, 3), ["exec", "resume", "test-thread"]);
  } finally {
    server.kill("SIGTERM");
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
