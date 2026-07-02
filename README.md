# agent-llm-server

An OpenAI-compatible **LLM endpoint** backed by a Claude or Codex CLI running in
docker. It lets a subscription (`~/.claude` / `~/.codex` login, no API key) be
consumed through the standard `POST /v1/chat/completions` wire protocol.

It is the backend half of a split:

```
FRONTEND  obelisk-agent            THE AGENT
  - pure HTTP, no exec activities
  - holds the conversation in durable workflow state
  - each turn: POST /v1/chat/completions with the FULL message history
  - knows nothing about this backend; sends no custom headers
             |
             |  standard, stateless-looking chat completions
             v
BACKEND   agent-llm-server          THE ENDPOINT (this app)
  webhook_endpoint_js   POST /v1/chat/completions
  workflow (long-running, one per conversation)
     - owns the docker container + warm claude/codex CLI
     - exec activities: start / send / recv / cleanup
```

The frontend can point `LLM_BASE_URL` at this app **or** straight at OpenRouter /
OpenAI / vLLM / Ollama. This app only exists so a Claude/Codex *subscription*
(no API key) can be spoken to over the same standard wire.

## Why a warm session, and the problem it creates

`claude` and `codex` are not chat models; they are stateful agents that keep a
live session (working directory, edited files, their own context). To preserve
that across turns, one long-running workflow owns one warm CLI process per
conversation, exactly as the container does today.

But Chat Completions is **stateless**: there is no session id on the wire, and
the client resends the whole message history every call. So the backend has to
(1) figure out *which* warm session an incoming request belongs to, using only
the history content, and (2) bridge a synchronous HTTP request/response onto a
durable, long-running workflow.

## The stub pair

A **stub activity** is a special activity with no implementation, only a WIT
signature. A workflow creates one as a child execution and obtains its execution
id; from there it can be awaited, have its result injected, or be cancelled. That
is all it is: a named, typed rendezvous identified by an execution id. Only a
workflow can create one, so the session workflow owns creation. Once it exists,
either side can drive it by id:

- an **external party (including this webhook)** can *inject* its result
  (`PUT /v1/executions/<id>/stub`) and *await* it
  (`GET /v1/executions/<id>?follow=true`, block-and-stream);
- the **owning workflow** can *await* it, *inject* a result via the
  `stub-execution` REST activity, or *cancel* it. It can also race the await
  against a persistent sleep, which is how a session cleans itself up when the
  frontend goes idle (see [Idle and teardown](#idle-and-teardown)).

So the two roles below are a choice about who injects vs. who awaits for each
stub, not a direction the primitive imposes.

A turn uses two stubs playing opposite roles:

- **`turn.request`** — inbound. The workflow submits it and awaits; the webhook
  fulfils it with the turn's new messages. Its params carry the routing info the
  webhook needs *before* it fulfils: the pairing key and the paired reply id.
- **`turn.response`** — outbound. The workflow submits it, then self-fulfils it
  via the `stub-execution` REST call once `recv` produces the reply. The webhook
  reads it with `GET /v1/executions/<id>?follow=true` (block-and-stream).

```wit
package agent-llm:session;

interface turn {
  // What the webhook hands in for the next turn.
  variant next {
    delta(string),   // JSON: messages appended since the last assistant reply
    teardown,        // frontend abandoned the conversation / operator stop
  }

  // INBOUND: workflow submits(response-id, expected-prefix-hash) & awaits;
  // webhook injects `next` by execution id.
  request: func(response-id: string, expected-prefix-hash: string)
             -> result<next, string>;

  // OUTBOUND: workflow submits, then self-fulfils; webhook follows the result.
  //   ok  = JSON of the OpenAI assistant message { content?, tool_calls? }
  //   err = structured failure (rate_limited{retry_after}, exited, ...)
  response: func() -> result<string, string>;
}
```

`deployment.toml`:

```toml
[[activity_stub]]
ffqn = "agent-llm:session/turn.request"
params = [
  { name = "response-id",          type = "string" },
  { name = "expected-prefix-hash", type = "string" },
]
return_type = "result<variant { delta(string), teardown }, string>"

[[activity_stub]]
ffqn = "agent-llm:session/turn.response"
params = []
return_type = "result<string, string>"
```

## The turn handshake

```
session workflow, each turn:
  respId = joinSet.submit(turn.response, [])                     // child id created here
  reqId  = raceSet.submit(turn.request, [respId, prefix_hash])   // params expose respId + key
  raceSet.submitDelay(idle)                                      // persistent sleep
  winner = raceSet.joinNext()                                    // request stub OR idle
  delta  = obelisk.getResult(reqId)                              // -> delta | teardown
  session.send(delta); reply = session.recv()
  obelisk.stub(respId, { ok: replyJson })                        // self-fulfil the reply
  // loop with the new committed history
```

```
webhook, each request:
  prefix_hash = hash(messages up to & including the last assistant message)
  if no assistant message in history:                    // turn 0
     obelisk.schedule(sessionId, workflow.session, [backend, systemPrompt])
     find that session's pending turn.request (by FFQN + session-id prefix)
  else:
     find any turn.request whose params.expected-prefix-hash == prefix_hash
     (NO MATCH => 409, see "mismatch")
  { respId } = that stub's params
  PUT /v1/executions/<reqId>/stub { ok: { delta } }      // deliver new messages
  reply = obelisk.get(respId)                            // block for the reply
  return it as the chat-completions response
```

The two directions map onto plain runtime calls: the webhook submits the session
with `obelisk.schedule`, delivers the delta with a REST `PUT .../stub`, and reads
the reply with the blocking `obelisk.get(respId)`; the workflow self-fulfils the
reply with `obelisk.stub(respId, …)`. Turn 0 differs only in how the session is
located (by the id the webhook just scheduled, since there is no history hash to
match yet); everything after is one code path. The webhook never creates a stub.

## Pairing without a header (and "mismatch fails")

The frontend sends no session id, so the backend keys sessions on the history
itself. Each `turn.request` is submitted with `expected-prefix-hash` = a hash of
the history the workflow has already committed (everything up to and including
its own last assistant reply). That is exactly the prefix the client resends
next turn, so the webhook pairs a request by matching
`hash(incoming history up to its last assistant)` against the pending stubs.

- **No assistant message** in the history => turn 0 => start a new session.
- **A match** => route the trailing messages (the delta) into that session.
- **No match** but the history has assistant messages => the session is gone or
  the history diverged => **fail** (`409`). We are deliberately stricter than a
  real prefix cache: for a provider a miss just costs more, but here a miss means
  the stateful CLI session cannot be found.

Two identical histories in flight at once hash-collide onto one session; the
webhook locks a session to one in-flight turn and rejects a second concurrent
match.

## Idle and teardown

The workflow does not await `turn.request` forever. It races that await against a
**persistent sleep** (the idle timeout). If the sleep wins, the frontend has gone
quiet, so the workflow runs `session.cleanup` and ends. The sleep is durable, so
an abandoned session is still reclaimed across a server restart. The `teardown`
arm of `next` is for an explicit operator stop.

## Tool calls

The frontend sends its tools as standard OpenAI `tools`; the model returns
standard `tool_calls`; a final answer is an assistant message with no
`tool_calls`. The webhook renders `tools[]` into the CLI's system prompt as the
`{"tool_calls":[...]}` / `{"final":...}` envelope instructions when it starts the
session, and the container's `server.js` parses that envelope back into
`tool_calls` on the way out. So the wire stays plain Chat Completions while the
CLI keeps running its own inner FS/shell loop.

## Layout

```
agent-server/        docker image: node + claude-code + codex + server.js (socket normalizer)
activity/
  agent-start.js     spawn the container, wait for the socket   (claude.start / codex.start)
  agent-send.js      send one agent-input                        (session.send)
  agent-recv.js      drain one turn, typed reply                 (session.recv)
  agent-cleanup.js   shut the server down, docker rm             (session.cleanup)
workflow/session.js  long-running per-conversation loop (the stub pair, above)
webhook/chat.js      POST /v1/chat/completions (pairing + delta + reply)
deployment.toml      FFQNs, the stub pair, and the webhook allow-list
```

`server.js`, `entrypoint.sh`, and the four exec activities are carried over from
`obelisk-agent` unchanged: the socket protocol between the activities and the
container is the same. Only the driver on top (a webhook + a stub-driven
workflow, instead of a self-contained agent loop) is new.

## Build the image

```sh
just build   # -> ghcr.io/obeli-sk/agent-llm-server:latest
```

## Authenticate the backend (subscription, no API key)

The start activity bind-mounts your host CLI config into the container:

```sh
claude        # OAuth once; populates ~/.claude
codex login   # populates ~/.codex
```

`AGENT_HOST_CLAUDE_DIR` (default `$HOME/.claude`) and `AGENT_HOST_CODEX_DIR`
(default `$HOME/.codex`) select what gets mounted.

## Run

```sh
just serve    # obelisk server run -d deployment.toml
```

The chat endpoint is served on the Obelisk webhook port (default `8080`):

```sh
curl http://127.0.0.1:8080/v1/chat/completions \
  -H content-type:application/json -d '{
    "model": "claude",
    "messages": [{"role":"user","content":"Say hi in one word."}]
  }'
```

Point the `obelisk-agent` frontend (or any OpenAI client) at
`http://127.0.0.1:8080` as its `LLM_BASE_URL`. `model` selects the backend:
anything containing `codex`/`gpt`/`o1`/`o3` routes to codex, otherwise claude.

## Known limitations (v1)

- **Reply hold on rate limit.** When the CLI hits its subscription session limit,
  the workflow sleeps (durably) until reset before answering, and the HTTP request
  is held open (via the blocking `obelisk.get`) for that time. Frequent turns are
  fast; this only bites on a session-limit turn.
- **Turn-0 retries can duplicate a session.** A brand-new conversation gets a
  fresh session id; if the very first request is retried before it is answered, a
  second session may start. The orphan is reclaimed by the idle sleep. Continuation
  (turn k) retries are idempotent (they re-pair by hash and re-read the reply).
- **Pairing collisions.** Two conversations with an identical system prompt and
  identical history hash to the same key; the webhook serves one and a concurrent
  duplicate should be rejected/serialized. Unlikely in practice, noted for rigor.
- **The pairing hash is a 64-bit non-cryptographic hash** (`hash64`, shared
  byte-for-byte by `workflow/session.js` and `webhook/chat.js`); keep the two
  copies in sync.
