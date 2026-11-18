# Package Brief: `pkg-p2-approvals-engine-and-web`

## Objective
Implement P2 first-class Approvals (`src/approvals.js`), the 60-second long-poll + zero-RAM hibernate/wakeup lifecycle, OVH-scoped Hermita `routine` vs human-passkey-only `big-decision` rules, Web Push / Pushover + PioRelay notifications, Chicken-Grill spec escalation, and the Web GUI Approvals tab.

## Owned Files (`owns`)
- `src/approvals.js`
- `test/approvals.test.js`
- `dashboard/src/approvals-bridge.js`
- `dashboard/src/app.js`
- `dashboard/public/control/index.html`
- `dashboard/public/control/app.js`
- `dashboard/public/control/style.css`
- `dashboard/test/app.test.js`
- `docs/orchestration/reports/pkg-p2-approvals-engine-and-web.md`

## Implementation Requirements

1. **Core Approvals Module (`src/approvals.js`)**:
   - Storage: `~/.roostr/approvals.json` (`0600`, active/recent objects) and `~/.roostr/decisions.jsonl` (append-only audit log of every decided/expired approval).
   - Fields: `{ id, agentId, owner, host, action, command, cwd, riskClass, context, status, requestedAt, expiresAt, decidedAt, decidedBy, decisionNote, grillSessionId, grillSpecPath }`.
   - Risk classes: `'routine'` | `'big-decision'`. Default TTL: `24 * 60 * 60 * 1000` ms (`86400000`).
   - `expireStaleApprovals(now)`: transitions any `'pending'` item where `now >= Date.parse(expiresAt)` to `status: 'denied-timeout'`, `decidedBy: 'system:ttl'`, and appends to `decisions.jsonl`.
   - Authority check in `decideApproval({ id, decision, actor, authType, actorHostScope, note })`:
     - If `riskClass === 'big-decision'` and `authType !== 'passkey'`, throw `403` (`'big-decision approvals require human passkey session'`).
     - If `riskClass === 'routine'` and `authType === 'token'`: allow only if `actor === 'hermita'` (or `actorRole === 'resident-operator'`) AND `approval.host === 'ovh'`. If `approval.host === 'mac'`, require `authType === 'passkey'`.
   - CLI entrypoint (`roostr approval <request|wait|decide|list>`):
     - `roostr approval request`: creates approval, marks worker `waiting-approval` in `src/registry.js`.
     - `roostr approval wait <id> [--timeout-sec 60]`: for `routine`, polls/long-polls up to 60s. If decided within 60s, prints JSON decision and exits `0` (if approved) or `2` (if denied). If still `pending` at 60s (or immediately if `riskClass === 'big-decision'`), updates worker registry entry with `{ state: 'waiting-approval', hibernated: true, rssKb: 0, pendingApprovalId: id }`, prints `HIBERNATED_FOR_APPROVAL <id>`, and exits `0` so the heavy agent process terminates and frees all RAM.
   - Auto-Resume on Decision (`resumeHibernatedWorker(approval)`):
     - When `decideApproval` transitions an approval where the worker is `hibernated: true`, invokes `runner.resumeAfterApproval(worker, approval)` to spawn the worker detached from its `sessionId` (`opencode run --session <id>`, `claude -p --resume <id>`, `kilo`, `agy`) with the decision context and any cooked Chicken-Grill spec path.

2. **Web Dashboard API & Chicken-Grill Bridge (`dashboard/src/approvals-bridge.js`, `dashboard/src/app.js`)**:
   - `POST /agents/api/approvals` (`X-Roostr-Token` or passkey): creates approval; if `riskClass === 'big-decision'`, dispatches notification to Roman's PioRelay inbox (`dashboard/src/muse.js`) and Web Push / Pushover webhook if configured.
   - `GET /agents/api/approvals` (`?status=pending|all`): returns sorted approvals (`big-decision` first, then oldest `requestedAt`) + recent `decisions.jsonl`.
   - `GET /agents/api/approvals/:id/wait?timeout=60`: long-polls up to 60s via an in-memory `EventEmitter` bus and returns immediately on decision.
   - `POST /agents/api/approvals/:id/decide`: enforces passkey vs OVH Hermita token rules, records decision, and triggers auto-resume if worker is hibernated.
   - `POST /agents/api/approvals/:id/grill` (passkey only): opens a Chicken-Grill session (`POST ${GRILLD_URL || 'http://127.0.0.1:7433'}/api/v1/sessions` with the approval's `action`, `command`, and `context`), stores `grillSessionId` on the approval, and returns the Coop Board URL so the operator can grill the decision before approving.

3. **Web Control UI (`dashboard/public/control/`)**:
   - Add an **Approvals** badge & panel in `/agents/control/` showing pending count, risk badge (`BIG-DECISION` in red, `ROUTINE` in amber), host badge (`OVH` / `MAC`), command/cwd/diffStat preview, optional note input, and **Approve**, **Deny**, and **Grill First** buttons, plus the collapsible Decision Log table.

## Verification
- Add unit and HTTP integration tests in `test/approvals.test.js` and `dashboard/test/app.test.js` covering: `routine` OVH token approval, `routine` Mac token rejection (`403`), `big-decision` token rejection (`403`), passkey approval, 24h TTL `denied-timeout`, 60s wait -> hibernate -> auto-resume, and `/grill` escalation.
