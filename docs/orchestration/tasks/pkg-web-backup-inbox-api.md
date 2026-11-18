# Task pkg-web-backup-inbox-api

- Owner: Valentin (`valentin`), `gemini-4-hydrogen-medium`, branch `crew/valentin`
- Report: `docs/orchestration/reports/pkg-web-backup-inbox-api.md` ending with `VALENTIN_DONE` or `VALENTIN_BLOCKED`

## Scope (touch ONLY `dashboard/src/{sessions-bridge,muse,app}.js`, `dashboard/test/app.test.js`, and your report)

1. **`dashboard/src/sessions-bridge.js` — Backup capture & workspace/session restore actions**:
   - Add `captureBackups({ roostrRepoDir, roostrStateDir, execFileImpl })`:
     - Invokes `node <roostrRepoDir>/bin/roostr backups capture --json` (with `ROOSTR_STATE_DIR: roostrStateDir` in env, 15s timeout, injectable `execFileImpl` or callback for testing) and returns `{ ok: true, captured: parsedJson }` (or `{ ok: false, status: 502, error }`).
   - Add `restoreWorkspace({ roostrRepoDir, roostrStateDir, workspace, mode, version, layout, execFileImpl })`:
     - Validates `workspace` (`/^[A-Za-z0-9_ -]{1,64}$/` and not starting with `-`).
     - When `mode === 'backup'`: runs `node <roostrRepoDir>/bin/roostr backups restore <workspace> --yes` (with optional `--version <n>` and `--layout <even|saved|columns|rows>`) and returns `{ ok: true, mode: 'backup', output }`.
     - Otherwise (`mode === 'sessions'` default): runs `node <roostrRepoDir>/bin/roostr restore --workspace <workspace> --yes --json` and returns `{ ok: true, mode: 'sessions', result }`.
2. **`dashboard/src/muse.js` — Two-way PioRelay inbox/thread reader**:
   - Add `fetchPioRelayMessages({ piorelayBase, agent, project, limit = 20, fetchImpl })`:
     - Validates `agent` (`/^[a-z0-9-]{1,32}$/`, optional).
     - Fetches `${piorelayBase}/agent-messages?agent=${encodeURIComponent(agent)}&limit=${limit}` (or if `project` is passed, `&project=${encodeURIComponent(project)}`) with a 5s `AbortController` timeout.
     - Normalizes the response (handling `{ messages: [...] }`, `{ items: [...] }`, or array `[...]`) into `{ ok: true, agent, messages: [...] }` where each message has `{ id, from, to, subject, body, project, threadId, createdAt, read }`. On network/non-2xx error returns `{ ok: false, status: 502, error }`.
3. **`dashboard/src/app.js` — Wire new authenticated routes**:
   - `POST /agents/api/backups/capture`: calls `captureBackups`, logs `backups.capture` to `audit`, returns `200` `{ ok: true, captured }` (or `502`).
   - `POST /agents/api/sessions/restore`: reads JSON body `{ workspace, mode, version, layout }`, calls `restoreWorkspace`, logs `sessions.restore` to `audit`, returns `200` (or `400`/`502`).
   - `GET /agents/api/muse/messages`: reads query params `agent` (required, `/^[a-z0-9-]{1,32}$/`) and optional `limit` (1..50, default 20) and `project`, calls `fetchPioRelayMessages`, returns `200` `{ ok: true, agent, messages }` (or `400`/`502`).
   - Support injectable `deps.execFile` (alongside `deps.fetch`) in `createApp` so unit tests in `dashboard/test/app.test.js` can test all 3 new routes without spawning real processes.
4. **Tests & Rules**:
   - Add comprehensive tests in `dashboard/test/app.test.js` for `POST /agents/api/backups/capture`, `POST /agents/api/sessions/restore` (`sessions` and `backup` modes + invalid workspace `400`), and `GET /agents/api/muse/messages` (`200`, `400` bad agent slug, `502` relay error).
   - No em dashes (`—`) anywhere. Run `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
(cd dashboard && npm test)
env -u HERDR_ENV ./verify.sh
```
