#!/usr/bin/env bash
# Clean-install check: installs the plugin into a fresh DSH_HOME the way a user would (`dsh plugin add`),
# then checks the installed copy rather than this checkout:
#   1. the install asks for no build approval and leaves a real copy with both halves in the profile;
#   2. headless: installed.yml configures the bundle's own row, and every POST to the mock carries
#      its `provider` (through run-headless.sh);
#   3. web: `dsh web` lists dsh-trustedrouter in its boot graph and serves the installed client.js.
# Whether the page then boots and the section renders still needs a browser; see PLAN.md → Testing → UI.
#
# Usage: test/e2e/clean-install.sh [spec]   default: an `npm pack` of this checkout, which holds the
#                                            same files a git install gets
#        e.g. test/e2e/clean-install.sh github:AmmarByFar/dsh-trustedrouter#main
# Env: DSH_VERSION (default: latest). Needs pnpm on PATH, or corepack for a scratch shim.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
export DSH_VERSION=${DSH_VERSION:-latest}

work=$(mktemp -d)
web=
cleanup() { [ -n "$web" ] && kill -- "-$web" 2>/dev/null; rm -rf "$work"; }
trap cleanup EXIT
fail() { echo "== FAIL: $*" >&2; exit 1; }
dsh() { npx --yes "@deepseek-ai/dsh@$DSH_VERSION" "$@"; }

export DSH_HOME="$work/home"
# dsh needs pnpm on PATH; a scratch shim avoids `corepack enable`.
if ! command -v pnpm > /dev/null; then
  mkdir -p "$work/bin"
  printf '#!/bin/sh\nexec corepack pnpm "$@"\n' > "$work/bin/pnpm"
  chmod +x "$work/bin/pnpm"
  export PATH="$work/bin:$PATH" COREPACK_ENABLE_DOWNLOAD_PROMPT=0
fi

spec=${1:-}
[ -n "$spec" ] || spec="$work/$(cd "$repo" && npm pack --silent --pack-destination "$work")"

for profile in headless web; do
  echo "== dsh $DSH_VERSION: plugin --profile $profile add $spec" >&2
  dsh plugin --profile "$profile" add "$spec" 2>&1 | tee "$work/add-$profile.log" >&2
  if grep -qi 'allowBuilds' "$work/add-$profile.log"; then fail "the install asked for build approval"; fi
  pkg="$DSH_HOME/profiles/$profile/node_modules/dsh-trustedrouter"
  [ -d "$pkg" ] && [ ! -L "$pkg" ] || fail "$pkg is not an installed copy"
  for file in package.json index.js client.js cordis.patch.yml locale/en.json icon.svg; do
    [ -f "$pkg/$file" ] || fail "the installed copy has no $file"
  done
done

echo "== headless run with the installed copy" >&2
E2E_DSH_HOME="$DSH_HOME" "$here/run-headless.sh" "$here/installed.yml"

echo "== dsh web with the installed copy" >&2
setsid npx --yes "@deepseek-ai/dsh@$DSH_VERSION" web --port 0 --no-open < /dev/null > "$work/web.log" 2>&1 &
web=$!
for _ in $(seq 600); do grep -q 'dsh web: http' "$work/web.log" && break; sleep 0.2; done
url=$(grep -o 'dsh web: http[^ ]*' "$work/web.log" | head -1 | sed 's/^dsh web: //')
[ -n "$url" ] || { cat "$work/web.log" >&2; fail "dsh web did not print a URL"; }

# The tokened URL sets the session cookie and redirects to the page, which carries the boot graph.
curl -fsS -c "$work/cookies" -b "$work/cookies" -L "$url" -o "$work/index.html"
client=$(node -e '
const html = require("fs").readFileSync(process.argv[1], "utf8")
const json = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s)?.[1]
const entry = json && JSON.parse(json).entries.find(entry => entry.id === "dsh-trustedrouter")
if (!entry) process.exit(1)
console.log(entry.url)' "$work/index.html") || fail "dsh-trustedrouter is not in the web boot graph"
curl -fsS -b "$work/cookies" "${url%%\?*}$client" -o "$work/client.js"
installed="$DSH_HOME/profiles/web/node_modules/dsh-trustedrouter/client.js"
head -c "$(wc -c < "$installed")" "$work/client.js" | cmp -s - "$installed" \
  || fail "the served $client is not the installed client.js"
echo "== PASS: web serves the installed client.js as $client" >&2
echo "== clean install passed (dsh $DSH_VERSION, $spec)" >&2
