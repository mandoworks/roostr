# Report: pkg-web-backend-muse

- Owner: Valentin (`valentin`), branch `crew/valentin`
- Status: Complete

## Changes Made

1. **`dashboard/src/config.js`**:
   - Added `roostrStateDir` (`env.ROOSTR_STATE_DIR || path.join(homeDir, '.roostr')`), `roostrRepoDir` (`env.ROOSTR_REPO_DIR || path.resolve(__dirname, '..', '..')`), and `piorelayBase` (`env.PIORELAY_BASE || 'http://100.97.196.10:3016/api/v1'`).

2. **`dashboard/src/validate.js`**:
   - Added and exported `validateOptionalModel`, `validateOptionalEffort`, `validateOptionalSessionId`, `validateSplitDirection`, and `validateMuseMessage`.

3. **`dashboard/src/herdr.js`**:
   - Added `'pane:split'` to `ALLOWED_VERBS`.
   - Extended `startAgent(paneId, name, kind, opts = {})` to append `'--'` and kind-specific flags (`--resume`/`--session`/`--conversation`, `--model`, `--effort`) only when `session`, `model`, or `effort` are provided, preserving the exact existing argv when omitted.
   - Added `splitPane(paneId, direction = 'right', cwd = null)` calling `['pane', 'split', '--pane', pv.value, '--direction', dv.value, ...(cwdVal ? ['--cwd', cwdVal] : []), '--no-focus']` and extracting the created pane ID.

4. **`dashboard/src/sessions-bridge.js`**:
   - Added `getRecoverySnapshot({ roostrStateDir, roostrRepoDir })` returning `{ sessions, backups, orchestration }` from `<roostrStateDir>/sessions.json`, `<roostrStateDir>/backups/*/{v*,*}.json`, `<roostrRepoDir>/docs/orchestration/tasks.json`, `handoffs/*.md`, and `reports/*.md`.

5. **`dashboard/src/muse.js`**:
   - Added `getMuseSnapshot({ staticDir, statusPath, namesStore })` unifying `data.json` (`roman_desk`, `tier1`, `tier2`), `workers/workers.muse.json`, `status.json`, and `namesStore` overrides/orchestrators into `{ romanDesk, agents, tier2, generatedEpoch, stampAst }`.
   - Added `sendPioRelayMessage({ piorelayBase, from, to, subject, body, project, threadId, fetchImpl })` with a 5s `AbortController` timeout posting to `${piorelayBase}/agent-messages`.

6. **`dashboard/src/app.js`**:
   - Wired authenticated routes:
     - `GET /agents/api/sessions`
     - `POST /agents/api/pane/:id/start` (forwarding `model`, `effort`, `session`)
     - `POST /agents/api/pane/:id/split` (splitting pane and optionally starting an agent on the new pane ID)
     - `GET /agents/api/muse`
     - `POST /agents/api/muse/message` (validating payload, forwarding via injectable `fetch`, logging to `audit`, returning `200` or `502`).

7. **Tests**:
   - Expanded `dashboard/test/validate.test.js` with unit tests for all 5 new validators.
   - Expanded `dashboard/test/app.test.js` with end-to-end handler tests for `/agents/api/sessions`, `/agents/api/pane/:id/start` (`claude`, `opencode`, `agy`), `/agents/api/pane/:id/split`, `/agents/api/muse`, and `/agents/api/muse/message`.

## Verification

- `(cd dashboard && npm test)`: passed (32/32 tests, 11 suites, 0 failures).
- `env -u HERDR_ENV ./verify.sh`: exited 0 (`ALL CHECKS PASSED`).
- Em dash check across `dashboard/src/` and `dashboard/test/`: none found.

VALENTIN_DONE
