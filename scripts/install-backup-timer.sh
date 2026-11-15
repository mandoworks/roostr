#!/usr/bin/env bash
# Install or remove the systemd user timer for `roostr backups capture`.
set -euo pipefail

ACTION="install"
for arg in "$@"; do
  case "$arg" in
    --install) ACTION="install" ;;
    --uninstall) ACTION="uninstall" ;;
    -h|--help)
      echo "usage: install-backup-timer.sh [--install | --uninstall]"
      exit 0
      ;;
    *)
      echo "Error: unknown option $arg" >&2
      echo "usage: install-backup-timer.sh [--install | --uninstall]" >&2
      exit 2
      ;;
  esac
done

if ! command -v systemctl > /dev/null 2>&1; then
  echo "Error: systemctl is required to manage user timers." >&2
  exit 1
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_FILE="$UNIT_DIR/roostr-backup.service"
TIMER_FILE="$UNIT_DIR/roostr-backup.timer"

if [ "$ACTION" = "uninstall" ]; then
  systemctl --user disable --now roostr-backup.timer 2>/dev/null || true
  systemctl --user stop roostr-backup.service 2>/dev/null || true
  rm -f "$SERVICE_FILE" "$TIMER_FILE"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed:"
  echo "  $SERVICE_FILE"
  echo "  $TIMER_FILE"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN="${ROOSTR_BIN:-}"
if [ -z "$BIN" ]; then
  BIN="$(command -v roostr 2>/dev/null || true)"
fi
if [ -z "$BIN" ] && [ -x "$REPO_ROOT/bin/roostr" ]; then
  BIN="$REPO_ROOT/bin/roostr"
fi
if [ -z "$BIN" ]; then
  echo "Error: could not locate roostr binary (set ROOSTR_BIN or add roostr to PATH)" >&2
  exit 1
fi

mkdir -p "$UNIT_DIR"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Roostr workspace backup capture

[Service]
Type=oneshot
ExecStart="$BIN" backups capture
EOF

cat > "$TIMER_FILE" << 'EOF'
[Unit]
Description=Run Roostr workspace backup capture every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now roostr-backup.timer

echo "Installed:"
echo "  $SERVICE_FILE"
echo "  $TIMER_FILE"

NEXT="$(systemctl --user list-timers roostr-backup.timer --no-legend --no-pager 2>/dev/null | head -n1 || true)"
if [ -n "$NEXT" ]; then
  echo "Next trigger: $NEXT"
else
  echo "Next trigger: unavailable"
fi
