# Orchestration plan: Roostr skill sync and onboarding/dashboard hardening

Two parallel Hydrogen (`agy`) packages in workspace `w27` following `skills/roostr/SKILL.md`.

## Goal and done check

1. Sync `skills/roostr/SKILL.md`, `skills/roostr/references/schemas-and-config.md`, and `dashboard/README.md` with current CLI commands, dashboard routes, valid task kinds (`docs|review|tests|tooling|complex|feature`), and `agy` Hydrogen usage.
2. Fix the live `src/onboard.js` bugs caught on OVH (`kind: 'note'` rejected with HTTP 400 by PioRelay; bare `"fetch failed"` missing URL context), audit the recent `dashboard/` and `onboard.js` changes, and expand regression tests.
3. Done check: both worktree branches pass `env -u HERDR_ENV ./verify.sh` and `cd dashboard && npm test`, reports end with `RUBEN_DONE` / `ENRIQUE_DONE`, and changes merge cleanly to `main`.

## Constraints and routing rationale

- Engine requested: `agy` running Hydrogen at task-appropriate levels.
- `pkg-skill-docs` (`kind: docs`): `roostr recommend` selects `fast` tier / `low` effort. Run on `gemini-4-hydrogen-low` (`--model gemini-4-hydrogen-low`).
- `pkg-onboard-hardening` (`kind: tests`): `roostr summary` reports 25% first-try pass rate across 4 runs for `tests`, and the package combines bugfixes, review, and test expansion. Escalated to `gemini-4-hydrogen-high` (`--model gemini-4-hydrogen-high`).
- File ownership (`owns`) is strictly disjoint between packages.
- Non-goals: no OVH deploys, no edits to `PLAN.md` or `scripts/update.sh`, no items 7 to 9 from pending Roman grill.
