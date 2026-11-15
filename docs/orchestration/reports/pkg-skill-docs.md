# Report: pkg-skill-docs

- **Worker**: Ruben (`ruben`)
- **Branch / Worktree**: `crew/ruben` in `.worktrees/ruben`
- **Files Changed**:
  - `skills/roostr/SKILL.md`
  - `skills/roostr/references/schemas-and-config.md`
  - `dashboard/README.md`
  - `docs/orchestration/reports/pkg-skill-docs.md`

## Summary of Changes

1. **`skills/roostr/SKILL.md`**:
   - Added `2b. Effort analysis before every spawn` with canonical tier mappings matching `src/advisor.js` (`fast`/`low`: `docs`; `balanced`/`medium`: `review`, `tests`, `tooling`, `feature`; `reasoning`/`high`: `complex`).
   - Updated `tasks.json` kinds to the 6 canonical kinds (`docs`, `review`, `tests`, `tooling`, `complex`, `feature`) and valid statuses (`pending`, `working`, `done`, `blocked`).
   - Replaced stale `--kind surgical-code` examples with `tooling` and `feature`, and noted that `roostr spawn` currently dispatches `orchestrator.spawn` rather than `ledger.spawn`.
   - Documented `agy` Hydrogen usage (`--kind agy --pane "$PANE_ID" -- --model gemini-4-hydrogen-<low|medium|high|xhigh>`) and per-task session reset behavior.
   - Documented `roostr onboard` (PioRelay seat/card/optional webhook/announce, MuseSight bank, 5 canonical pages, smoke retain/recall), `roostr workers`, `roostr handoff`, and `roostr backups`.

2. **`skills/roostr/references/schemas-and-config.md`**:
   - Fixed `max_reTRIES = 2` to `max_retries = 2`.
   - Aligned task-kind examples and the `Valid Task Kinds` table to the 6 canonical kinds (`docs`, `review`, `tests`, `tooling`, `complex`, `feature`) with `review` and `tests` set to `medium` / `balanced` per `src/advisor.js`.

3. **`dashboard/README.md`**:
   - Documented `/agents/names.html`, `GET /agents/api/names`, `POST /agents/api/names/override`, `POST /agents/api/names/orchestrator`, `POST /agents/api/names/revert`, `POST /agents/api/pane/:id/rename`, `POST /agents/api/pane/:id/start`, and dynamic `workers/workers.*.json` host discovery (`vps-43beb0ce` -> `ovh`, `muse` -> `muse`).

## Verification

- `node --test test/skill.test.js`: PASS (3/3 tests)
- `env -u HERDR_ENV ./verify.sh`: PASS (exit 0, all checks passed)

RUBEN_DONE
