# Report: pkg-ui-audit-fixes

- Owner: Pablo (`pablo`), branch `crew/pablo`
- Scope: `dashboard/src/{herdr,validate}.js`, `dashboard/public/control/{index.html,app.js}`, `dashboard/public/names/names.js`, `dashboard/test/{validate,app}.test.js`

## Changes Implemented

1. **`dashboard/src/validate.js`**
   - Tightened `PANE_ID_RE` to `/^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}:[A-Za-z0-9_-]{1,32}$/` so the workspace segment must start with `[A-Za-z0-9_]` and rejects leading `-` (such as `--help:p1`).
   - Updated `validatePaneLabel` to reject trimmed labels starting with `-` (`label cannot start with -`), preventing CLI flag injection (such as `--clear`) in `pane rename`.

2. **`dashboard/src/herdr.js`**
   - Updated `promptAgent` to trim `targetName`, reject empty or leading-`-` targets, and prefix leading `-` in `tv.value` with a single space before passing it to `herdr agent prompt`. Verified against the installed `herdr` binary that `herdr agent prompt` does not support `--` as an option terminator (`herdr agent prompt <target> -- <text>` fails with `unknown option`), whereas a leading space (`" -test"`) is accepted as `<TEXT>` without flag parsing.

3. **`dashboard/public/control/index.html`**
   - Added `<option value="codex">codex</option>` and `<option value="gemini">gemini</option>` to `<select id="start-agent-kind">` to match `ALLOWLIST_AGENT_KINDS` in `dashboard/src/validate.js`.

4. **`dashboard/public/control/app.js`**
   - Updated the `401` redirect in `apiFetch` to preserve `window.location.search` alongside `window.location.pathname` (`encodeURIComponent(window.location.pathname + (window.location.search || ''))`).

5. **`dashboard/public/names/names.js`**
   - Wrapped `orchBtn`, `form`, and `revertBtn` async handlers in `try/catch/finally`.
   - Displayed non-`unauthorized` errors via `showError(...)` instead of leaving unhandled promise rejections.
   - Disabled action buttons (`orchBtn`, `saveBtn`, `revertBtn`) while requests are in flight and re-enabled them in `finally`.

6. **`dashboard/test/validate.test.js` & `dashboard/test/app.test.js`**
   - Added unit tests for `validatePaneId` (rejecting `--help:p1`, `-w1:p1`; accepting `_w1:p1`) and `validatePaneLabel` (rejecting `-bad`, `--clear`, `  --clear  `).
   - Added HTTP/client tests in `app.test.js` for leading-`-` prompt prefixing (`--wait` -> ` --wait`), `--clear` label rejection (`400`), and `--help:p1` pane ID rejection (`400`).

## Verification

- `(cd dashboard && npm test)`: passed (25/25 tests, 9 suites, 0 failures).
- `env -u HERDR_ENV ./verify.sh`: exited 1 due to a pre-existing unrelated failure in `test/daemon.test.js` (`D3: executes 3 packages at 3 tiers matching crew-file tier table exactly`, `'fast' !== 'balanced'`). Syntax checks, manifest checks, zero-dependency audit, and public repo hygiene (no em dashes, no shell execution) all passed.

PABLO_DONE
