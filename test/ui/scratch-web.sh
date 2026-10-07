#!/usr/bin/env bash
# A scratch `dsh web` with this repo installed, for checking the client half in a browser.
# Never touches the live profile: everything lives under <dir>.
#
# Usage: test/ui/scratch-web.sh start <dir>   install this repo by `link:` into <dir>/home (profile web),
#                                             start the mock LLM and `dsh web --port 0`, print the URL
#        test/ui/scratch-web.sh stop <dir>    stop the processes `start` launched, by their process groups
#
# The profile gets two pi-ai routes: `trustedrouter` (the real gateway, dummy key, for the UI only) and
# `mockrouter` (test/e2e/mock-openai.mjs, the default model, also listed as a gateway so chats show the
# policy in <dir>/requests.jsonl). The profile patch is written once; later starts only repoint the mock's
# port, so UI saves survive restarts. Plugin lines and the URL land in <dir>/web.log.
#
# `link:` means client edits reach the page through the client-modules HMR; host edits need a restart.
# Env: DSH_VERSION (default 0.2.0-rc.2), e.g. DSH_VERSION=alpha.
#      PLUGIN_SPEC (default link:<repo>), e.g. github:AmmarByFar/dsh-trustedrouter#main to check the
#      installed copy as a user gets it. It applies only to a fresh <dir>; an installed profile is kept.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
cmd=${1:?usage: scratch-web.sh start|stop <dir>}
dir=$(mkdir -p "${2:?usage: scratch-web.sh start|stop <dir>}" && cd "$2" && pwd)
version=${DSH_VERSION:-0.2.0-rc.2}
spec=${PLUGIN_SPEC:-link:$repo}

stop_group() {
  local file=$1
  [ -f "$file" ] || return 0
  local pgid
  pgid=$(cat "$file")
  kill -- "-$pgid" 2>/dev/null || true
  rm -f "$file"
}

if [ "$cmd" = stop ]; then
  stop_group "$dir/web.pgid"
  stop_group "$dir/mock.pgid"
  echo "stopped" >&2
  exit 0
fi
[ "$cmd" = start ] || { echo "usage: scratch-web.sh start|stop <dir>" >&2; exit 2; }
[ -f "$dir/web.pgid" ] && { echo "already running; run: $0 stop $dir" >&2; exit 1; }

# dsh needs pnpm on PATH; a scratch shim avoids `corepack enable`.
mkdir -p "$dir/bin"
printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$dir/bin/pnpm"
chmod +x "$dir/bin/pnpm"
export DSH_HOME="$dir/home" PATH="$dir/bin:$PATH"
profile="$DSH_HOME/profiles/web"

if ! grep -q '"dsh-trustedrouter"' "$profile/package.json" 2>/dev/null; then
  npx --yes "@deepseek-ai/dsh@$version" plugin --profile web add "$spec"
fi

rm -f "$dir/mock-port"
setsid node "$repo/test/e2e/mock-openai.mjs" "$dir/requests.jsonl" "$dir/mock-port" < /dev/null > "$dir/mock.log" 2>&1 &
echo $! > "$dir/mock.pgid"
for _ in $(seq 50); do [ -s "$dir/mock-port" ] && break; sleep 0.1; done
mock="http://127.0.0.1:$(cat "$dir/mock-port")/v1"

if ! grep -q 'mockrouter' "$profile/cordis.patch.yml" 2>/dev/null; then
  cat > "$profile/cordis.patch.yml" <<EOF
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      trustedrouter:
        api: openai-completions
        baseURL: https://api.trustedrouter.com/v1
        apiKeyEnv: TRUSTEDROUTER_API_KEY
        models:
          - id: z-ai/glm-5.3
          - id: anthropic/claude-haiku-4.5
          - id: z-ai/glm-5.3:nitro
      mockrouter:
        api: openai-completions
        baseURL: $mock
        apiKeyEnv: MOCK_KEY
        models:
          - id: mock-model
            contextWindow: 131072
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: mockrouter
    model: mock-model
- id: trustedrouter
  config:
    gateways: [https://api.trustedrouter.com/v1, $mock]
    log: true
EOF
else
  sed -i -E "s#http://127\.0\.0\.1:[0-9]+/v1#$mock#g" "$profile/cordis.patch.yml"
fi

TRUSTEDROUTER_API_KEY=dummy MOCK_KEY=dummy setsid npx --yes "@deepseek-ai/dsh@$version" web --port 0 --no-open < /dev/null > "$dir/web.log" 2>&1 &
echo $! > "$dir/web.pgid"
for _ in $(seq 600); do grep -q 'dsh web: http' "$dir/web.log" && break; sleep 0.2; done
url=$(grep -o 'dsh web: http[^ ]*' "$dir/web.log" | head -1 | sed 's/^dsh web: //')
[ -n "$url" ] || { echo "dsh web did not print a URL; see $dir/web.log" >&2; exit 1; }
echo "dsh $version web: $url" >&2
echo "mock: $mock (requests in $dir/requests.jsonl)" >&2
echo "$url"
