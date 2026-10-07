#!/usr/bin/env bash
# End-to-end check against real dsh: boots `dsh --profile headless` in a throwaway
# DSH_HOME, routes the default model to mock-openai.mjs through an llm-pi-ai route,
# mounts the plugin row from <row.yml>, sends one prompt, and prints what the mock received.
#
# Usage: test/e2e/run-headless.sh <row.yml>      plugin row(s) to apply as a patch
#        test/e2e/run-headless.sh --control      no plugin, for comparison
# Placeholders in <row.yml>: __MOCK_BASE__ (mock route baseURL, ends in /v1), __REPO__ (this repo's root).
# Env: DSH_VERSION (default: latest), e.g. DSH_VERSION=0.2.0-rc.2 or DSH_VERSION=alpha.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
row=${1:?usage: run-headless.sh <row.yml> | --control}

work=$(mktemp -d)
mock=
cleanup() { [ -n "$mock" ] && kill "$mock" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT

node "$here/mock-openai.mjs" "$work/requests.jsonl" "$work/port" &
mock=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
base="http://127.0.0.1:$(cat "$work/port")/v1"

cat > "$work/overlay.yml" <<EOF
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      mockrouter:
        apiKeyEnv: MOCK_KEY
        api: openai-completions
        baseURL: $base
        models:
          - id: mock-model
            contextWindow: 131072
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mockrouter
    model: mock-model
EOF
if [ "$row" != "--control" ]; then
  sed -e "s#__MOCK_BASE__#$base#g" -e "s#__REPO__#$repo#g" "$row" >> "$work/overlay.yml"
fi

echo "== dsh ${DSH_VERSION:-latest}, mock at $base, row: $row" >&2
MOCK_KEY=dummy DSH_HOME="$work/home" npx --yes "@deepseek-ai/dsh@${DSH_VERSION:-latest}" \
  --profile headless --patch "$work/overlay.yml" "reply with the single word pong"

echo "== requests seen by the mock" >&2
node -e '
const fs = require("fs")
const file = process.argv[1]
if (!fs.existsSync(file)) { console.log("(none)"); process.exit(0) }
for (const line of fs.readFileSync(file, "utf8").trim().split("\n")) {
  const r = JSON.parse(line)
  console.log(r.method, r.url, "model=" + r.body?.model, "provider=" + JSON.stringify(r.body?.provider))
}' "$work/requests.jsonl"
