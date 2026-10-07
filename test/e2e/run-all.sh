#!/usr/bin/env bash
# Run every row in test/e2e/rows plus the no-plugin control through run-headless.sh,
# and fail if any run fails its `# expect-provider:` check.
# Env: DSH_VERSION, as for run-headless.sh.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
failed=()
for row in --control "$here"/rows/*.yml; do
  "$here/run-headless.sh" "$row" || failed+=("$row")
done

if [ ${#failed[@]} -gt 0 ]; then
  printf '== FAILED: %s\n' "${failed[@]}" >&2
  exit 1
fi
echo "== all e2e runs passed (dsh ${DSH_VERSION:-latest})" >&2
