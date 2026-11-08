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

# 2. Install Herdr plugin if Herdr is present
if command -v herdr > /dev/null 2>&1; then
  echo "   installing Herdr plugin..."
  herdr plugin install mandoworks/roostr -y 2>/dev/null || herdr plugin enable roostr 2>/dev/null || true
fi

# 3. Locate plugin root or download release fallback
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

INSTALL_DIR="$HOME/.local/share/roostr"
if [ -z "$PLUGIN_ROOT" ] || [ ! -f "$PLUGIN_ROOT/bin/roostr" ]; then
  echo "   downloading Roostr v0.2.0 release..."
  mkdir -p "$INSTALL_DIR"
  curl -fsSL "https://github.com/mandoworks/roostr/releases/download/v0.2.0/roostr-v0.2.0.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1
  PLUGIN_ROOT="$INSTALL_DIR"
fi

# 4. Link CLI to PATH
mkdir -p "$HOME/.local/bin"
ln -sf "$PLUGIN_ROOT/bin/roostr" "$HOME/.local/bin/roostr"
ln -sf "$PLUGIN_ROOT/bin/roostr" "$HOME/.local/bin/crew-board"
chmod +x "$PLUGIN_ROOT/bin/roostr"
echo "   linked CLI to ~/.local/bin/roostr"

# Try linking to /usr/local/bin if writable
LINKED_GLOBAL=false
if [ -w /usr/local/bin ]; then
  ln -sf "$PLUGIN_ROOT/bin/roostr" /usr/local/bin/roostr 2>/dev/null && LINKED_GLOBAL=true || true
  ln -sf "$PLUGIN_ROOT/bin/roostr" /usr/local/bin/crew-board 2>/dev/null || true
fi

# 5. Check if ~/.local/bin is in PATH
PATH_NEEDS_UPDATE=false
case ":$PATH:" in
  *":$HOME/.local/bin:"*) ;;
  *)
    if [ "$LINKED_GLOBAL" = false ]; then
      PATH_NEEDS_UPDATE=true
      if [ -f "$HOME/.bashrc" ] && ! grep -q '\.local/bin' "$HOME/.bashrc"; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
      fi
      if [ -f "$HOME/.zshrc" ] && ! grep -q '\.local/bin' "$HOME/.zshrc"; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
      fi
      if [ -f "$HOME/.profile" ] && ! grep -q '\.local/bin' "$HOME/.profile"; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"
      fi
    fi
    ;;
esac

# 6. Configure Herdr keybindings in ~/.config/herdr/config.toml
HERDR_CONFIG="$HOME/.config/herdr/config.toml"
if [ -f "$HERDR_CONFIG" ]; then
  if ! grep -q "roostr.toggle-board" "$HERDR_CONFIG"; then
    echo "   adding keybinding prefix+r to $HERDR_CONFIG..."
    cat >> "$HERDR_CONFIG" << 'TOML'

# roostr: toggle the live agent board
[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "roostr.toggle-board"
description = "roostr: toggle live agent board"

[[keys.command]]
key = "prefix+R"
type = "plugin_action"
command = "roostr.toggle-board"
description = "roostr: toggle live agent board"
TOML
    if command -v herdr > /dev/null 2>&1; then
      herdr server reload-config > /dev/null 2>&1 || true
    fi
  fi
fi

echo ""
echo -e "${GREEN}${BOLD}✔ Roostr successfully installed!${RESET}"
echo ""
if [ "$PATH_NEEDS_UPDATE" = true ]; then
  echo "Notice: ~/.local/bin was added to your shell profile."
  echo "To use roostr in this current terminal session, run:"
  echo -e "  ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}"
  echo ""
fi
echo "How to use:"
echo "  1. In any terminal pane, run 'roostr' to open the live board."
echo "  2. Or press prefix + r in Herdr to toggle the split board."
echo "  3. From agent statuslines, report exact metrics via 'roostr report'."
echo ""
