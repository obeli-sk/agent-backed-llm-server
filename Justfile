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

# Send one prompt to the running endpoint and print the reply.
chat prompt model="codex":
  ./scripts/chat.sh "{{prompt}}" "{{model}}"
