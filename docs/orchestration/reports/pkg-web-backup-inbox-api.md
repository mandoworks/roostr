# Report: pkg-web-backup-inbox-api

- Owner: Valentin (`valentin`), branch `crew/valentin`
- Status: Complete

## Changes Made

1. **`dashboard/src/sessions-bridge.js`**:
   - Added `captureBackups({ roostrRepoDir, roostrStateDir, execFileImpl })` to invoke `node <roostrRepoDir>/bin/roostr backups capture --json` with `ROOSTR_STATE_DIR` in env, a 15s timeout, and injectable `execFileImpl`, returning `{ ok: true, captured }` or `{ ok: false, status: 502, error }`.
   - Added `restoreWorkspace({ roostrRepoDir, roostrStateDir, workspace, mode, version, layout, execFileImpl })` with `workspace` validation (`/^[A-Za-z0-9_ -]{1,64}$/`, non-dash-prefixed), supporting `backup` mode (`backups restore <workspace> --yes` with optional `--version` and `--layout`) and `sessions` mode (`restore --workspace <workspace> --yes --json`).

2. **`dashboard/src/muse.js`**:
   - Added `fetchPioRelayMessages({ piorelayBase, agent, project, limit = 20, fetchImpl })` with optional `agent` slug validation (`/^[a-z0-9-]{1,32}$/`), 5s `AbortController` timeout, and normalization of `{ messages: [...] }`, `{ items: [...] }`, or `[...]` responses into `{ ok: true, agent, messages }` (with `{ id, from, to, subject, body, project, threadId, createdAt, read }` per item) or `{ ok: false, status: 502, error }`.

3. **`dashboard/src/app.js`**:
   - Added injectable `execFile` dependency alongside `fetch` in `createApp`.
   - Wired authenticated routes:
     - `POST /agents/api/backups/capture` (logs `backups.capture` to `audit`)
     - `POST /agents/api/sessions/restore` (logs `sessions.restore` to `audit`)
     - `GET /agents/api/muse/messages` (validates required `agent`, optional `limit` 1..50, and optional `project`)

4. **`dashboard/test/app.test.js`**:
   - Added `execFile` forwarding in `createHarness`.
   - Added unit tests covering `POST /agents/api/backups/capture` (`200`, `502`), `POST /agents/api/sessions/restore` (`sessions` and `backup` modes, `400` validation errors, `502` CLI error, audit entries), and `GET /agents/api/muse/messages` (`200` with `messages` and `items` shapes, `400` invalid/missing agent and out-of-range limit, `502` HTTP/network errors).

## Verification

- `(cd dashboard && npm test)`: passed (33/33 tests in 11 suites, 0 failures).
- `env -u HERDR_ENV ./verify.sh`: exited 0 (`ALL CHECKS PASSED`).

VALENTIN_DONE
