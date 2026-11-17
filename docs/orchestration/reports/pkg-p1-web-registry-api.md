# Report: pkg-p1-web-registry-api

- Owner: Fernando (`fernando`)
- Branch: `crew/fernando`
- Status: Complete

## Changes Made

1. **`dashboard/src/registry-bridge.js`** (new, zero external dependencies)
   - `registryPaths(roostrStateDir)` maps the shared Roostr state: `registry.json`, `tokens.json`, `closed-sessions.jsonl`, `logs/<id>.log`. Every JSON write is atomic (temp file plus rename, mode `0600`); the closed-session log appends with mode `0600`.
   - `authenticateToken(req, roostrStateDir)` reads the `X-Roostr-Token` header, SHA-256 hashes it, and compares it in constant time against the digests in `tokens.json`. The reader accepts an array, `{ tokens: [...] }`, `{ entries: [...] }`, or a hash-keyed map, and digest fields named `hash`, `digest`, `sha256`, `tokenHash`, `token_hash`, or `hash_sha256`.
   - `registerWorker(roostrStateDir, body)` and `updateWorkerStatus(roostrStateDir, body)` persist records matching spec section 1: `id`, `owner`, `orchestrator`, `host`, `task`, `session`, `kind`, `pid`, `command`, `rssKb`, `state`, `mode`, `logFile` (plus `cwd`, `placement`, `model`, `effort`, `paneId`, `workspaceId`, `source: 'reported'`, `startedAt`, `lastHeartbeat`, `updatedAt`). State is limited to `working | waiting-approval | idle | done | failed` and mode to `headless | pane`. `registerWorker` generates an `id` when omitted and upserts; `updateWorkerStatus` returns `404` when the id is unknown.
   - `getRegistrySnapshot(roostrStateDir)` returns `{ workers, hostMem, closedSessions }`, sorting workers by heartbeat and reading `/proc/meminfo` on Linux for `physFreeKb`, `physTotalKb`, `swapUsedKb`, and `swapTotalKb` (with the host name). Unreadable `/proc` leaves nulls in place.
   - `tailWorkerLog(roostrStateDir, id, lines = 40)` validates `id` against `/^[A-Za-z0-9_.:-]{1,64}$/`, guards the resolved path inside the state directory, and returns the last N lines (default 40). An absent log yields an empty string rather than an error.
   - `reapWorkerProcess(roostrStateDir, id, { pid, command }, deps)` applies the Swapy rule: it verifies the pid and normalized command against the registry record and against the live process table (`deps.processTable`, default scans `/proc/<pid>/cmdline`) before sending `SIGTERM` (`deps.killImpl`, default `process.kill`). It appends to `closed-sessions.jsonl` (`{ at, id, pid, command, model, ramKb, session, paneId, workspaceId, reason }`) and marks the worker `failed`. Mismatches return `409`; unknown ids return `404`.
   - No `child_process` usage, no `shell: true`, no `execSync`.

2. **`dashboard/src/app.js`**
   - `POST /agents/api/register` and `POST /agents/api/status` are handled ahead of the CSRF gate and the enrollment gate for a standalone host. They accept a valid `X-Roostr-Token` OR an authenticated passkey session cookie, and deliberately do not require the passkey cookie or the CSRF header when the token is valid. Missing both returns `401`; results branch to `registerWorker` / `updateWorkerStatus`.
   - `GET /agents/api/registry` (passkey-gated) returns `getRegistrySnapshot(config.roostrStateDir)`.
   - `GET /agents/api/registry/:id/log` (passkey-gated) validates `?lines=` and returns `{ id, text }`.
   - `POST /agents/api/registry/:id/reap` (passkey-gated) validates `{ pid, command }`, calls `reapWorkerProcess`, and writes `registry.reap` audit entries on success and failure.
   - `createApp` accepts an optional `registryDeps` object (`processTable`, `killImpl`, `now`) that is forwarded to `reapWorkerProcess`, keeping the route testable without touching live processes.

3. **`dashboard/public/control/index.html`, `style.css`, `app.js`**
   - Added a `#registry-details` "Standalone Workers & RAM Monitor" panel with `#host-mem-summary`, a `#sort-ram-btn` toggle, `#registry-refresh-btn`, `#registry-status`, a `#registry-content` table host, and a `<pre id="worker-log-preview">` log box.
   - The table lists `id`, `owner`, `host`, `mode`, `state`, heartbeat age, `session`, and `RAM (MB)`, with per-row `Log Tail` and `Reap` actions. `Sort by RAM` toggles descending RSS order.
   - `refreshRegistry()` polls `GET /agents/api/registry` with the graceful `optionalGet` helper on load, on panel toggle, on manual refresh, and on the existing snapshot interval, so the monitor table renders even when `/agents/api/state` returns `502` because herdr is stopped. All rendering builds DOM with `textContent`, staying within `Content-Security-Policy: default-src 'self'`.

4. **`dashboard/test/app.test.js`**
   - Added a suite covering `X-Roostr-Token` auth on `/agents/api/register` and `/agents/api/status` (`401` without token/cookie, `200` with a valid token, `200` with a passkey cookie only), `GET /agents/api/registry` (`401` unauthenticated, snapshot with `workers`/`hostMem`/`closedSessions`), `GET /agents/api/registry/:id/log` (`200` with tailed text, `400` on bad `lines`), and `POST /agents/api/registry/:id/reap` (`409` on PID/command mismatch, `200` on match with a `SIGTERM`, closed-session append, `failed` state, and audit entries).

## Verification

- `node --check` on `dashboard/src/registry-bridge.js`, `dashboard/src/app.js`, `dashboard/public/control/app.js`, and `dashboard/test/app.test.js`: exited 0.
- `(cd dashboard && npm test)`: 34 tests across 11 suites passed (0 failed), exit 0.
- `env -u HERDR_ENV ./verify.sh`: exited 0 (`ALL CHECKS PASSED`, including `no shell execution` and `no em dashes`).
- No em dashes added anywhere. No commit or push performed.

FERNANDO_DONE
