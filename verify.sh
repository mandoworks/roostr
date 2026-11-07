#!/usr/bin/env bash
# verify.sh: every acceptance check for crew-board in one place.
#
# Read only with respect to Herdr: the only live call is an optional
# `crew-board --json` (a snapshot and pane reads) when run inside Herdr.
# It never renames, links, opens, or closes anything.
#
# Pass --public (or PUBLIC=1) to run the hygiene check in public mode, for the
# eventual repo flip. It scans shipped and internal tracked files for private
# names and machine paths and fails on any hit. It is expected to fail while
# the repo is private.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PUBLIC="${PUBLIC:-0}"
for arg in "$@"; do
  case "$arg" in
    --public) PUBLIC=1 ;;
  esac
done

hr() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() { printf '   \033[32mok\033[0m   %s\n' "$*"; }
bad() { printf '   \033[31mFAIL\033[0m %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
FAILURES=0

hr "1. syntax check every script"
while IFS= read -r f; do
  if node --check "$f" 2>/dev/null; then ok "$f"; else bad "$f"; fi
done < <({ find src scripts test integrations -name '*.js' -o -name '*.mjs'; [ -f bin/crew-board ] && echo bin/crew-board; [ -f bin/roostr ] && echo bin/roostr; } | sort)

hr "2. unit tests (node:test)"
if node --test --test-reporter=dot test/*.test.js; then ok "all tests pass"; else bad "tests failed"; fi

hr "3. manifest"
if command -v python3 > /dev/null && python3 -c 'import tomllib' 2>/dev/null; then
  python3 - <<'PY' && ok "herdr-plugin.toml parses and has the board, popup, both actions, and the status event" || bad "manifest"
import tomllib
d = tomllib.load(open('herdr-plugin.toml', 'rb'))
assert d['id'] in ('roostr', 'crew-board')
assert 'build' not in d, 'zero dependency plugin: no [[build]] step'
panes = {p['id']: p for p in d['panes']}
assert panes['board']['placement'] == 'split' and panes['board']['command'] in (['node', 'bin/roostr'], ['node', 'bin/crew-board'])
assert panes['board-popup']['placement'] == 'popup'
acts = {a['id']: a for a in d['actions']}
assert acts['toggle-board']['command'] == ['node', 'scripts/toggle.js']
assert acts['popup-board']['command'] == ['node', 'scripts/toggle.js', '--popup']
ev = {e['on']: e for e in d['events']}
assert ev['pane.agent_status_changed']['command'] == ['node', 'scripts/status-event.js']
PY
else
  echo "   python3 tomllib unavailable, using crew-board's own reader"
fi
if node -e "require('./src/crewfile').parseToml(require('fs').readFileSync('herdr-plugin.toml','utf8'))"; then
  ok "crew-board's TOML reader also parses the manifest"
else
  bad "crew-board's TOML reader rejects the manifest"
fi

hr "4. zero dependency audit"
if [ -e package.json ] || [ -d node_modules ]; then bad "package.json or node_modules exists"; else ok "no package.json, no node_modules"; fi
if grep -rhoE "require\(['\"][^'\"]+['\"]\)" src scripts bin test | grep -vE "require\(['\"](\.|node:|fs|os|path|child_process)" ; then
  bad "a require that is not a Node builtin or a local file"
else
  ok "every require is a Node builtin or a local file"
fi

hr "5. public repo hygiene"
FORBIDDEN_PATTERN='armando|puntopio|contabo|tailnet|\.secrets/|memory/global|jefota|spuela|herdr-ps5|ue-core|/Users/|/home/[a-z]+/'

SHIPPED_FILES=()
INTERNAL_FILES=()

if command -v git > /dev/null 2>&1 && git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  while IFS= read -r -d '' f; do
    [ "$f" = "verify.sh" ] && continue
    case "$f" in
      src/*|scripts/*|bin/*|test/*|integrations/*|examples/*|skills/*|README.md|herdr-plugin.toml|LICENSE)
        SHIPPED_FILES+=("$f")
        ;;
      *)
        INTERNAL_FILES+=("$f")
        ;;
    esac
  done < <(git ls-files -z)
else
  while IFS= read -r -d '' f; do
    f="${f#./}"
    [ "$f" = "verify.sh" ] && continue
    case "$f" in .git/*) continue ;; esac
    case "$f" in
      src/*|scripts/*|bin/*|test/*|integrations/*|examples/*|skills/*|README.md|herdr-plugin.toml|LICENSE)
        SHIPPED_FILES+=("$f")
        ;;
      *)
        INTERNAL_FILES+=("$f")
        ;;
    esac
  done < <(find . -type f -print0)
fi

SHIPPED_HITS=""
if [ "${#SHIPPED_FILES[@]}" -gt 0 ]; then
  SHIPPED_HITS=$(grep -inHE "$FORBIDDEN_PATTERN" "${SHIPPED_FILES[@]}" 2>/dev/null || true)
fi

CLEAN_HITS=$(printf '%s\n' "$SHIPPED_HITS" | sed '/^[[:space:]]*$/d')
if [ -n "$CLEAN_HITS" ]; then
  echo "$CLEAN_HITS"
  bad "machine specific path or private project name in shipped files"
else
  ok "no machine paths or private project names in shipped files"
fi

if [ "${#INTERNAL_FILES[@]}" -gt 0 ]; then
  WARN_HITS=$(grep -inHE "$FORBIDDEN_PATTERN" "${INTERNAL_FILES[@]}" 2>/dev/null || true)
  WARN_HITS=$(printf '%s\n' "$WARN_HITS" | sed '/^[[:space:]]*$/d')
  if [ -n "$WARN_HITS" ]; then
    if [ "$PUBLIC" = "1" ]; then
      echo "$WARN_HITS"
      bad "internal files carry private names or machine context (public mode)"
    else
      echo "   internal files to review before going public:"
      printf '%s\n' "$WARN_HITS" | cut -d: -f1 | sort -u | sed 's/^/     WARN: /'
    fi
  fi
fi
if grep -rn "—" AGENTS.md src scripts bin test integrations examples README.md docs/*.md herdr-plugin.toml 2>/dev/null; then
  bad "em dash in prose above"
else
  ok "no em dashes"
fi
if grep -rnE "shell:\s*true|execSync\(|[^.a-zA-Z]exec\(|spawn\(['\"](ba|z)?sh['\"]" src scripts bin integrations; then
  bad "shell execution found above (checks and Herdr calls must use execFile)"
else
  ok "no shell execution: every command runs through execFile with an argv array"
fi

hr "6. live smoke (only inside Herdr)"
if [ "${HERDR_ENV:-}" = "1" ]; then
  BIN="bin/crew-board"
  [ -f bin/roostr ] && BIN="bin/roostr"
  if node "$BIN" --json > /dev/null; then
    ok "$BIN --json read the live session ($(node "$BIN" --json | grep -c '"paneId"') agent panes)"
  else
    bad "$BIN --json failed against the live session"
  fi
else
  echo "   skipped: not inside Herdr"
fi

hr "result"
if [ "$FAILURES" -eq 0 ]; then
  printf '   \033[32mALL CHECKS PASSED\033[0m\n\n'
  exit 0
fi
printf '   \033[31m%d CHECK(S) FAILED\033[0m\n\n' "$FAILURES"
exit 1
