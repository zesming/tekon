#!/usr/bin/env bash
set -euo pipefail

if command -v actionlint >/dev/null 2>&1; then
  exec actionlint -color "$@"
fi

if command -v docker >/dev/null 2>&1; then
  exec docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:1.7.12 -color "$@"
fi

cat >&2 <<'ACTIONLINT_MISSING'
actionlint is required but was not found.
Install actionlint locally or run with Docker available.
ACTIONLINT_MISSING
exit 127
