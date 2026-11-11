#!/usr/bin/env bash
# Move this device onto the same roostr build as the rest of the fleet:
# the Herdr plugin (release or a branch) and, when asked, the agent skills.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$HOME/.local/bin:$PATH"

HERDR_BIN="${HERDR_BIN:-$(command -v herdr 2>/dev/null || true)}"
NODE_BIN="${NODE_BIN:-$(command -v node 2>/dev/null || true)}"
REF=""
SKILLS_REPO=""
SKILLS_DIR="${ROOSTR_SKILLS_DIR:-$HOME/workspace/skills-repo}"
DO_PLUGIN=1
DO_SKILLS=1
DRY_RUN=0

CONF="${ROOSTR_UPDATE_CONF:-$HOME/.roostr/update.conf}"
if [ -f "$CONF" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONF"
  set +a
  REF="${ROOSTR_REF:-$REF}"
  SKILLS_REPO="${ROOSTR_SKILLS_REPO:-$SKILLS_REPO}"
  SKILLS_DIR="${ROOSTR_SKILLS_DIR:-$SKILLS_DIR}"
fi

usage() {
  cat <<'TXT'
usage: scripts/update.sh [options]

  --ref <ref>           install the plugin from a git ref (for example main)
                        instead of the latest release tag
  --skills-repo <url>   git URL of the agent skills repo to pull and sync
  --skills-dir <path>   where that repo lives (default ~/workspace/skills-repo)
  --no-plugin           skip the Herdr plugin
  --no-skills           skip the skills repo
  -n, --dry-run         print what would run, change nothing
  -h, --help            this help

Reads ~/.roostr/update.conf when present (ROOSTR_REF, ROOSTR_SKILLS_REPO,
ROOSTR_SKILLS_DIR), so a device needs the long flags only once.
TXT
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --skills-repo) SKILLS_REPO="${2:?--skills-repo needs a value}"; shift 2 ;;
    --skills-repo=*) SKILLS_REPO="${1#*=}"; shift ;;
    --skills-dir) SKILLS_DIR="${2:?--skills-dir needs a value}"; shift 2 ;;
    --skills-dir=*) SKILLS_DIR="${1#*=}"; shift ;;
    --no-plugin) DO_PLUGIN=0; shift ;;
    --no-skills) DO_SKILLS=0; shift ;;
    -n|--dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "update: unknown option $1" >&2; usage >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '   would run:'
    printf ' %q' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

plugin_info() {
  [ -n "$HERDR_BIN" ] || return 0
  "$HERDR_BIN" plugin list --json 2>/dev/null | node -e '
    let raw = "";
    process.stdin.on("data", (d) => { raw += d; }).on("end", () => {
      try {
        const data = JSON.parse(raw);
        const list = (data.result && data.result.plugins) || [];
        const p = list.find((x) => x.plugin_id === "roostr");
        if (p) {
          const kind = (p.source && p.source.kind) || "";
          process.stdout.write([kind, p.plugin_root || ""].join("\t"));
        }
      } catch (e) {}
    });
  ' 2>/dev/null || true
}

update_plugin() {
  if [ -z "$HERDR_BIN" ]; then
    say "plugin: skipped, herdr not found (set HERDR_BIN)"
    return 0
  fi
  local kind="" root=""
  IFS=$'\t' read -r kind root <<< "$(plugin_info)" || true
  if [ "$kind" = "local" ]; then
    if [ -n "$root" ] && [ -d "$root/.git" ]; then
      say "plugin: local checkout at $root, pulling"
      run git -C "$root" pull --ff-only
    else
      say "plugin: local checkout at ${root:-$ROOT}, nothing to pull"
    fi
    return 0
  fi
  if [ -n "$REF" ]; then
    # Herdr reinstalls from scratch, so skip when the checkout already carries
    # the ref's head and has no local edits.
    if [ "$kind" = "github" ] && [ -n "$root" ] && [ -d "$root/.git" ]; then
      local have want
      have="$(git -C "$root" rev-parse HEAD 2>/dev/null || true)"
      want="$(GIT_TERMINAL_PROMPT=0 git ls-remote "https://github.com/mandoworks/roostr.git" "$REF" 2>/dev/null | cut -f1 | head -1 || true)"
      if [ -n "$have" ] && [ "$have" = "$want" ] && [ -z "$(git -C "$root" status --porcelain --untracked-files=no 2>/dev/null || true)" ]; then
        say "plugin: already at $REF (${have:0:7})"
        return 0
      fi
    fi
    say "plugin: installing mandoworks/roostr at $REF"
    run "$HERDR_BIN" plugin install mandoworks/roostr --ref "$REF" -y
  elif [ "$kind" = "github" ]; then
    say "plugin: updating roostr from its latest release"
    run "$HERDR_BIN" plugin update roostr -y
  else
    say "plugin: not installed, installing the latest release"
    run "$HERDR_BIN" plugin install mandoworks/roostr -y
  fi
}

update_skills() {
  if [ -z "$SKILLS_REPO" ]; then
    say "skills: skipped, pass --skills-repo or set ROOSTR_SKILLS_REPO"
    return 0
  fi
  if [ -d "$SKILLS_DIR/.git" ]; then
    say "skills: pulling $SKILLS_DIR"
    run git -C "$SKILLS_DIR" pull --ff-only
  elif [ -e "$SKILLS_DIR" ] && [ -n "$(ls -A "$SKILLS_DIR" 2>/dev/null || true)" ]; then
    say "skills: $SKILLS_DIR exists and is not a git checkout; pass --skills-dir" >&2
    return 1
  else
    say "skills: cloning $SKILLS_REPO into $SKILLS_DIR"
    run git clone "$SKILLS_REPO" "$SKILLS_DIR"
  fi
  say "skills: syncing symlinks"
  run python3 "$SKILLS_DIR/skills_manager.py" sync
}

label_of() {
  local root="$1"
  [ -n "$root" ] && [ -f "$root/src/version.js" ] || return 0
  [ -n "$NODE_BIN" ] || return 0
  "$NODE_BIN" -e '
    const v = require(process.argv[1]);
    process.stdout.write(v.label());
  ' "$root/src/version.js" 2>/dev/null || true
}

if [ "$DO_PLUGIN" = 1 ]; then update_plugin; fi
if [ "$DO_SKILLS" = 1 ]; then update_skills; fi

installed_root="$(plugin_info | cut -f2)"
[ -n "$installed_root" ] || installed_root="$ROOT"
label="$(label_of "$installed_root")"
if [ -n "$label" ]; then
  say ""
  say "this device: roostr $label"
else
  say ""
  say "this device: roostr $(sed -n 's/^version *= *"\(.*\)"/\1/p' "$installed_root/herdr-plugin.toml" 2>/dev/null || echo '?')"
fi
