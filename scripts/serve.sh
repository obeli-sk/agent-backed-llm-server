#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export OBELISK_API_TOKEN="${OBELISK_API_TOKEN:-$(basename "$PWD")}"
api_url="${OBELISK_API_URL:-http://127.0.0.1:5105}"
api_url="${api_url%/}"
startup_timeout="${MODEL_DISCOVERY_STARTUP_TIMEOUT_SECONDS:-90}"

server_pid=""
stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
}
trap stop_server EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

obelisk server run -s server.toml -a app.toml -d deployment.toml "$@" &
server_pid=$!
deadline=$((SECONDS + startup_timeout))
ready=false
while kill -0 "$server_pid" 2>/dev/null; do
  if curl --silent --fail --max-time 2 \
    -H "Authorization: Bearer $OBELISK_API_TOKEN" \
    "$api_url/v1/deployment-id" >/dev/null; then
    ready=true
    break
  fi
  if (( SECONDS >= deadline )); then
    echo "Timed out waiting for Obelisk before model discovery" >&2
    exit 1
  fi
  sleep 1
done

if [[ "$ready" = false ]]; then
  wait "$server_pid"
  exit 1
fi

execution=$(curl --silent --show-error --fail --max-time 10 \
  -H "Authorization: Bearer $OBELISK_API_TOKEN" \
  -H 'Content-Type: application/json' -H 'Accept: application/json' \
  -d '{"ffqn":"agent-backed-llm:models/workflow.refresh-model-inventory","params":[]}' \
  "$api_url/v1/executions" | jq -er '.ok | strings')
echo "Startup model discovery submitted: $execution" >&2

wait "$server_pid"
