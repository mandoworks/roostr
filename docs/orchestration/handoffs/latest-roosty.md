# Handoff: roosty to roosty-argon

Date: 2026-11-15. From: roosty (opencode, deepseek-v4.1-flash) on the laptop.
To: roosty-argon (agy, Gemini 4 Hydrogen High).

## Who you are

You are the builder on the OVH side of the Roostr work. Roman orchestrates and
Armando directs through Roman. You build the Roostr skill, the board, and the OVH
connections, including the auto-onboarding machinery. You are not Roman's peer and
you do not hand out direction.

Voice: terse, factual, no em dash characters anywhere, no flattery. Code, commits
and security warnings are written normally.

## Where things live

- Repo: `/Users/puntopio/Git Repos/roostr`, branch `main`, HEAD `2a777e0`.
- OVH: `ssh ovh` (100.123.63.122, hostname `vps-43beb0ce`, MagicDNS
  `ovh.tail5f1fde.ts.net`). Passwordless `sudo -n` works. The old `contabo`
  tailnet entry is offline and irrelevant.
- Herdr plugin checkout on OVH, updated by `~/.local/bin/roostr-update`:
  `~/.config/herdr/plugins/github-installations/roostr-c6c098eb1d8a/1438337-0/checkout`.
- Node on OVH is `~/.local/bin/node` (v22); it is not on the default PATH.

## Live right now

- `/agents` on OVH is behind a WebAuthn passkey. Service
  `roostr-dashboard.service` (user unit) on `127.0.0.1:8960`, routed by
  `tailscale serve --set-path /agents`. Armando enrolled his passkey; one
  credential is stored in `~/.config/roostr-dashboard/credentials.json`.
- Control page: `https://ovh.tail5f1fde.ts.net/agents/control/`. Approve sends
  Enter, Deny sends Esc, plus y, n, arrows, Tab, Ctrl+C, prompt box, confirmed
  close. Every action is audited to `~/.config/roostr-dashboard/audit.jsonl`.
- Static board files stay at `/home/ubuntu/service-directory/agents`. The
  dashboard serves them after auth.
- Roostr board data is published there every 60s by `roostr-publish.timer`:
  `/agents/roostr.json` and `/agents/workers/workers.vps-43beb0ce.json`.
- Relay seat `roosty` exists and is current. Agent card is sparse; agent-status
  announced.

## Pending work, in order

1. Confirm Armando can log in with the passkey and drive a pane from
   `/agents/control/`. If the passkey fails, roll back with
   `ssh ovh 'sudo tailscale serve --set-path /agents off'`, fix, and re-add with
   `ssh ovh 'sudo tailscale serve --bg --set-path /agents http://127.0.0.1:8960/agents'`.
2. Names contract with Roman, sent as `msg_c14a6d0fd401` (kind=question). Open
   items: whether Buildy 1 reads `/agents/roostr.json` or wants it merged into
   `data.json`, exact schema, a stable host label instead of
   `vps-43beb0ce`, and how remote hosts push snapshots. Do not touch Buildy 1's
   app. Wait for the answer before building `names.json` readers.
3. Auto-onboarding, standard bundle, no human in the loop: detect the orchestrator
   run, then PioRelay seat, webhook registration, agent card, and board
   announcement. Webhook seats are standard, never requested. Signing is Standard
   Webhooks; registration changes are admin-gated. Agents resident on OVH need no
   bridge.
4. One-click Approve/Deny from the pane list, not only the detail view. Nice to
   have, not urgent.
5. Deploy any dashboard change by rsync to `/home/ubuntu/roostr-dashboard`, then
   `systemctl --user restart roostr-dashboard.service`. Never serve it without the
   passkey gate.

## Standing orders

- Webhook seat is part of every onboarding bundle you build.
- You build; Roman orchestrates; Armando directs through him.
- Never print secrets, tokens, or `.env` contents. Refer to files by path.
- No em dash characters in prose or files. `./verify.sh` enforces this.
- Run `node --test test/*.test.js` plus `env -u HERDR_ENV ./verify.sh` before a
  commit. Dashboard tests: `cd dashboard && npm test`.
- Commit only files related to the change. `scripts/update.sh` has an unrelated
  uncommitted edit, and `PLAN.md` and `docs/leaderboards-design.md` are untracked
  on purpose. Leave them.
- Pane ids look like `w27:p1`. Use the `roostr` skill for board and crew rules.
- Relay API: `http://100.123.63.122:3016/api/v1`. The skill's `send.sh` does not
  send `kind`; use a direct POST to `/agent-messages` with
  `{from,to,subject,body,kind,client_msg_id}` and a fresh client id.

## Pane map on the laptop

- `w27:p1` roosty, this session, opencode. Keep it until the handoff is accepted.
- `w27:p9`, `w27:pA` idle agy workers (ramon, tomas) from the finished packages.
  Close them if you need the space; their work is merged.
- `w27:pC` dashboard builder, agy high, idle. Its work is merged and deployed.
- A new tab will hold roosty-argon.

## What done looks like

Armando opens `/agents`, logs in with the passkey, and allows or denies a blocked
agent from the control page. Roman has the names contract answer. The onboarding
bundle is automatic for new herdr agents.
