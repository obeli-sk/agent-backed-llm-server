image := "ghcr.io/obeli-sk/agent-llm-server:latest"

build:
  docker build -t {{image}} agent-server

serve:
  obelisk server run -d deployment.toml

sync:
  obelisk deployment get $(obelisk deployment active) --force
