# Orchestration plan: OVH batch for state consolidation, UI hardening, and skill sync

Three parallel Hydrogen (`agy`) workers + OVH lead (`roosty-argon`) in `/home/ubuntu/workspace/roostr`.

## Goal and done check

1. Consolidate `~/.crew-board/` into `~/.roostr/` across `src/` with idempotent legacy migration, fix `roostr spawn` vs `roostr outcome` ledger linkage, and fix `roostr name --json` JSON output.
2. Fix the 4 remaining audit findings in `dashboard/` (`herdr.js`/`validate.js`, control `start-agent-kind` dropdown + 401 query redirect, `names.js` error/disable UX) + tests.
3. Update `skills/roostr/SKILL.md` (superseding `crew-board`, documenting `~/.roostr/` layout and `agy` trust/wait rules), mirror to `/home/ubuntu/workspace/skills-repo/roostr/`, and run `skills_manager.py sync`.
4. Done check: all 3 branches pass `env -u HERDR_ENV ./verify.sh` and `(cd dashboard && npm test)` cleanly, merge into `main`, deploy updated `dashboard/` to `/home/ubuntu/roostr-dashboard` and restart `roostr-dashboard.service`, and report completion to `roman` on PioRelay + retain in MuseSight `coding-agent::roostr`.

## Routing rationale

- `pkg-cli-consolidate` (`santiago`, `feature`, `gemini-4-hydrogen-medium`): multi-module state path refactoring + CLI flag/ledger contracts.
- `pkg-ui-audit-fixes` (`pablo`, `feature`, `gemini-4-hydrogen-medium`): targeted security/UI fixes and dashboard unit tests.
- `pkg-skill-sync` (`joaquin`, `docs`, `gemini-4-hydrogen-low`): skill documentation and sync.
