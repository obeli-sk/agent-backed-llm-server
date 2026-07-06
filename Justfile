image := "docker.io/getobelisk/agent-backed-llm-server:latest"
api_url := "http://127.0.0.1:5105"          # server.toml moves the API off the default 5005

build:
  docker build -t {{image}} agent-server

verify:
  obelisk server verify --server-config server.toml -d deployment.toml

serve:
  obelisk server run --server-config server.toml -d deployment.toml

sync:
  obelisk deployment get $(obelisk deployment active -a {{api_url}}) --force -a {{api_url}}
