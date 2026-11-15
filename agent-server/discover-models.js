import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

export async function discoverModels(timeoutMs = 45000) {
  const extra = (process.env.AGENT_EXTRA_ARGS || "").trim().split(/\s+/).filter(Boolean);
  const child = spawn("codex", ["app-server", ...extra], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(child, "close");
  const pending = new Map();
  let failure = null;
  let nextId = 0;
  function fail(error) {
    failure = error;
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code) => fail(new Error(`codex discovery process exited (${code})`)));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch (_) { return; }
    const id = message.id;
    const waiter = pending.get(id);
    if (waiter) {
      pending.delete(id);
      if (message.error) {
        waiter.reject(new Error(message.error?.message || "discovery request failed"));
      } else {
        waiter.resolve(message.result);
      }
    }
  });
  function request(method, params) {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const message = { id, method, params };
      child.stdin.write(JSON.stringify(message) + "\n");
    });
  }
  const timeout = setTimeout(() => {
    fail(new Error(`codex model discovery timed out`));
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    await request("initialize", { clientInfo: { name: "model-inventory", title: "Model inventory", version: "1" } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const models = [];
    let cursor = null;
    do {
      const page = await request("model/list", { limit: 100, includeHidden: false, cursor });
      if (!Array.isArray(page?.data)) throw new Error("Codex returned no model catalog");
      models.push(...page.data.filter((model) => !model.hidden));
      cursor = page.nextCursor;
    } while (cursor);
    if (models.length === 0) throw new Error(`codex returned an empty model catalog`);
    return models.map((model) => {
      const name = model.model;
      if (typeof name !== "string" || !name) throw new Error(`codex returned a model without an id`);
      return {
        id: `codex/${name}`,
        object: "model",
        owned_by: "codex",
        display_name: model.displayName || name,
        is_default: process.env.AGENT_MODEL ? name === process.env.AGENT_MODEL : !!model.isDefault,
        capabilities: model,
      };
    });
  } finally {
    clearTimeout(timeout);
    lines.close();
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
    try { await closed; } finally { clearTimeout(kill); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await discoverModels())); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
