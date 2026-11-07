#!/usr/bin/env bash
# Linux acceptance in one pass. The headless test needs no Herdr install.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

printf '== node\n'
node --version

printf '\n== verify.sh\n'
./verify.sh

printf '\n== headless and load tests\n'
node --test test/headless.test.js test/load.test.js

printf '\n== load numbers\n'
node scripts/load-test.js
