#!/usr/bin/env bash

# Send one prompt to the /v1/chat/completions endpoint and print the reply.
# Usage: scripts/chat.sh "your prompt" [model]
#   model defaults to "claude"; anything containing "codex" or starting with
#   gpt/o1/o3 routes to the codex backend (see README.md).
# Env: INTERNAL_BASE_URL, the configured internal listener URL.

set -euo pipefail

prompt=${1:?usage: chat.sh "<prompt>" [model]}
model=${2:-claude}
internal_base_url=${INTERNAL_BASE_URL:?Set INTERNAL_BASE_URL to the configured internal address}
internal_base_url=${internal_base_url%/}

body=$(jq -n --arg m "$model" --arg p "$prompt" \
  '{model: $m, messages: [{role: "user", content: $p}]}')

# -D dumps headers to stderr so x-obelisk-execution-id is visible for inspection.
resp=$(curl -sS -m 600 -D /dev/stderr "$internal_base_url/v1/chat/completions" \
  -H content-type:application/json -d "$body")

echo "$resp" | jq -r '.choices[0].message.content // (. | tostring)'
