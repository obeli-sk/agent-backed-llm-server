#!/usr/bin/env bash
set -euo pipefail

# entrypoint.sh socket-path
#
# Auth: Codex reads credentials from its host config dir, bind-mounted by
# the start activity. No API key is required (subscription/ChatGPT login).
#
# Optional env:
#   AGENT_MODEL                 model id (empty => backend/config default)
#   AGENT_WORKDIR               cwd for the LLM CLI, default /tmp/work
#   AGENT_EXTRA_ARGS            extra args appended to the CLI invocation
#   AGENT_CONTAINER_IDLE_MS     orphan guard: self-exit after this many ms with
#                               no op (default 45m; keep above the workflow idle)
#   AGENT_SYSTEM_PROMPT_PATH    deployment-provided prompt file
#   AGENT_HOST_CODEX_DIR        codex config mount (default /host-codex)

SOCKET_PATH="${1:?socket path is required}"
export CODEX_HOME="${AGENT_HOST_CODEX_DIR:-/host-codex}"

mkdir -p "${AGENT_WORKDIR:-/tmp/work}"
cd "${AGENT_WORKDIR:-/tmp/work}"

if [ "$SOCKET_PATH" = "discover-models" ]; then
  exec node /app/discover-models.js
fi

exec node /app/server.js "$SOCKET_PATH"
