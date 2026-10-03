#!/usr/bin/env bash
set -euo pipefail

# entrypoint.sh socket-path
#
# Auth: each backend reads credentials from its host config dir, bind-mounted by
# the start activity. No API key is required (subscription/ChatGPT login).
#
# Optional env:
#   AGENT_BACKEND               "claude" (default) or "codex"
#   AGENT_MODEL                 model id (empty => backend/config default)
#   AGENT_WORKDIR               cwd for the LLM CLI, default /tmp/work
#   AGENT_EXTRA_ARGS            extra args appended to the CLI invocation
#   AGENT_CONTAINER_IDLE_MS     orphan guard: self-exit after this many ms with
#                               no op (default 45m; keep above the workflow idle)
#   AGENT_SYSTEM_PROMPT_PATH    deployment-provided prompt file
#   AGENT_HOST_CLAUDE_DIR       claude config mount (default /host-claude)
#   AGENT_HOST_CODEX_DIR        codex config mount (default /host-codex)

SOCKET_PATH="${1:?socket path is required}"
BACKEND="${AGENT_BACKEND:-claude}"

if [ "$BACKEND" = "codex" ]; then
  # codex reads auth.json + config.toml (and writes sessions) under CODEX_HOME.
  # Point it straight at the bind-mounted host ~/.codex.
  export CODEX_HOME="${AGENT_HOST_CODEX_DIR:-/host-codex}"
  echo "[entrypoint] codex backend, CODEX_HOME=$CODEX_HOME" >&2
else
  # Build a minimal CLAUDE_CONFIG_DIR with only the auth files we want. The host
  # ~/.claude usually contains plugins, skills, agents, and marketplaces that
  # register synthetic tools - those get sent to the Anthropic API and reject
  # the request with malformed input_schema errors.
  HOST_DIR="${AGENT_HOST_CLAUDE_DIR:-/host-claude}"
  CONFIG_DIR=/tmp/claude-config
  mkdir -p "$CONFIG_DIR"
  for f in .credentials.json .claude.json; do
    if [ -e "$HOST_DIR/$f" ]; then
      ln -sfn "$HOST_DIR/$f" "$CONFIG_DIR/$f"
    fi
  done
  export CLAUDE_CONFIG_DIR="$CONFIG_DIR"
fi

mkdir -p "${AGENT_WORKDIR:-/tmp/work}"
cd "${AGENT_WORKDIR:-/tmp/work}"

if [ "$SOCKET_PATH" = "discover-models" ]; then
  exec node /app/discover-models.js
fi

exec node /app/server.js "$SOCKET_PATH"
