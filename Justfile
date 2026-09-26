image := "docker.io/getobelisk/agent-backed-llm-server:latest"
api_url := "http://127.0.0.1:5105"          # server.toml moves the API off the default 5005

build:
  docker build -t {{image}} agent-server

verify:
  obelisk server verify -s server.toml -a app.toml -d deployment.toml

fix:
  obelisk server verify --fix -s server.toml -a app.toml -d deployment.toml

serve:
  obelisk server run -s server.toml -a app.toml -d deployment.toml

# Send one prompt to the running endpoint and print the reply.
#   just chat "Say hi in one word."          # claude backend
#   just chat "2+2?" codex                    # codex backend
chat prompt model="claude":
  ./scripts/chat.sh "{{prompt}}" "{{model}}"
