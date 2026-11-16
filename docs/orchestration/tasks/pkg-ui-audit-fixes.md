# Task pkg-ui-audit-fixes

- Owner: Pablo (`pablo`), `gemini-4-hydrogen-medium`, branch `crew/pablo`
- Report: `docs/orchestration/reports/pkg-ui-audit-fixes.md` ending with `PABLO_DONE` or `PABLO_BLOCKED`

## Scope (touch ONLY `dashboard/src/{herdr,validate}.js`, `dashboard/public/control/{index.html,app.js}`, `dashboard/public/names/names.js`, `dashboard/test/{validate,app}.test.js`, and your report)

1. **`dashboard/src/validate.js` & `dashboard/src/herdr.js`**:
   - Tighten `PANE_ID_RE` in `dashboard/src/validate.js` so the workspace segment must start with `[A-Za-z0-9_]` (rejecting leading `-` like `--help:p1`).
   - Guard `renamePane` and `promptAgent` in `dashboard/src/herdr.js` against CLI flag injection cleanly (reject labels starting with `-` in `validatePaneLabel`, or insert `--` before `tv.value`/`lv.value` and update mock argv assertions in `dashboard/test/app.test.js`). Verify `herdr` supports what you emit and `npm test` passes.
2. **`dashboard/public/control/index.html`**:
   - Add `<option value="codex">codex</option>` and `<option value="gemini">gemini</option>` to `<select id="start-agent-kind">` so it matches `ALLOWLIST_AGENT_KINDS` in `dashboard/src/validate.js`.
3. **`dashboard/public/control/app.js`**:
   - On `401` redirect to `/agents/auth/login?next=...`, preserve `window.location.search` alongside `window.location.pathname`.
4. **`dashboard/public/names/names.js`**:
   - Wrap click/submit `apiFetch(...)` calls (`orchBtn`, `form`, `revertBtn`) in `try/catch` (displaying errors visibly in status/alert text rather than unhandled promise rejections) and disable buttons while requests are in flight.
5. **Expand tests & rules**:
   - Update `dashboard/test/validate.test.js` and `dashboard/test/app.test.js` for the tightened validations.
   - No em dashes (`—`) anywhere. Run tests synchronously and do NOT end turn until `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` finish with exit 0 and your report is written. Do not commit or push.

## Verification
```bash
(cd dashboard && npm test)
env -u HERDR_ENV ./verify.sh
```
