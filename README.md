# agent-backed-llm-server

> [!WARNING]
> **Vibe coded**: This codebase was generated using an agent, testing the limits of this approach.

An OpenAI-compatible **LLM endpoint** backed by a Claude or Codex CLI running in
docker. It lets a subscription (`~/.claude` / `~/.codex` login, no API key) be
consumed through the standard `POST /v1/chat/completions` wire protocol.

It is the backend half of a split with
[`workflow-agent`](https://github.com/obeli-sk/workflow-agent):

```
FRONTEND  workflow-agent           THE AGENT (FFQN prefix: obelisk-agent)
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

The gateway passes the client's system message to the CLI, alongside its tool
calling instructions. It does not add application-specific documentation.
For example, `workflow-agent` includes the Obelisk docs index in its own system
message; other clients can supply instructions for their own domain.

See [DESIGN.md](DESIGN.md) for how the stateless wire is bridged onto a stateful,
durable CLI session (the stub pair, header-less pairing, idle teardown, tool calls).

## Ports

This app runs a **second** Obelisk instance next to [`workflow-agent`](https://github.com/obeli-sk/workflow-agent), so `server.toml`
shifts every port +100 off the defaults: API `5105`, Web UI `8180`, and the
external HTTP server (which serves `/v1/chat/completions`) `9190`.

## Run

```sh
just build    # build docker.io/getobelisk/agent-backed-llm-server:latest
just rebuild  # refresh the base image and reinstall both CLIs without build cache

claude        # authenticate once (OAuth) -> ~/.claude ; or `codex login` -> ~/.codex
              # AGENT_HOST_CLAUDE_DIR / AGENT_HOST_CODEX_DIR select what gets mounted

# The API port requires a bearer token since 0.40.0. This one value is read by the
# server and presented by the chat webhook on its API calls. `direnv` users get it
# from .envrc-example; otherwise export it before `just serve`:
export OBELISK_API_TOKEN=$(obelisk generate token --json | jq -r .token)

just serve    # start Obelisk, wait for its API, then submit model discovery
```

`server.toml` is the platform config (ports, database, webhook timeout, exec gate),
`app.toml` the app policy (`app_name`, public env, secrets, outbound HTTP, reviewed
exec digests), and `deployment.toml` the components. After editing an exec
activity, `just fix` appends its new digest in `app.toml` next to the old one:
drop the old digest and copy the new one into the `server.toml` exec gate.

## Model inventory

`just serve` runs `scripts/serve.sh`, which submits
`agent-backed-llm:models/workflow.refresh-model-inventory` after the authenticated
API is ready. Each refresh probes Claude and Codex concurrently in short-lived
containers using the same image, auth mounts, default model, and extra arguments
as real sessions. Claude's initialization control response and Codex's
`model/list` supply the catalogs; no inference prompt is sent.

The launch script uses `OBELISK_API_URL` (default `http://127.0.0.1:5105`) and
`OBELISK_API_TOKEN` (default the repository folder name). It forwards termination
to Obelisk and waits up to `MODEL_DISCOVERY_STARTUP_TIMEOUT_SECONDS` (default 90)
for API readiness. Starting `obelisk server run` directly bypasses the startup
refresh. An hourly cron refresh runs independently and survives restarts.

```sh
just refresh-models                        # submit a refresh manually
curl -fsS http://127.0.0.1:9190/v1/models    # read the persisted inventory
```

`GET /v1/models` returns an OpenAI-shaped list with explicit wire IDs such as
`codex/<discovered-model>` and `claude/<discovered-model>`. Each entry includes its
display name, CLI capabilities, and discovery timestamp. The `backends` metadata
reports `ready`, `stale`, `unavailable`, or `pending`, the last attempt, and any
failure. A failed refresh preserves the last successful catalog for that
backend. With no successful discovery it returns HTTP 503; a partial inventory
returns HTTP 200. Results live in Obelisk's execution history, so normal execution
retention also controls how long cached catalogs survive.

Discovery lists CLI-supported models; it does not guarantee account entitlement
for every inference request. Unsupported models still produce typed errors.
Rebuild the image with `just build` before using discovery for the first time.

`workflow-agent` and `demo-agent` use this endpoint automatically when available.
To generate an explicit fallback `AGENT_MODELS` catalog for a client:

```sh
export AGENT_MODELS=$(curl -fsS http://127.0.0.1:9190/v1/models | jq '[.data[] |
  {id, label: .display_name, api_type: "openai-chat-completions", wire_model: .id}]')
```

Run the protocol, workflow, and launcher regression tests in the dev shell:

```sh
nix develop -c node --experimental-vm-modules --test agent-server/*.test.js workflow/*.test.cjs scripts/*.test.cjs
```

## Test

```sh
curl -i http://127.0.0.1:9190/v1/chat/completions \
  -H content-type:application/json -d '{
    "model": "claude",
    "messages": [{"role":"user","content":"Say hi in one word."}]
  }'
```

Or use the helper, which takes a prompt and an optional model (default `claude`):

```sh
just chat "Say hi in one word."          # claude backend
just chat "Say hi in one word." codex    # codex backend
# equivalently: ./scripts/chat.sh "<prompt>" [model]
```

Successful responses include `x-obelisk-execution-id`, the backing session
workflow execution id to inspect with `obelisk execution status/events/result`.

Point the
[`workflow-agent`](https://github.com/obeli-sk/workflow-agent) frontend (or any
OpenAI client) at
`http://127.0.0.1:9190` as its `LLM_BASE_URL`. `model` selects the backend: a
model containing `codex`, or starting with `gpt`/`o1`/`o3`, routes to codex;
otherwise claude.

### Selecting the model per request

`model` can also pick the concrete CLI model, as `<backend>/<model>`: everything
after the first `/` is passed through to the CLI (`claude --model …` /
`codex -m …`). Without a `/`, the backend's deploy-time default applies
(`AGENT_MODEL` / `AGENT_CODEX_MODEL`, see [Run](#run)).

```sh
just chat "hi" claude/opus       # claude, model "opus"
just chat "hi" codex/gpt-5.5     # codex, model "gpt-5.5"
just chat "hi" claude            # claude, deploy-time default model
```

The model is fixed when the session starts (turn 0). A warm session keeps its
model for the rest of the conversation; changing `model` mid-conversation re-pairs
to the existing session (pairing hashes the history, not the model) and is
ignored.
