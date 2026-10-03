#!/usr/bin/env node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const backend = process.env.AGENT_BACKEND;
const image = process.env.AGENT_IMAGE || "docker.io/getobelisk/agent-backed-llm-server:latest";
const container = `model-inventory-${backend}-${randomUUID()}`;

try {
  const auth = {
    claude: { directory: process.env.AGENT_HOST_CLAUDE_DIR || `${process.env.HOME}/.claude`, mount: "/host-claude", variable: "AGENT_HOST_CLAUDE_DIR" },
    codex: { directory: process.env.AGENT_HOST_CODEX_DIR || `${process.env.HOME}/.codex`, mount: "/host-codex", variable: "AGENT_HOST_CODEX_DIR" },
  }[backend];
  if (!auth) throw new Error(`unknown backend: ${backend}`);
  if (!fs.existsSync(auth.directory)) throw new Error(`${backend} credentials directory does not exist`);
  const result = spawnSync("docker", [
    "run", "--rm", "--name", container,
    "--user", `${process.getuid()}:${process.getgid()}`,
    "--mount", `type=bind,src=${auth.directory},dst=${auth.mount}`,
    "-e", `${auth.variable}=${auth.mount}`,
    "-e", `AGENT_BACKEND=${backend}`,
    "-e", `AGENT_MODEL=${process.env.AGENT_MODEL || ""}`,
    "-e", `AGENT_EXTRA_ARGS=${process.env.AGENT_EXTRA_ARGS || ""}`,
    image, "discover-models",
  ], { encoding: "utf8", timeout: 60000, maxBuffer: 1048576 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `discovery container exited (${result.status})`);
  const models = JSON.parse(result.stdout);
  if (!Array.isArray(models) || models.length === 0) throw new Error("discovery returned an empty model catalog");
  process.stdout.write(JSON.stringify(JSON.stringify({ backend, image, discovered_at: new Date().toISOString(), models })));
} catch (error) {
  console.error(error.message);
  process.stdout.write(JSON.stringify(error.message));
  process.exitCode = 1;
} finally {
  const cleanup = spawnSync("docker", ["rm", "-f", container], { encoding: "utf8", timeout: 10000 });
  if (cleanup.error || (cleanup.status !== 0 && !cleanup.stderr.includes("No such container"))) {
    console.error(`Discovery cleanup failed: ${cleanup.error?.message || cleanup.stderr.trim()}`);
  }
}
