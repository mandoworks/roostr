# Task pkg-skill-docs: Sync roostr skill, schema reference, and dashboard README

- Owner: Ruben (`ruben`)
- Model / Effort: `gemini-4-hydrogen-low` (`low`, recommended by `roostr recommend` for `kind: docs`)
- Branch / Worktree: `crew/ruben` in `.worktrees/ruben`
- Report path: `docs/orchestration/reports/pkg-skill-docs.md` (end with `RUBEN_DONE` or `RUBEN_BLOCKED`)

## Context

`skills/roostr/SKILL.md` in this repo is behind newer orchestration rules (effort analysis before spawning, valid `tasks.json` kinds/statuses, tier-map config guidance, empirical outcome recording) and has drifted from current `bin/roostr` subcommands and flags (`roostr onboard`, `roostr workers`, `roostr handoff`, `roostr backup`, `roostr spawn` flags). Meanwhile `dashboard/` gained passkey-gated control actions (`/agents/api/pane/:id/rename`, `/agents/api/pane/:id/start`) and the Names manager (`/agents/names.html`, `/agents/api/names*`, `workers/workers.*.json`).

## Owned files (modify ONLY these)

- `skills/roostr/SKILL.md`
- `skills/roostr/references/schemas-and-config.md`
- `dashboard/README.md`
- `docs/orchestration/reports/pkg-skill-docs.md`

## Instructions

1. Inspect `bin/roostr`, `src/tasks.js` (accepted kinds/statuses), `src/report.js`, `src/onboard.js`, `dashboard/src/app.js`, and `test/skill.test.js` before editing. Also inspect `roostr spawn --help` / `roostr workers --help` / `roostr onboard --help`.
2. Update `skills/roostr/SKILL.md`:
   - Include `2b. Effort analysis before every spawn`, the six canonical `tasks.json` kinds (`docs`, `review`, `tests`, `tooling`, `complex`, `feature`) and valid statuses (`pending`, `working`, `done`, `blocked`), tier model config guidance, and outcome ledger instructions.
   - Fix inaccurate CLI flags in examples (for example replace stale `--kind surgical-code` with `feature` or `tooling`, and verify every `roostr spawn` and `roostr report` flag against `--help`).
   - Document `agy` Hydrogen usage (`--kind agy --pane "$PANE_ID" -- --model gemini-4-hydrogen-<low|medium|high|xhigh>`) and note context-reset differences if `agy` is started per-task.
   - Briefly document `roostr onboard`, `roostr workers`, `roostr handoff`, and `roostr backup` where operators/orchestrators use them.
   - Keep `test/skill.test.js` assertions satisfied (`--json`, `--all` board flags, `--pane`, `--task` report flags, valid `--` flags).
3. Update `skills/roostr/references/schemas-and-config.md`:
   - Align task-kind examples to `docs`, `review`, `tests`, `tooling`, `complex`, `feature` and fix the `max_reTRIES` casing typo if accurate against `src/crewfile.js` (verify in `src/crewfile.js` first!).
4. Update `dashboard/README.md`:
   - Document `/agents/names.html`, `GET /agents/api/names`, `POST /agents/api/names/override`, `POST /agents/api/names/orchestrator`, `POST /agents/api/names/revert`, `POST /agents/api/pane/:id/rename`, `POST /agents/api/pane/:id/start`, and dynamic `workers/workers.*.json` host discovery (`vps-43beb0ce` -> `ovh`, `muse` -> `muse`).
5. Never use em dash (`—`) or clause-dividing hyphens in prose (`./verify.sh` checks for em dashes). Never print or copy secrets. Do not commit or push.

## Verification (must run cleanly and record in report)

```bash
node --test test/skill.test.js
env -u HERDR_ENV ./verify.sh
```
