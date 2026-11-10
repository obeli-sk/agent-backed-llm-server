image := "docker.io/getobelisk/agent-backed-llm-server:latest"

build:
  docker build -t {{image}} agent-server

rebuild:
  docker build --pull --no-cache -t {{image}} agent-server

verify:
  obelisk deployment verify -d deployment.toml
  obelisk server verify --dev --skip-db -s server.toml -a app.toml -d deployment.toml

fix:
  obelisk server verify --dev --skip-db --fix -s server.toml -a app.toml -d deployment.toml

serve:
  bash scripts/serve.sh

refresh-models:
  #!/usr/bin/env bash
  set -euo pipefail
  obelisk execution submit agent-backed-llm:models/workflow.refresh-model-inventory --

# Send one prompt to the running endpoint and print the reply.
#   just chat "Say hi in one word."          # claude backend
#   just chat "2+2?" codex                    # codex backend
chat prompt model="claude":
  ./scripts/chat.sh "{{prompt}}" "{{model}}"
