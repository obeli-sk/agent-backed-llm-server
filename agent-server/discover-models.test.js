import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverModels } from "./discover-models.js";

test("discovery reads the Codex catalog without starting an inference turn", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "model-discovery-"));
  const originalPath = process.env.PATH;
  const originalModel = process.env.AGENT_MODEL;
  const originalExtra = process.env.AGENT_EXTRA_ARGS;
  const fixture = `#!/usr/bin/env node
const { createInterface } = require("node:readline");
const fs = require("node:fs");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  fs.appendFileSync(process.argv[1] + ".requests", line + "\\n");
  const message = JSON.parse(line);
  if (message.method === "initialize") console.log(JSON.stringify({ id: message.id, result: {} }));
  if (message.method === "model/list") {
    const second = message.params.cursor === "page-two";
    console.log(JSON.stringify({ id: message.id, result: {
      data: [{ model: second ? "second-model" : "first-model", displayName: "Codex model", isDefault: !second }, { model: "hidden-model", hidden: true }],
      nextCursor: second ? null : "page-two"
    } }));
  }
});
`;
  try {
    await fs.writeFile(path.join(directory, "codex"), fixture, { mode: 0o755 });
    process.env.PATH = `${directory}${path.delimiter}${originalPath}`;
    process.env.AGENT_EXTRA_ARGS = "";
    process.env.AGENT_MODEL = "second-model";
    const codex = await discoverModels(2000);
    assert.deepEqual(codex.map((model) => model.id), ["codex/first-model", "codex/second-model"]);
    assert.deepEqual(codex.map((model) => model.is_default), [false, true]);
    const requests = (await fs.readFile(path.join(directory, "codex.requests"), "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(requests.every((message) => ["initialize", "initialized", "model/list"].includes(message.method)));
    await fs.writeFile(path.join(directory, "codex"), "#!/usr/bin/env node\nprocess.stdin.resume();\n", { mode: 0o755 });
    await assert.rejects(discoverModels(100), /timed out/);
  } finally {
    process.env.PATH = originalPath;
    if (originalModel === undefined) delete process.env.AGENT_MODEL; else process.env.AGENT_MODEL = originalModel;
    if (originalExtra === undefined) delete process.env.AGENT_EXTRA_ARGS; else process.env.AGENT_EXTRA_ARGS = originalExtra;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
