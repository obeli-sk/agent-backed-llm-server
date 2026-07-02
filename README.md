# agent-backed-llm-server

An OpenAI-compatible **LLM endpoint** backed by a Claude or Codex CLI running in
docker. It lets a subscription (`~/.claude` / `~/.codex` login, no API key) be
consumed through the standard `POST /v1/chat/completions` wire protocol.

It is the backend half of a split:

```
FRONTEND  obelisk-agent            THE AGENT
  - pure HTTP, holds the conversation in durable workflow state
  - each turn: POST /v1/chat/completions with the FULL message history
             |
             |  standard, stateless-looking chat completions
             v
BACKEND   agent-backed-llm-server   THE ENDPOINT (this app)
  - webhook receives the request, a long-running workflow (one per conversation)
    owns the docker container + warm claude/codex CLI and answers the turn
```

The frontend can point `LLM_BASE_URL` at this app **or** straight at OpenRouter /
OpenAI / vLLM / Ollama. This app only exists so a Claude/Codex *subscription* (no
API key) can be spoken to over the same standard wire.

See [DESIGN.md](DESIGN.md) for how the stateless wire is bridged onto a stateful,
durable CLI session (the stub pair, header-less pairing, idle teardown, tool calls).

## Ports

This app runs a **second** Obelisk instance next to another one, so `server.toml`
shifts every port +100 off the defaults: API `5105`, Web UI `8180`, and the
external HTTP server (which serves `/v1/chat/completions`) `9190`.

## Run

```sh
just build    # build docker.io/getobelisk/agent-backed-llm-server:latest

claude        # authenticate once (OAuth) -> ~/.claude ; or `codex login` -> ~/.codex
              # AGENT_HOST_CLAUDE_DIR / AGENT_HOST_CODEX_DIR select what gets mounted

just serve    # obelisk server run --server-config server.toml -d deployment.toml
```

## Test

```sh
curl http://127.0.0.1:9190/v1/chat/completions \
  -H content-type:application/json -d '{
    "model": "claude",
    "messages": [{"role":"user","content":"Say hi in one word."}]
  }'
```

Point the `obelisk-agent` frontend (or any OpenAI client) at
`http://127.0.0.1:9190` as its `LLM_BASE_URL`. `model` selects the backend:
anything containing `codex`/`gpt`/`o1`/`o3` routes to codex, otherwise claude.
