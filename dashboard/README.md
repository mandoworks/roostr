# Roostr Control Dashboard

Authenticated Passkey (WebAuthn) gate and Herdr pane control UI served under `/agents`.

## Requirements

- Node.js 20 or newer (CommonJS, no build step)
- Single runtime dependency: `@simplewebauthn/server`
- Runs as the `ubuntu` user on OVH so `herdr` can reach the active Herdr server socket

## Configuration

Environment variables (all optional; defaults match OVH deployment):

- `PORT`: listen port (default `8960`, bound to `127.0.0.1`)
- `RP_ID`: WebAuthn Relying Party ID (default `ovh.tail5f1fde.ts.net`)
- `ORIGIN`: expected WebAuthn and CORS/CSRF origin (default `https://ovh.tail5f1fde.ts.net`)
- `STATIC_DIR`: existing static `/agents` directory to serve after auth (default `/home/ubuntu/service-directory/agents`)
- `ALLOW_ADD_CREDENTIAL`: set to `1` to allow enrolling an additional passkey with a valid enroll token
- `ROOSTR_DASHBOARD_CONFIG_DIR`: override config/state directory (default `$HOME/.config/roostr-dashboard`)
- `HERDR_BIN_PATH`: override `herdr` binary path (default `herdr`)

State files under `$HOME/.config/roostr-dashboard/` (created with mode `0600` on first start):

- `session-secret`: 32 random bytes used for HMAC-SHA256 session cookies
- `enroll-token`: 32 random bytes required for `/agents/auth/setup?token=...` (rotated after each registration)
- `credentials.json`: enrolled WebAuthn public keys and sign counters
- `audit.jsonl`: append-only JSONL log of control and auth events

## Installation and startup

```bash
cd dashboard
npm install --omit=dev
npm start
```

On first start (when `credentials.json` has no entries), read the enrollment token from `$HOME/.config/roostr-dashboard/enroll-token` and open:

```text
https://ovh.tail5f1fde.ts.net/agents/auth/setup?token=<TOKEN>
```

## Tailscale Serve setup and rollback

Inspect the current Tailscale Serve configuration first:

```bash
tailscale serve status
```

Map `/agents` to the local dashboard service (keeping the `/agents` path prefix):

```bash
tailscale serve --bg --set-path=/agents http://127.0.0.1:8960/agents
```

Rollback command to restore serving the static `/agents` directory directly:

```bash
tailscale serve --bg --set-path=/agents /home/ubuntu/service-directory/agents
```

## Tests

```bash
cd dashboard
npm test
```
