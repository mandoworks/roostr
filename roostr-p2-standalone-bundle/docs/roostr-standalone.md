# Roostr Standalone

Spec: Operator-approved standalone architecture (P1 + P2).
Owner: Roosty. Lead Orchestrator: Roman. Resident Operator on OVH: Hermita.

## Problem

Agent execution coupled to terminal multiplexer panes consumes excessive memory:
- Every interactive pane running OpenCode or Kilo holds a full runtime resident in RAM even at 0% CPU (1 to 6 GB per idle pane on a 16 GB laptop, driving swap over 95%).
- A pane is a viewer for watching, steering, answering prompts, and taking control. Background workers need none of that, but pay the full memory cost when bound to a pane.
- Closing a pane to reclaim RAM hides the agent when visibility and execution are fused.

## Goal

Roostr runs agents as a **standalone TUI and Web GUI orchestrating board** without requiring Herdr as its runtime substrate. Registry, headless execution, resource governance, empirical model/effort routing, log tailing, and approvals live natively in Roostr (`roostrd` + TUI + Web GUI). Herdr is demoted to an optional viewer adapter (`src/viewers/herdr.js`): a pane is opened only when a human explicitly requests it, and closing it never kills the agent.

Non-goals: Roostr Standalone does not replace PioRelay (agent mail), MuseSight (memory), or the Muse desk visibility board. Access remains restricted to private network + WebAuthn passkey gate.

## Architecture

### 1. Unified Control-Plane Daemon (`roostrd`) + Registry & Heartbeat
- `src/roostrd.js` (`roostr daemon serve` / `roostr daemon ensure`) is the single writer for `~/.roostr/` (`registry.json`, `approvals.json`, `decisions.jsonl`, `closed-sessions.jsonl`) listening on `~/.roostr/roostrd.sock` (`0600`).
- `dashboard/src/app.js` mounts and proxies to `roostrd` behind the passkey gate. When `roostrd` is not running (e.g. stateless CI), CLI/TUI commands fall back to atomic lock-guarded file reads/writes via `src/state.js`.
- Every worker registers (`POST /agents/api/register`) and heartbeats (`POST /agents/api/status`) with `X-Roostr-Token`. A registered worker tracks: `id`, `owner`, `host`, `task`, `tool`, `model`, `effort`, `sessionId` (resume handle), `state` (`working` | `waiting-approval` | `idle` | `done` | `failed`), `hibernated`, `pid`, `rssKb`, and `lastHeartbeat`.

### 2. Detached Headless Runner & Interactive Spawn Drawer
- `src/runner.js` (`roostr run`) launches `opencode`, `claude`, `kilo`, `agy`, or `custom` workers detached (`< /dev/null`, `unref()`), captures stdout/stderr to `~/.roostr/logs/<id>.log`, and persists `sessionId` for zero-loss resume.
- From both the TUI (`[S spawn]`) and Web GUI (`+ Spawn Worker`), the operator picks (or accepts `src/advisor.js` empirical recommendations for) `tool`, `model`, `effort` (`low` | `medium` | `high` | `xhigh`), and `host` (`ovh` by default; `mac` requires explicit `macReason`).

### 3. Resource Governor & Idle Reaper
- Per-host budgets in Roostr config (`maxLivePanes: 3` default on macOS) and swap-pressure thresholds fed by `/proc/meminfo` (Linux) and `~/.roostr/swapy-census.json` (macOS).
- Idle panes sitting at a prompt past 30 minutes are reaped after verifying a persisted resumable `sessionId` and matching PID + command (Swapy rule). Every reap/kill is recorded in `~/.roostr/closed-sessions.jsonl`.

### 4. Web & TUI Approvals (P2) with Zero-RAM Hibernation
Approval prompts never block inside invisible terminal panes:
- **First-class approval object (`~/.roostr/approvals.json`)**: `{ id, agentId, owner, host, action, command, cwd, riskClass, context, status, requestedAt, expiresAt, decidedAt, decidedBy, decisionNote, grillSessionId }`.
- **Hybrid 60s Long-Poll -> Zero-RAM Exit & Wakeup**:
  - When a headless worker files an approval via `roostr approval request`, `roostr approval wait` long-polls `GET /agents/api/approvals/:id/wait` for up to 60 seconds for fast `routine` approvals.
  - If undecided after 60 seconds (or immediately for `big-decision`), the CLI exits `0` and marks the worker `state: "waiting-approval", hibernated: true, rssKb: 0`. The heavy coding agent process exits completely, freeing 100% of its RAM while its session stays on disk.
  - When approved or denied on the Web GUI or TUI (`[A approvals]`), `roostrd` automatically resumes the worker from its `sessionId` (`runner.resumeAfterApproval`) with the signed decision (or cooked Chicken-Grill spec) injected into the prompt.
- **Risk classes & authority**:
  - `routine`: build/test/git inside a worktree, restarts, reads. Approvable via passkey session on any host, or by the resident operator token (`Hermita`) when `host === "ovh"`. Mac `routine` approvals require human passkey approval.
  - `big-decision`: publishing, credentials/access changes, money, deleting data, external outreach. **Human passkey session only** (`X-Roostr-Token` returns `403 Forbidden`). Automatically dispatches Web Push / Pushover alerts and a PioRelay message to the lead orchestrator (`roman`), and supports 1-click escalation into a **Chicken-Grill** (`grilld`) interview session (`POST /agents/api/approvals/:id/grill`).
- **Expiration**: Unanswered approvals expire after 24 hours (`default TTL`) to `denied-timeout`, never to silent approval. Every decision appends to `~/.roostr/decisions.jsonl`.

### 5. Standalone Worker TUI & Optional Herdr Viewer Adapter
- **Split/Collapsible Log Viewer (`src/board/viewer.js`)**: Pressing `Enter` or `l` on any worker row opens a collapsible split pane inside the Roostr TUI tailing `~/.roostr/logs/<id>.log` via `fs.watch` + byte-offset reads (~1 MB RAM).
- **Native CLI Interactive Attach (`i`)**: Pressing `i` temporarily yields the terminal (`stdio: 'inherit'`) to `<tool> --session/--resume <sessionId>` so the operator can steer live and return to the TUI on exit.
- **Optional Herdr Viewer (`src/viewers/herdr.js`)**: If Herdr is installed and running, pressing `H` (`Open in Herdr`) materializes a viewer pane attached to the session; closing the pane detaches the viewer only.

## Phases
1. **P1 (Complete)**: Execution decoupling (`src/registry.js`, `src/runner.js`, `src/governor.js`, Section 6 monitor in `src/board.js`, `/agents/api/register` + RAM monitor in `dashboard/`).
2. **P2 (Current)**: Unified `roostrd` control plane, `src/board/*` modular split + built-in log-tail/TTY viewer, TUI/Web Spawn Drawer with empirical model/effort picker, Web Approvals (`routine` vs `big-decision` + 60s poll/hibernate/wakeup + Chicken-Grill bridge), optional `src/viewers/herdr.js` demotion, and `verify.sh --public` clean pass.
