# Task pkg-cli-consolidate

- Owner: Santiago (`santiago`), `gemini-4-hydrogen-medium`, branch `crew/santiago`
- Report: `docs/orchestration/reports/pkg-cli-consolidate.md` ending with `SANTIAGO_DONE` or `SANTIAGO_BLOCKED`

## Scope (touch ONLY `bin/roostr`, `src/**`, `test/**`, and your report)

1. **Consolidate `~/.crew-board/` into `~/.roostr/`**:
   - Inspect every reference to `.crew-board` in `src/` (`src/config.js`, `src/ledger.js`, `src/advisor.js`, `src/backup.js`, `src/sessions.js`, `src/experiential.js`, `src/state.js`, `src/codex.js`, `src/names.js`, `src/daemon.js`, `src/board.js`, etc.).
   - Make `~/.roostr/` the single canonical state directory for all runtime files (`sessions.json`, `daemon-state.json`, `escalations.json`, `names.json`, `operator-hold.json`, `orchestration.jsonl`, `transitions.jsonl`, `backups/`, `state/`, `config.json`, `summary.json`, `usage.jsonl`).
   - Add a small idempotent migration helper (for example in `src/config.js` or a new shared `src/state-dir.js`, zero external deps) that safely migrates missing files/dirs from legacy `~/.crew-board/` into `~/.roostr/` when `~/.roostr/` is active (never overwriting newer existing `~/.roostr/` files, and respecting `CREW_BOARD_*` / `ROOSTR_*` / `HOME` overrides so tests stay 100% isolated in temp dirs). Check existing tests first so no test breaks!
2. **Fix `roostr spawn` vs `roostr outcome` mismatch**:
   - Currently `bin/roostr` routes `spawn` to `src/orchestrator.js` (`mainSpawn`), whereas `roostr outcome` reads spawn entries created by `src/ledger.js` (`spawn(...)`).
   - When `roostr spawn --pane <id> --task ...` runs (or via a non-breaking mode in `src/orchestrator.js` / `bin/roostr`), support recording/printing a ledger `runId` or expose `roostr ledger spawn` / `--pane` support cleanly without breaking any existing `orchestrator.test.js`, `cli.test.js`, or `ledger.test.js` assertions. Keep `spawn` help accurate.
3. **Fix `roostr name --json`**:
   - Inspect `src/names.js` and `test/names.test.js`: `roostr name --language es --count 2 --json` currently prints plain newline text instead of JSON. Fix `--json` output (and update/add tests in `test/names.test.js` cleanly while keeping plain text default unchanged).
4. **Tests & rules**:
   - Keep zero npm dependencies (`./verify.sh` rejects external `require`).
   - No em dashes (`—`) anywhere. Run commands synchronously and do NOT end turn until `env -u HERDR_ENV ./verify.sh` exits 0 and your report is written. Do not commit or push.

## Verification
```bash
env -u HERDR_ENV ./verify.sh
```
