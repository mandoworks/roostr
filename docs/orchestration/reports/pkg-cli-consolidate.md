# Report: pkg-cli-consolidate

- Owner: Santiago (`santiago`), branch `crew/santiago`
- Status: Complete

## Changes

1. **Consolidated `~/.crew-board/` into `~/.roostr/` with idempotent migration**:
   - Added [`src/state-dir.js`](src/state-dir.js) (`roostrDir`, `legacyDir`, `migrateLegacyDir`, `resolvePath`) with zero external dependencies.
   - Updated [`src/config.js`](src/config.js), [`src/state.js`](src/state.js), [`src/sessions.js`](src/sessions.js), [`src/daemon.js`](src/daemon.js), [`src/ledger.js`](src/ledger.js), [`src/advisor.js`](src/advisor.js), [`src/backup.js`](src/backup.js), [`src/names.js`](src/names.js), [`src/pricing.js`](src/pricing.js), [`src/report.js`](src/report.js), and [`src/summary.js`](src/summary.js) to resolve all runtime state under `~/.roostr/` while respecting `ROOSTR_*`, `CREW_BOARD_*`, and `HOME` overrides.
   - `migrateLegacyDir` safely copies missing runtime files (`sessions.json`, `daemon-state.json`, `escalations.json`, `names.json`, `operator-hold.json`, `orchestration.jsonl`, `transitions.jsonl`, `config.json`, `summary.json`, `usage.jsonl`, `models.json`, `prices.json`) and directories (`backups/`, `state/`) from `~/.crew-board/` into `~/.roostr/` without overwriting existing files in `~/.roostr/`.
   - Isolated [`test/daemon.test.js`](test/daemon.test.js) from real home state via `ROOSTR_*` temp paths.
   - Added [`test/state-dir.test.js`](test/state-dir.test.js).

2. **Fixed `roostr spawn` vs `roostr outcome` mismatch**:
   - Fixed `runId` extraction in `executeSpawn` in [`src/orchestrator.js`](src/orchestrator.js) to handle both `{ entry: { runId } }` from `ledger.spawn` and `{ runId }`.
   - Updated `mainSpawn` usage help in [`src/orchestrator.js`](src/orchestrator.js) to include `[--pane <id>]` and `[--json]`.
   - Added `--json` support to `spawn` and `outcome` in [`src/ledger.js`](src/ledger.js) and exposed `roostr ledger` subcommand routing in [`bin/roostr`](bin/roostr).
   - Added tests in [`test/cli.test.js`](test/cli.test.js) and [`test/orchestrator.test.js`](test/orchestrator.test.js).

3. **Fixed `roostr name --json`**:
   - Updated `parseArgs` and `main` in [`src/names.js`](src/names.js) so `--json` outputs `{ version: 1, language, names }` for normal name draws while keeping newline-delimited plain text as the default.
   - Added CLI `--json` test in [`test/names.test.js`](test/names.test.js).

## Verification

Ran `env -u HERDR_ENV ./verify.sh` synchronously:
- Exit code: `0` (`ALL CHECKS PASSED`)
- All syntax checks, `node --test` unit tests, manifest checks, zero-dependency audit, and public repo hygiene checks passed.

SANTIAGO_DONE
