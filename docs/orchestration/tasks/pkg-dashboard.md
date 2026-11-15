# Task: authenticated Herdr control dashboard under /agents

Build a small service and web UI that puts passkey auth in front of the static
`/agents` site on OVH and lets an authenticated person watch and drive Herdr panes
from a browser. The main use case is approving an agent's permission prompt
(press Enter or Esc) without a terminal.

Do all work inside this worktree, in a new top-level `dashboard/` directory. Do not
edit `bin/roostr`, `src/`, `test/`, or any existing file outside `dashboard/`.

## Hard requirements

- Node 20 or newer, CommonJS, no TypeScript, no build step for the server.
- Exactly one runtime dependency: `@simplewebauthn/server`. Everything else uses
  Node builtins. Dev dependencies are allowed for tests only.
- No shell execution anywhere. Every Herdr call must use `child_process.execFile`
  with an argv array and a fixed, allowlisted verb.
- No secrets, tokens, hostnames, or machine paths committed. Read them from env or
  files under `$HOME/.config/roostr-dashboard/` (mode 0600).
- Never write em dash characters in any file.
- Static front end: plain HTML, CSS, and JS served from `dashboard/public/`. No CDN
  links, no external fonts. It must be usable on a phone.

## Deployment shape

- Service listens on `127.0.0.1:8960` (override with `PORT`).
- Runs as the `ubuntu` user on OVH so `herdr` talks to the running server socket.
- Public URL path prefix `/agents`. Behind it the service serves the existing
  static site from `/home/ubuntu/service-directory/agents` (override with
  `STATIC_DIR`) after auth, plus its own pages and API under `/agents/control/`
  and `/agents/api/`.
- `tailscale serve` will map `/agents` to the service; include the exact commands
  in `dashboard/README.md`, plus the rollback command that restores the static
  route.

## Auth

Passkey (WebAuthn) only. No passwords, no PIN fallback.

- RP ID and origin come from env `RP_ID` (default `ovh.tail5f1fde.ts.net`) and
  `ORIGIN` (default `https://ovh.tail5f1fde.ts.net`).
- Credentials persist to `$HOME/.config/roostr-dashboard/credentials.json`, mode
  0600, written atomically.
- Bootstrap: if no credential exists, the only reachable page is
  `/agents/auth/setup?token=...`. The token is read from
  `$HOME/.config/roostr-dashboard/enroll-token` (created with 32 random bytes,
  mode 0600, on first start if missing). Registration is allowed once per token;
  rotate the file after a successful registration and refuse a second credential
  unless `ALLOW_ADD_CREDENTIAL=1`.
- Sessions: HMAC-SHA256 signed cookie, 12 hours, `HttpOnly`, `Secure`,
  `SameSite=Lax`, secret from `$HOME/.config/roostr-dashboard/session-secret`
  (32 random bytes, mode 0600, created on first start). Verify with
  `crypto.timingSafeEqual`.
- Every POST requires header `X-Roostr-CSRF: 1` and an `Origin` equal to `ORIGIN`.
- Rate limit: 20 requests per 10 seconds per client IP for API routes, including
  failed auth. Return 429.
- Log every control action to `$HOME/.config/roostr-dashboard/audit.jsonl` with
  timestamp, client IP, action, pane id, and a short payload summary. No cookies or
  secrets.

## Herdr control API

All routes require a valid session except the auth routes.

- `GET /agents/api/state` runs `herdr api snapshot` and returns the JSON snapshot
  unchanged. Cache for at most 1 second.
- `GET /agents/api/pane/<paneId>?lines=40` runs
  `herdr pane read <paneId> --source visible --lines <n>` and returns
  `{ text }`, capped at 120 lines.
- `POST /agents/api/pane/<paneId>/keys` body `{ keys: ["enter"] }` runs
  `herdr pane send-keys <paneId> <key>...`.
- `POST /agents/api/pane/<paneId>/prompt` body `{ text }` runs
  `herdr agent prompt <name> <text>` where `name` is resolved from the live
  snapshot for that pane. Reject empty text and text over 4000 characters.
- `POST /agents/api/pane/<paneId>/close` body `{ confirm: "<paneId>" }` runs
  `herdr pane close <paneId>`. The body confirmation must equal the pane id.
- Pane id must match `^[A-Za-z0-9_-]{1,32}:[A-Za-z0-9_-]{1,32}$`.
- Key allowlist: `enter`, `esc`, `tab`, `space`, `up`, `down`, `left`, `right`,
  `backspace`, `y`, `n`, `1` through `9`, `ctrl-c`. Reject anything else. Cap 8
  keys per request.
- Every Herdr call has a 10 second timeout. Herdr failures return 502 with the
  first line of stderr and never crash the service.

## Control UI

Serve at `/agents/control/`:

- Header with who is signed in, a sign-out button, and a link back to `/agents/`.
- A live pane list grouped by workspace and tab, from the snapshot: pane id, agent
  name and kind, status, short task, focused marker. Refresh every 5 seconds.
- Selecting a pane opens a detail view: the last 40 lines of the screen, refreshed
  every 1.5 seconds, and an input box for prompts.
- Action buttons, each a single POST: Approve (enter), Deny (esc), Yes (y), No (n),
  Up, Down, Tab, Ctrl+C, and Send prompt.
- A confirm dialog before Close pane, typing the pane id.
- Show the last 20 audit entries below the pane list, collapsed by default.
- Clear error banners. On 401 redirect to the login page. On 429 show "slow down".
- No frameworks. One `app.js` and one `style.css` is fine.

## Tests

Use `node:test` and `node:assert` for the pure parts, with no network and no Herdr:

- pane id validation accepts real ids and rejects traversal and extra colons
- key allowlist accepts the listed keys and rejects `rm`, `ctrl-z`, and empty
- session cookie signing verifies, rejects tampering, and expires
- prompt length and control-character rules
- static path resolution refuses `..`, absolute paths, and symlink escapes

`npm test` must pass. Do not require a running Herdr for tests.

## Report

Write `docs/orchestration/reports/pkg-dashboard.md` describing files, routes,
security invariants, test command and result, deployment commands, and anything a
reviewer must check by hand. End with `DASHBOARD_DONE` or
`DASHBOARD_BLOCKED: <reason>`.
