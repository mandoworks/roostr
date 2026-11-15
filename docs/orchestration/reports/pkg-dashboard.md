# pkg-dashboard report

## Files

- `dashboard/package.json` and `dashboard/.gitignore`: CommonJS Node 20+ package with a single runtime dependency (`@simplewebauthn/server`) and zero dev dependencies.
- `dashboard/server.js`: HTTP entrypoint binding `127.0.0.1:8960` (overridable via `PORT`).
- `dashboard/src/config.js`: Reads `PORT`, `RP_ID`, `ORIGIN`, `STATIC_DIR`, `ALLOW_ADD_CREDENTIAL`, `ROOSTR_DASHBOARD_CONFIG_DIR`, and `HERDR_BIN_PATH` from environment with OVH defaults.
- `dashboard/src/validate.js`: Pure validators for pane IDs (`^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{1,32}$`), key allowlist (`enter`, `esc`, `tab`, `space`, `up`, `down`, `left`, `right`, `backspace`, `y`, `n`, `1` through `9`, `ctrl-c`, max 8), prompt text (non-empty after trim, max 4000 chars, no disallowed control chars), line counts (default 40, max 120), and `resolveStaticPath` (refuses `..`, absolute paths, backslashes, NUL bytes, and symlink escapes).
- `dashboard/src/secrets.js`: Creates and manages `$HOME/.config/roostr-dashboard/` (`0700`) and `session-secret`, `enroll-token`, and `credentials.json` (`0600`, atomic temp-file writes, constant-time token comparison, automatic `enroll-token` rotation on registration).
- `dashboard/src/session.js`: HMAC-SHA256 signed 12-hour session cookies (`HttpOnly; Secure; SameSite=Lax; Path=/agents; Max-Age=43200`) verified via `crypto.timingSafeEqual`.
- `dashboard/src/auth.js`: WebAuthn registration and authentication via `@simplewebauthn/server` with single-use 5-minute in-memory challenges and `ALLOW_ADD_CREDENTIAL=1` gating.
- `dashboard/src/ratelimit.js`: Per-IP sliding-window rate limiter (20 requests per 10 seconds on `/agents/api/*`).
- `dashboard/src/audit.js`: Appends JSONL records (`ts`, `ip`, `action`, `paneId`, `summary`, `ok`) to `$HOME/.config/roostr-dashboard/audit.jsonl` (mode `0600`) and reads the last 20 entries.
- `dashboard/src/herdr.js`: Executes Herdr strictly via `child_process.execFile` with an allowlisted verb set, argv arrays, 10s timeout, 1s snapshot cache, and `502` mapping using the first line of stderr.
- `dashboard/src/app.js`: HTTP router implementing auth gates, CSRF/Origin verification, rate limiting, Herdr API routes, Control UI serving, and authenticated static site serving.
- `dashboard/public/auth/setup.html`, `login.html`, `auth.js`, `auth.css`: Plain WebAuthn passkey enrollment and login pages.
- `dashboard/public/control/index.html`, `app.js`, `style.css`: Responsive, phone-friendly Control UI (5s snapshot polling, 1.5s pane screen polling, single-POST key buttons, prompt form, typed-ID close confirmation dialog, collapsible audit log, 401 redirect, and 429 "slow down" banner).
- `dashboard/README.md`: Configuration, startup, and `tailscale serve` deployment/rollback commands.
- `dashboard/test/validate.test.js`, `dashboard/test/session.test.js`, `dashboard/test/app.test.js`: `node:test` and `node:assert` unit and HTTP handler tests with zero network sockets and mocked Herdr.

## Routes

- `GET /agents/auth/setup?token=...`: Passkey enrollment page (only reachable route when no credentials exist; gated by `ALLOW_ADD_CREDENTIAL=1` afterwards).
- `GET /agents/auth/login`: Passkey sign-in page.
- `POST /agents/api/auth/register/options`, `POST /agents/api/auth/register/verify`: WebAuthn registration endpoints (require valid `enroll-token`, `X-Roostr-CSRF: 1`, `Origin === ORIGIN`).
- `POST /agents/api/auth/login/options`, `POST /agents/api/auth/login/verify`, `POST /agents/api/auth/logout`: WebAuthn authentication and sign-out endpoints.
- `GET /agents/api/auth/me`: Returns current authenticated session identity.
- `GET /agents/api/state`: Runs `herdr api snapshot` (cached max 1s) and returns raw JSON unchanged.
- `GET /agents/api/pane/<paneId>?lines=40`: Runs `herdr pane read <paneId> --source visible --lines <n>` (capped at 120) and returns `{ text }`.
- `POST /agents/api/pane/<paneId>/keys`: Validates keys and runs `herdr pane send-keys <paneId> <key>...`.
- `POST /agents/api/pane/<paneId>/prompt`: Validates prompt, resolves agent target name from live snapshot, and runs `herdr agent prompt <name> <text>`.
- `POST /agents/api/pane/<paneId>/close`: Requires `confirm === paneId` and runs `herdr pane close <paneId>`.
- `GET /agents/api/audit`: Returns last 20 audit entries.
- `GET /agents/control/*`: Serves the Control UI after session auth.
- `GET /agents/*`: Serves files from `STATIC_DIR` after session auth.

## Security invariants

- Zero shell execution (`execFile` only with fixed allowlisted verbs and argv arrays).
- Bootstrap lockdown: when `credentials.json` is empty or absent, all non-setup pages and protected APIs return `403`.
- Every `POST` requires `X-Roostr-CSRF: 1` and `Origin` matching `ORIGIN`.
- Every API route (`/agents/api/*`, including failed auth) is rate-limited at 20 requests per 10 seconds per client IP (using the proxy-appended `X-Forwarded-For` tail IP only when the socket peer is loopback).
- Strict CSP (`default-src 'self'`, no inline scripts, no external CDNs or fonts), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`.
- Static path resolution enforces `realpathSync` containment inside the root directory and blocks `..`, absolute paths, backslashes, and symlink escapes.
- State files (`session-secret`, `enroll-token`, `credentials.json`, `audit.jsonl`) are written with mode `0600` using atomic temp-file renames for secrets and credentials.

## Verification

- Command: `cd dashboard && npm test`
- Result: 15/15 tests passed across 7 suites (`validate.test.js`, `session.test.js`, `app.test.js`), exit code 0.
- Syntax check (`node --check` on all JS files under `dashboard/`): passed.
- Policy check (no em dashes, no local usernames, no shell execution): passed.

## Deployment commands (OVH)

```bash
cd dashboard
npm install --omit=dev
npm start
```

Map `/agents` via `tailscale serve` (preserving the `/agents` prefix):

```bash
tailscale serve status
tailscale serve --bg --set-path=/agents http://127.0.0.1:8960/agents
```

Rollback to static directory:

```bash
tailscale serve --bg --set-path=/agents /home/ubuntu/service-directory/agents
```

## Manual review checklist

- Perform end-to-end WebAuthn passkey enrollment (`/agents/auth/setup?token=...`) and login (`/agents/auth/login`) over HTTPS on `https://ovh.tail5f1fde.ts.net` using a real phone/browser authenticator (mocked in offline tests).
- Verify `tailscale serve` forwards `X-Forwarded-For` and preserves `/agents` routing against `127.0.0.1:8960`.
- Verify live `herdr` interaction (`snapshot`, `pane read`, `pane send-keys`, `agent prompt`, `pane close`) while running as the `ubuntu` user on OVH.

DASHBOARD_DONE
