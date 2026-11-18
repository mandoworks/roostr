# Task pkg-p1-web-registry-api

- Owner: Fernando (`fernando`), `gemini-4-hydrogen-medium`, branch `crew/fernando`
- Report: `docs/orchestration/reports/pkg-p1-web-registry-api.md` ending with `FERNANDO_DONE` or `FERNANDO_BLOCKED`

## Scope (touch ONLY `dashboard/src/registry-bridge.js`, `dashboard/src/app.js`, `dashboard/public/control/{index.html,style.css,app.js}`, `dashboard/test/app.test.js`, and your report)

1. **`dashboard/src/registry-bridge.js` — Registry, Token Auth, Host RAM & Log/Reap Bridge**:
   - Reads/writes `<roostrStateDir>/registry.json`, `<roostrStateDir>/tokens.json` (SHA-256 hashed `X-Roostr-Token`), `<roostrStateDir>/closed-sessions.jsonl`, and `<roostrStateDir>/logs/<id>.log` (zero external deps, atomic writes).
   - `authenticateToken(req, roostrStateDir)`: checks `X-Roostr-Token` header against SHA-256 digests in `tokens.json`.
   - `registerWorker(roostrStateDir, body)` & `updateWorkerStatus(roostrStateDir, body)` matching spec section 1 (`id`, `owner`, `orchestrator`, `host`, `task`, `session`, `kind`, `pid`, `command`, `rssKb`, `state`, `mode`, `logFile`).
   - `getRegistrySnapshot(roostrStateDir)`: returns `{ workers, hostMem, closedSessions }` (reading `/proc/meminfo` on Linux for `physFreeKb`, `swapUsedKb`, `swapTotalKb`).
   - `tailWorkerLog(roostrStateDir, id, lines = 40)` (validates `id` against `/^[A-Za-z0-9_.:-]{1,64}$/` to prevent path traversal).
   - `reapWorkerProcess(roostrStateDir, id, { pid, command }, deps)`: Swapy rule — verifies `pid` and `command` match the registry entry AND live `ps` output before sending `SIGTERM`, appends to `closed-sessions.jsonl`, and marks worker `failed`.
2. **`dashboard/src/app.js` — Wire Standalone Registry & Monitor Routes**:
   - `POST /agents/api/register` and `POST /agents/api/status`: accept either a valid `X-Roostr-Token` header OR an authenticated passkey session cookie (without requiring passkey cookie when `X-Roostr-Token` is valid!).
   - `GET /agents/api/registry` (passkey-gated): returns `getRegistrySnapshot(config.roostrStateDir)`.
   - `GET /agents/api/registry/:id/log` (passkey-gated): returns `{ id, text }`.
   - `POST /agents/api/registry/:id/reap` (passkey-gated): validates `{ pid, command }`, calls `reapWorkerProcess`, logs to `audit`.
3. **`dashboard/public/control/{index.html,style.css,app.js}` — Standalone Workers & RAM Monitor UI**:
   - In `#orchestration-details` (and/or a dedicated `#registry-details` panel), add a **Standalone Workers & RAM Monitor** table:
     - Shows host `PhysMem free` and `Swap used` summary badge (`#host-mem-summary`).
     - Lists every worker from `GET /agents/api/registry`: `id`, `owner`, `host`, `mode` (`headless`/`pane`), `state`, `heartbeat` age, `session` handle, and `RAM (MB)` (with a **Sort by RAM** toggle button).
     - Row actions: **Log Tail** (shows tail in a clean `<pre id="worker-log-preview">` box) and **Reap** (sends `{ pid, command }` to `POST /agents/api/registry/:id/reap`).
     - Gracefully handles `herdr` being stopped (the monitor table still renders even when `/agents/api/state` returns 502!).
4. **Tests & Rules**:
   - Add tests in `dashboard/test/app.test.js` covering `X-Roostr-Token` auth on `/agents/api/register` and `/agents/api/status` (401 without token/cookie, 200 with valid token), `GET /agents/api/registry`, `GET /agents/api/registry/:id/log`, and `POST /agents/api/registry/:id/reap` (409 on PID/command mismatch, 200 on match).
   - Respect `Content-Security-Policy: default-src 'self'`. No em dashes (`—`) anywhere. Run `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
(cd dashboard && npm test)
env -u HERDR_ENV ./verify.sh
```
