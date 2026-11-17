# Roostr Standalone

Spec — Armando Gonzalez, via Roman, 2026-11-17. Status: approved to build (phases below).
Owner: Roosty. Orchestrator: Roman. Resident operator on OVH: Hermita.

## Problem

Agent execution is coupled to herdr panes, and panes are expensive windows:

- Every herdr pane running OpenCode/Kilo holds a full runtime resident in RAM
  even at 0% CPU. Measured on Armando's Mac (16 GB), 2026-11-17: one `.kilo`
  pane at 6,140 MB, seven `opencode` panes at ~8,700 MB combined, swap
  19,456 MB total / 18,649 MB used. The machine lags under its own crew.
- A pane is a *viewer* — for watching, steering, answering prompts, taking
  control. Background workers need none of that, but today they pay for it.
- Closing a pane to reclaim RAM hides the agent. Visibility and execution
  are fused, so resource management and observability fight each other.

## Goal

Roostr runs agents **without herdr as its runtime substrate**. Registry,
execution, resource governance, and approvals live in Roostr. Herdr becomes
an optional viewer adapter: a pane is opened when a human wants eyes on a
session, and closing it never kills the agent.

Non-goals: Roostr Standalone does not replace PioRelay (agent mail),
MuseSight (memory), or the /agents board (Muse-desk visibility). No public
exposure: tailnet + the existing passkey gate only.

## Architecture

### 1. Registry and heartbeat (exists — build on it)

Agents register and report through the reporting contract already in flight:
`POST /api/register` and `POST /api/status` with the `X-Roostr-Token` header.
A registered agent has: id, owner/orchestrator, host, task, session id
(resume handle), state (working / waiting-approval / idle / done / failed),
and last heartbeat. The board renders registry truth, badged "reported",
with the existing daily reconciliation as backstop.

### 2. Headless runner

- The runner launches agents detached and headless
  (`opencode run ... < /dev/null`, or the equivalent per CLI), captures
  stdout/stderr to per-agent log files, and records the session id so the
  run can be resumed interactively later. Sessions persist on disk; a run
  without a pane loses nothing.
- Placement rule: **OVH by default** (that is where the RAM is). Mac
  execution only for Mac-bound work: Edits, local files, iMessage/WhatsApp,
  device tooling. The spawn request names its placement reason when it asks
  for the Mac.
- Hermita is the resident operator for OVH-placed agents; Roman for
  Muse-side desks. Roostr is the shared truth both read.

### 3. Resource governor

- Per-host budgets in Roostr config. Mac defaults: at most **3 live panes**,
  and a swap-pressure threshold fed by the Swapy census (PhysMem free +
  swap used, published from the Mac every 2 min).
- **Idle reaper:** a pane sitting at a prompt past the idle threshold
  (default 30 min) is closed and logged. Its session resumes from disk on
  demand. Headless runs are exempt — they hold no pane.
- The governor refuses or queues a pane spawn that would break budget and
  says why on the board, instead of letting the host swap itself to death.

### 4. Approvals on the web dashboard

Approval prompts must stop living inside terminal panes (today an agent can
sit parked on a prompt, invisible, doing nothing — e.g. a git commit prompt
in a worktree).

- An approval is a first-class Roostr object: `{agent, host, action,
  command, working directory, risk class, context, requested at, expires
  at}`. A runner that needs approval files the object and **keeps working
  on anything else**; it polls/long-polls the object's state instead of
  blocking on a terminal.
- The existing passkey-gated Roostr web dashboard gains an **Approvals**
  queue: pending approvals with full context, **Approve / Deny** buttons,
  and a decision log. Armando approves from the web (including from his
  phone) — no pane, no laptop required.
- Risk classes:
  - `routine` — build/test/git inside a worktree, restarts, reads. May be
    approved from the dashboard by Armando or by Hermita (OVH scope).
  - `big-decision` — publishing, credentials or access changes, money,
    deleting data, contacting outside people. **Armando only.** These also
    keep flowing to Roman's decision inbox as today.
- Unanswered approvals expire (default TTL 24 h) to a denied-by-timeout
  state, never to silent approval. Every decision is logged with who,
  when, and the exact action approved.

### 5. Herdr as viewer adapter

- "Open in herdr" on any board row materializes a pane attached to that
  agent's live session (or resumes it from its session id). Closing the
  pane detaches the viewer only.
- Roostr must boot, register agents, run headless work, and serve
  approvals with **herdr entirely stopped**. That is the standalone test.

### 6. The board is the monitor (replaces watching panes)

Headless workers have no pane to glance at, so the Roostr board becomes
the monitoring surface — this is a requirement, not a byproduct:

- One row per worker: owner/orchestrator, task, host, state, heartbeat
  age, session id (resume handle), and **RAM use (RSS)**, sortable by RAM.
- RAM truth comes from a per-host process census: on the Mac, the Swapy
  census (already publishing PhysMem + swap + per-process RAM every
  2 min); on OVH, the runner reports RSS for each agent process it owns.
  The board joins worker ↔ PID ↔ RSS; host headers show PhysMem free and
  swap used, so pressure is visible before the machine starts lagging.
- Actions on a row: view log tail, open in herdr (viewer adapter),
  resume session, reap/kill (with the Swapy rule: PID + command must
  match what the board shows at click time).
- Every kill/reap lands in the closed-session log: time, PID, command,
  model, RAM held, resume handle.

## Phases

1. **P1 — execution decoupling (the swap fix).** Registry + headless runner
   + placement rules + resource governor with the Mac pane budget and idle
   reaper. Existing pane-based agents keep working; new spawns default
   headless per `docs/spawn-policy.md`.
2. **P2 — dashboard approvals.** Approval objects, runner polling, the
   Approvals queue on the web dashboard, risk classes, decision log.
3. **P3 — herdr demotion.** Viewer adapter ("open in herdr"), migration of
   standing Mac panes to headless + on-demand panes, standalone test
   (herdr stopped) proven on OVH and on the Mac.

## Acceptance

- Mac swap stays bounded through a normal workday with the crew running:
  no pane count above budget, reaper log shows idle closes, no agent lost
  (every closed pane's session resumable from its registry entry).
- An agent files an approval from a headless run; Armando approves it from
  the web dashboard on his phone; the run proceeds; the decision is in the
  log. No terminal prompt was involved.
- With herdr stopped on OVH, Roostr registers agents, runs a headless task
  to completion, and serves the board + approvals queue.

## Open questions

- Approval TTL and idle-reaper thresholds: defaults above; Armando tunes
  after the first week of logs.
- Whether routine-class approvals by Hermita cover Mac-placed agents or
  OVH only (spec assumes OVH only until Armando rules otherwise).
