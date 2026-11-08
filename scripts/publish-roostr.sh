#!/usr/bin/env bash
# publish-roostr.sh: clean export from private crew-board to public roostr repo.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="${1:-$(cd "$SOURCE_ROOT/../roostr" 2>/dev/null && pwd || echo "$SOURCE_ROOT/../roostr")}"

echo "== Exporting Roostr from $SOURCE_ROOT to $TARGET_DIR =="

if [ ! -d "$TARGET_DIR" ]; then
  mkdir -p "$TARGET_DIR"
fi

# Allowlist of files and folders to export
ALLOWLIST=(
  "bin"
  "src"
  "scripts"
  "test"
  "integrations"
  "examples"
  "skills"
  "templates"
  "web"
  "herdr-plugin.toml"
  "README.md"
  "CHANGELOG.md"
  "CONTRIBUTING.md"
  "docs/roadmap.md"
  "docs/reference.md"
  "LICENSE"
  "verify.sh"
  "verify-linux.sh"
  ".gitignore"
)

# Sync allowlisted paths
for item in "${ALLOWLIST[@]}"; do
  if [ -e "$SOURCE_ROOT/$item" ]; then
    echo "   copying $item..."
    if [ -d "$SOURCE_ROOT/$item" ]; then
      mkdir -p "$TARGET_DIR/$item"
      rsync -av --delete \
        --exclude '.DS_Store' \
        --exclude '.scratch-*' \
        --exclude '*.bak' \
        "$SOURCE_ROOT/$item/" "$TARGET_DIR/$item/"
    else
      cp -p "$SOURCE_ROOT/$item" "$TARGET_DIR/$item"
    fi
  fi
done

# Copy .github if exists
if [ -d "$SOURCE_ROOT/.github" ]; then
  echo "   copying .github..."
  mkdir -p "$TARGET_DIR/.github"
  rsync -av --delete --exclude '.DS_Store' "$SOURCE_ROOT/.github/" "$TARGET_DIR/.github/"
fi

# Ensure executable bits
chmod +x "$TARGET_DIR/bin/roostr" "$TARGET_DIR/verify.sh" "$TARGET_DIR/verify-linux.sh" "$TARGET_DIR/scripts/install.sh"
if [ -f "$TARGET_DIR/bin/crew-board" ]; then
  chmod +x "$TARGET_DIR/bin/crew-board"
fi

# Ensure docs/reference.md exists if needed
if [ -f "$SOURCE_ROOT/docs/reference.md" ] && [ ! -e "$TARGET_DIR/docs/reference.md" ]; then
  mkdir -p "$TARGET_DIR/docs"
  cp -p "$SOURCE_ROOT/docs/reference.md" "$TARGET_DIR/docs/reference.md"
fi

echo ""
echo "== Running verify.sh --public in $TARGET_DIR =="
cd "$TARGET_DIR"
./verify.sh --public

echo ""
echo "== Clean export complete and verified! =="
echo "Destination: $TARGET_DIR"
