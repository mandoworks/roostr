#!/usr/bin/env bash
# Roostr 1-liner installer: installs plugin in Herdr, links CLI, and sets up keybindings.
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[32m'
RESET='\033[0m'

echo -e "${BOLD}🐓 Installing Roostr...${RESET}"

# 1. Check prerequisites
if ! command -v node > /dev/null 2>&1; then
  echo "Error: Node.js (v22 or newer) is required to run Roostr."
  exit 1
fi

if ! command -v herdr > /dev/null 2>&1; then
  echo "Warning: Herdr CLI not found on PATH. Install Herdr from https://herdr.dev"
fi

# 2. Install Herdr plugin
if command -v herdr > /dev/null 2>&1; then
  echo "   installing Herdr plugin..."
  herdr plugin install mandoworks/roostr 2>/dev/null || herdr plugin enable roostr 2>/dev/null || true
fi

# 3. Locate plugin root and link CLI
PLUGIN_ROOT=""
if command -v herdr > /dev/null 2>&1; then
  PLUGIN_ROOT="$(herdr plugin list --json 2>/dev/null | node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const p = (d.result && d.result.plugins || []).find((x) => x.plugin_id === "roostr");
      if (p && p.plugin_root) process.stdout.write(p.plugin_root);
    } catch (e) {}
  ' 2>/dev/null || true)"
fi

if [ -n "$PLUGIN_ROOT" ] && [ -f "$PLUGIN_ROOT/bin/roostr" ]; then
  mkdir -p "$HOME/.local/bin"
  ln -sf "$PLUGIN_ROOT/bin/roostr" "$HOME/.local/bin/roostr"
  ln -sf "$PLUGIN_ROOT/bin/roostr" "$HOME/.local/bin/crew-board"
  echo "   linked CLI to ~/.local/bin/roostr"
fi

# 4. Configure Herdr keybindings in ~/.config/herdr/config.toml
HERDR_CONFIG="$HOME/.config/herdr/config.toml"
if [ -f "$HERDR_CONFIG" ]; then
  if ! grep -q "roostr.toggle-board" "$HERDR_CONFIG"; then
    echo "   adding keybinding prefix+b to $HERDR_CONFIG..."
    cat <<'TOML' >> "$HERDR_CONFIG"

# roostr: toggle live board split beside your work.
[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "roostr.toggle-board"
description = "roostr: toggle live board split"

# roostr: popup the board over the current tab.
[[keys.command]]
key = "prefix+B"
type = "plugin_action"
command = "roostr.popup-board"
description = "roostr: popup board overlay"
TOML
    if command -v herdr > /dev/null 2>&1; then
      herdr server reload-config > /dev/null 2>&1 || true
    fi
  fi
fi

echo ""
echo -e "${GREEN}${BOLD}✔ Roostr successfully installed!${RESET}"
echo ""
echo "How to use:"
echo "  1. In any terminal pane, run 'roostr' to turn that pane into the live board."
echo "  2. Or press prefix + r in Herdr to toggle the split board."
echo "  3. From agent statuslines, report exact metrics via 'roostr report'."
echo ""
