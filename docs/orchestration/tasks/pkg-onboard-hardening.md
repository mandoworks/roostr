# Task pkg-onboard-hardening: Fix onboard bugs, audit recent changes, and expand tests

- Owner: Enrique (`enrique`)
- Model / Effort: `gemini-4-hydrogen-high` (`high`, escalated from `tests` baseline 25% pass rate across 4 runs in `roostr summary`)
- Branch / Worktree: `crew/enrique` in `.worktrees/enrique`
- Report path: `docs/orchestration/reports/pkg-onboard-hardening.md` (end with `ENRIQUE_DONE` or `ENRIQUE_BLOCKED`)

## Context

Two issues appeared during the live `roosty` onboarding run on OVH:
1. `src/onboard.js` sends `kind: 'note'` to PioRelay `POST /agent-messages`, which PioRelay rejects with HTTP `400` (`Invalid kind: task | report | question | done | decision.`).
2. `httpJson` in `src/onboard.js` lets raw `fetch()` network failures bubble as `"fetch failed"` without the method/URL or underlying `err.cause` code.

## Owned files (modify ONLY these)

- `src/onboard.js`
- `test/onboard.test.js`
- `dashboard/src/names.js`
- `dashboard/test/names.test.js`
- `dashboard/test/app.test.js`
- `dashboard/test/validate.test.js`
- `docs/orchestration/reports/pkg-onboard-hardening.md`

(If you inspect non-owned files such as `dashboard/src/app.js`, `dashboard/src/validate.js`, `dashboard/public/*`, `src/orchestrator.js` and find any issue outside your owned files, document it in your report under Findings instead of editing outside `owns`.)

## Instructions

1. Fix `src/onboard.js`:
   - Change the PioRelay announcement payload from `kind: 'note'` to `kind: 'report'`.
   - Wrap network throws inside `httpJson` so errors include `${method} ${url}` and cause code/message if present (`err.cause?.code || err.cause?.message`), without leaking any secret headers/tokens.
   - Check `--capabilities`, `--host`, `--dry-run`, `shouldAutoOnboard`, and error propagation for any subtle edge case and fix if needed.
2. Audit `dashboard/src/names.js` (corrupt JSON recovery, atomic temp write cleanup on error, host staleness boundary around `STALE_WORKER_SECONDS`, history cap/revert edge cases, `sourceName` precedence when `names.json` vs `data.json`/`status.json` disagree) and fix any genuine bug in `dashboard/src/names.js`.
3. Audit `dashboard/src/app.js`, `dashboard/src/herdr.js`, `dashboard/src/validate.js`, `dashboard/public/control/*`, `dashboard/public/names/*` read-only and list any verified issues or risks in your report.
4. Expand unit tests:
   - `test/onboard.test.js`: assert announcement uses `kind: 'report'`, test `httpJson` / `runOnboard` network error formatting preserves URL + cause without leaking headers, test partial failure handling.
   - `dashboard/test/names.test.js`: test corrupt `names.json` recovery, empty/whitespace clear override behavior, host stale boundary (>90s vs <=90s), and revert history edge cases.
   - `dashboard/test/validate.test.js` & `dashboard/test/app.test.js`: cover missing edge cases on `rename`/`start`/names API validation (`400`/`403`/CSRF/bad JSON).
5. Never use em dash (`—`) characters anywhere (`./verify.sh` fails on em dashes). Never print secrets. Do not commit or push.

## Verification (must run cleanly and record in report)

```bash
env -u HERDR_ENV ./verify.sh
(cd dashboard && npm test)
```
