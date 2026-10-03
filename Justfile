image := "docker.io/getobelisk/agent-backed-llm-server:latest"
api_url := "http://127.0.0.1:5105"          # server.toml moves the API off the default 5005

build:
  docker build -t {{image}} agent-server

verify:
  obelisk server verify -s server.toml -a app.toml -d deployment.toml

fix:
  obelisk server verify --fix -s server.toml -a app.toml -d deployment.toml

serve:
  bash scripts/serve.sh

refresh-models:
  #!/usr/bin/env bash
  set -euo pipefail
  curl --fail-with-body -sS -H "Authorization: Bearer ${OBELISK_API_TOKEN:-agent-backed-llm-server}" -H 'Content-Type: application/json' -d '{"ffqn":"agent-backed-llm:models/workflow.refresh-model-inventory","params":[]}' "${OBELISK_API_URL:-http://127.0.0.1:5105}/v1/executions"

# Send one prompt to the running endpoint and print the reply.
#   just chat "Say hi in one word."          # claude backend
#   just chat "2+2?" codex                    # codex backend
chat prompt model="claude":
  ./scripts/chat.sh "{{prompt}}" "{{model}}"
