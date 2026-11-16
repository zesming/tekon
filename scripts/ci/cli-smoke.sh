#!/usr/bin/env bash
# Smoke-check the built CLI binary: its version must match the root package
# version and --help must render. Shared by the primary verify job and every
# Node compatibility floor so the two cannot drift apart.
set -euo pipefail

expected="v$(node -p "require('./package.json').version")"
actual="$(node packages/cli/dist/index.js --version)"
test "$actual" = "$expected"
node packages/cli/dist/index.js --help >/dev/null
