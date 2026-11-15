# pkg-workers report

## Changes

- Added `src/workers.js` exporting `buildSnapshot(model, { host, now })`, `writeSnapshot(snapshot, dir)`, and `main(argv)` (plus helpers `sanitizeHost`, `validateHost`, `truncateTask`, `parseArgs`, `USAGE`).
  - Reads live Herdr snapshots via `herdr.snapshot()` and per-pane reports via `report.readReport()`, without reading pane screens or guessing unknown fields (`null` when absent).
  - Resolves fields using report first, then snapshot, matching board conventions, keeps `state` as `agent_status` verbatim, truncates `task` over 160 characters with `…`, and sorts workers deterministically by `workspace` then `pane_id`.
  - Sanitizes `os.hostname()` to `^[a-z0-9][a-z0-9.-]{0,62}$` when `--host` is omitted, and rejects invalid `--host` values.
  - Writes `<out>/workers.<host>.json` atomically via temp file + `chmod 0644` + `renameSync`, or prints JSON to stdout with `--json`.
  - Uses `ROOSTR_WORKERS_DIR` when `--out` is omitted, and exits with code 2 and a one-line error when no output directory is provided without `--json`.
- Added `test/workers.test.js` using `node:test` and injected snapshots/reports (no Herdr calls) covering:
  - one entry per agent pane, skipping non-agent panes, and `null` for unknown fields
  - 160-character task truncation with ellipsis character
  - stable sorting and stable JSON serialization
  - atomic write with mode 0644 and no leftover temp file
  - host sanitizing and invalid host rejection
  - missing output dir error, `--json` without `--out`, and `ROOSTR_WORKERS_DIR` fallback
- Left `bin/roostr` untouched.

## Verification

- `node --check src/workers.js && node --check test/workers.test.js && node --test test/workers.test.js`
  - Result: exit code 0, 6/6 tests passed (`duration_ms 595.455166`).
- Zero-dependency check on `src/workers.js` and `test/workers.test.js`: passed (`deps ok`).

WORKERS_DONE
