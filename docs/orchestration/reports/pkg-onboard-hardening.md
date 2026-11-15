# pkg-onboard-hardening report

- Owner: Enrique (`enrique`)
- Branch / Worktree: `crew/enrique` in `.worktrees/enrique`
- Task: [pkg-onboard-hardening.md](../tasks/pkg-onboard-hardening.md)

## Changes implemented

### `src/onboard.js`
- Changed PioRelay board announcement `kind` from `'note'` to `'report'` in `runOnboard` (`POST /agent-messages`).
- Wrapped `fetchFn(...)` and `res.text()` inside `httpJson` so network and stream errors throw a wrapped `Error` formatted as `${verb} ${url} failed: ${baseMsg}` with `(${causeCodeOrMessage})` appended when present, preserving `{ cause: err }` without including request headers, tokens, or request bodies. Exported `httpJson` for direct unit testing.
- Fixed `--capabilities` handling in `parseArgs` and `runOnboard` so repeated `--capabilities` flags append values and comma-separated string inputs are normalized, falling back to `['orchestrate', 'build']` when empty.
- Fixed `--host` handling so whitespace-only values fall back to `os.hostname()` rather than `'unknown'`.
- Trimmed `relayUrl`, `musesightUrl`, `statusUrl`, `webhookUrl`, and `adminToken` so whitespace-only strings do not masquerade as configured endpoints or introduce header newlines.
- Added `status: statusUrl ? 'planned' : 'skipped'` to `steps` in `--dry-run` output to match `plan.statusConfigured` and live execution.
- Updated `shouldAutoOnboard` to respect explicit `opts.onboard === false`, guard against `null` options/env, and treat whitespace-only `ROOSTR_RELAY_URL` / `ROOSTR_MUSESIGHT_URL` as unconfigured.

### `dashboard/src/names.js`
- Hardened `normalizeNamesDoc` to reject array entries in `overrides` and `history`, and skip override entries containing disallowed control characters (`SINGLE_LINE_CONTROL_RE`).
- Added a random suffix to temporary filenames in `writeJsonAtomic` to prevent collisions across rapid same-millisecond writes while preserving `unlinkSync` cleanup on error.
- Updated `readWorkerHosts` to fall back to the filename when `doc.host` is empty/whitespace and to filter non-object/array elements from `doc.workers`.
- Fixed `collectEligibleSlugs` so `statusDoc.agents` rejects arrays and `namesDoc.overrides` passes `null` for `sourceName`, keeping `sourceName` precedence strictly `data.json` (`roster`) > `status.json` (`announce`) > `roostr.json` (`roostr`) without override self-attribution.
- Fixed `revertHistory` to skip entries already referenced by an `override.revert` entry's `reverted_id` when auto-reverting (`historyId` omitted), return `409` if an explicit `historyId` was already reverted, validate `target.slug` against `SLUG_RE`, and sanitize `target.prev_name` before restoring.

### Tests expanded
- `test/onboard.test.js`: Added assertions for `kind: 'report'` on `/agent-messages`, direct `httpJson` and `runOnboard` network error formatting (`${method} ${url}` + cause code/message with zero secret/header leakage), `res.text()` failure handling, partial HTTP failure aggregation (`409` vs `502` pages, missing admin token, empty recall, HTTP `500`/`400`), `--capabilities` / `--host` / `--dry-run` edge cases, `shouldAutoOnboard` edge cases, and CLI error exit code `1`.
- `dashboard/test/names.test.js`: Added tests for corrupt `names.json` recovery and malformed root/field normalization, atomic temp file cleanup when `renameSync` fails, `STALE_WORKER_SECONDS` boundary (`<= 90` fresh vs `> 90` stale vs missing epoch), empty/whitespace override clearing, consecutive revert chain and `409`/`404` responses, `MAX_HISTORY` (`200`) cap, and `sourceName` precedence (`data.json` > `status.json` > `roostr.json`, `null` for override-only slugs).
- `dashboard/test/validate.test.js`: Expanded boundary coverage for `validateKeys`, `validatePrompt`, `validateLines`, `resolveStaticPath`, `validatePaneLabel`, `validateAgentName`, and all 6 `ALLOWLIST_AGENT_KINDS` (`claude`, `opencode`, `kilo`, `agy`, `codex`, `gemini`).
- `dashboard/test/app.test.js`: Added integration tests for CSRF/Origin rejections (`403`) on `rename`, `start`, and `names/*` endpoints, malformed/non-object/oversized JSON (`400`/`413`), `rename` and `start` validation and Herdr `502` propagation, and authenticated/unauthenticated `/agents/api/names*` and `/agents/names.html` edge cases (`400`/`401`/`404`/`409`).

## Findings (read-only audit of non-owned files)

1. **`dashboard/src/herdr.js` (`promptAgent`, `renamePane`)**: Neither `promptAgent` (line 150) nor `renamePane` (line 166) inserts `--` before positional arguments (`tv.value` and `lv.value`). In particular, `renamePane` passes `lv.value` directly, so a label value of `"--clear"` passes `validatePaneLabel` and executes `herdr pane rename <paneId> --clear` (clearing the label instead of setting it), and prompts/labels starting with `-` can be parsed as CLI flags by `herdr`.
2. **`dashboard/src/app.js` (`POST /agents/api/names/orchestrator`, line 451)**: `Boolean(body.enabled)` coerces string `"false"` to `true` and missing `undefined` to `false` instead of rejecting non-boolean `enabled` values with `400`.
3. **`dashboard/src/app.js` (`safeNextPath`, lines 178-184)**: Rejects paths not starting with `/agents/` or starting with `//`, but does not reject CR/LF (`\r`/`\n`) or backslashes (`\`). Passing `%0d%0a` in `?next=/agents/...` causes `res.setHeader('Location', location)` to throw `ERR_INVALID_CHAR`, turning the redirect into a `500` response.
4. **`dashboard/src/app.js` (`POST /agents/api/names/override`, line 438)**: Audit summary logs `name=${body.name || '(cleared)'}`, so whitespace-only names (e.g. `'   '`) clear the override via `namesStore.setOverride` but record blank `name=   ` in `audit.jsonl` instead of `(cleared)`.
5. **`dashboard/public/control/index.html` vs `dashboard/src/validate.js`**: `ALLOWLIST_AGENT_KINDS` in `dashboard/src/validate.js` (lines 39-46) permits `codex` and `gemini`, while `<select id="start-agent-kind">` in `dashboard/public/control/index.html` (lines 64-69) only lists `opencode`, `claude`, `kilo`, and `agy`.
6. **`dashboard/src/validate.js` (`validatePaneId`, line 6)**: `PANE_ID_RE` (`/^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{1,32}$/`) permits a leading `-` on the workspace segment (for example `--help:p1`), which passes validation before being passed to `herdr` without `--`.
7. **`dashboard/public/names/names.js` (lines 133-148, 241-247)**: Click and submit handlers (`orchBtn`, `form`, `revertBtn`) `await apiFetch(...)` without `try/catch` and without disabling buttons while in flight, causing unhandled promise rejections in the browser console on HTTP errors and allowing duplicate submissions on double-click.
8. **`dashboard/public/control/app.js` (line 45)**: On `401`, redirects to `/agents/auth/login?next=` using `window.location.pathname` without `window.location.search`.

## Verification

- `env -u HERDR_ENV ./verify.sh`: passed (`ALL CHECKS PASSED`, exit 0; live smoke skipped outside Herdr).
- `(cd dashboard && npm test)`: passed (25/25 tests across 9 suites, exit 0).
- Em dash check across all modified files and this report: zero matches.

ENRIQUE_DONE
