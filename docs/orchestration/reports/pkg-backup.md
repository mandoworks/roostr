# pkg-backup report

## Changes

- `src/backup.js`:
  - Completed `main(argv)` support for `roostr backups capture [--json] [--dir <dir>]`: reads live snapshot via `herdr.snapshot()`, runs `capture({ snapshot })` and `saveCaptures()`, prints `saved <workspace> v<n>` or `unchanged <workspace>` (or `{ saved, unchanged }` with `--json`), and handles Herdr failures with a one-line stderr error and exit code 1 via `herdrError()`.
  - Verified handoff pointer capture (`handoffPath()`): records `pane.handoff` when `<cwd>/docs/orchestration/handoffs/latest-<slug>.md` exists without reading its contents, and omits the field when missing.
  - Verified stale session handling: `capture()` sets `agent.sessionStale = true` when `sessions.validSession(kind, session)` is false; `restoreBackup()` skips `sessionStale` or invalid sessions during resolution and start so the agent opens as a plain start and is not listed in `sessions`.
  - Exported `saveCaptures` from `src/backup.js`.
- `scripts/install-backup-timer.sh`:
  - Added systemd user timer installer (`--install` default, `--uninstall`, `-h`/`--help`).
  - Resolves binary from `ROOSTR_BIN`, `command -v roostr`, then repo `bin/roostr`.
  - Writes `~/.config/systemd/user/roostr-backup.service` and `roostr-backup.timer` (`OnBootSec=2min`, `OnUnitActiveSec=5min`), runs `systemctl --user daemon-reload` and `enable --now` without `sudo`, and prints unit paths and next trigger time.
- `test/backup.test.js`:
  - Added 4 tests covering `main(['capture'])` (unchanged vs changed layout, `--json`, missing Herdr server exit code 1), handoff pointer presence/absence, and stale session becoming a plain start.

## Verification

- `node --test test/backup.test.js`: 19 passed, 0 failed (`pass 19`, `fail 0`).
- `bash -n scripts/install-backup-timer.sh`: exited 0.
- `bin/roostr`: untouched.

BACKUP_DONE
