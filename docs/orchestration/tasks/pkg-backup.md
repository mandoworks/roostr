# pkg-backup: capture command, handoff pointers, stale sessions, user timer

## Goal

Improve the existing backup workflow in `src/backup.js` and add a user-level timer installer.

## 1. `roostr backups capture`

Extend `main(argv)` in `src/backup.js`:

```
roostr backups capture [--json] [--dir <backups dir>]
```

- Read the live snapshot with `require('./herdr').snapshot()`.
- Capture through the existing `capture({ snapshot })` path, the same one `src/respawn.js` uses.
- Save only when the layout changed compared with the newest saved version. Compare the stable fields: workspace id, tab order, split tree, pane ids, cwd, label, agent kind, session. Ignore timestamps.
- Print one line: `saved <workspace> v<n>` or `unchanged <workspace>`. `--json` prints `{ saved: [...], unchanged: [...] }`.
- A missing Herdr server is a clean error with a one-line message and exit code 1, not a stack trace.

## 2. Handoff pointer per agent pane

When capturing an agent pane, if `<pane cwd>/docs/orchestration/handoffs/latest-<slug>.md` exists, store its path as `handoff` on that pane record. Slug is the agent name lowercased with non alphanumerics collapsed to `-`. Do not read the brief contents. Missing file means no field.

## 3. Stale session refs

A pane that carries `agent.session` gets `sessionStale: true` when `require('./sessions').validSession(kind, session)` is false. Restore must skip stale session refs and still start the agent. The restore result already reports resumed sessions; keep that behavior and make the test cover a stale ref becoming a plain start.

## 4. Timer installer

Add `scripts/install-backup-timer.sh`:

- `--install` (default) writes `~/.config/systemd/user/roostr-backup.service` and `.timer`, every 5 minutes, `OnBootSec=2min`, runs `<roostr bin> backups capture`.
- `--uninstall` stops, disables and removes both units.
- Never uses sudo. `systemctl --user daemon-reload`, `enable --now`.
- Resolve the roostr binary from `ROOSTR_BIN`, then `command -v roostr`, then the repo's `bin/roostr`.
- Print the unit paths and the next trigger time.
- Must pass the repo hygiene rules: no machine paths, no private project names, no em dashes.

## Rules

- Keep the existing public behavior of `capture`, `saveBackups`, `restoreBackup` and their return shapes. Add fields, do not rename.
- Node 22 builtins only. No new dependencies. No em dashes in files.
- Do not edit `bin/roostr`. The orchestrator wires the dispatch line.

## Tests

Extend `test/backup.test.js`:

- unchanged layout is not saved twice.
- changed layout saves a new version.
- handoff pointer is recorded only when the file exists.
- stale session becomes a plain start and is not listed as resumed.
- existing tests still pass.

Run `node --test test/backup.test.js`.

## Report

Write `docs/orchestration/reports/pkg-backup.md` with changes, exact test result, and end with `BACKUP_DONE` or `BACKUP_BLOCKED: <reason>`.
