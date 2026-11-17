# Spawn Policy — guiding instructions for every orchestrator and subagent

One page. Every agent that spawns or is spawned works under this policy.
Spec: `docs/roostr-standalone.md`. Ruled by Armando, 2026-11-17.

## The rules

1. **Headless by default.** Subagents and workers run in the background
   (detached, no terminal). A pane is a viewer for a human, not a runtime.
2. **Pane only with a reason.** Request a pane only when a human must
   watch, steer, or answer you live. Name the reason in the spawn request
   (`needs_human: <why>`). Budget on the Mac is 3 live panes; the Roostr
   governor can refuse or queue you. Accept the refusal and run headless.
3. **Register before you start.** Every run registers with Roostr
   (`/api/register`), heartbeats while working, and reports a terminal
   state (`/api/status`: done / failed / blocked) with pointers to its
   artifacts. Unregistered work is invisible work.
4. **Placement: OVH unless Mac-bound.** Run where the RAM is. Ask for the
   Mac only when the task needs the Mac itself (Edits, local files,
   iMessage/WhatsApp, devices) and say so in the spawn request.
5. **Your pane can be closed; your session cannot be lost.** Idle panes
   are reaped (30 min at a prompt). Sessions persist on disk and resume
   from the session id in your registry entry. Never treat a closed pane
   as lost work, and never hold RAM just to stay visible.
6. **Never sit on a terminal prompt.** If you need approval, file an
   approval request with Roostr (action, command, directory, risk class,
   context) and keep working on everything else. Check the decision
   asynchronously.
7. **Risk classes are hard lines.** `routine` = build/test/git inside a
   worktree, restarts, reads. `big-decision` = publishing, credentials or
   access, money, deleting data, contacting outside people — Armando
   only, no exceptions, no self-approval, no inferring consent from
   silence. An expired approval is a denied approval.
8. **Report outcomes, not intentions.** Terminal report = what changed,
   where the artifacts are, and what is still open. Short, factual, with
   file/repo pointers instead of pasted bulk.

## For orchestrators

- Spawn workers under the agent who owns the domain; the owner holds the
  context and the board attributes the run to the owner.
- One orchestrator per project reports upward; pane-level agents do not
  each report separately.
- When a host is under swap pressure (Roostr board shows it), stop
  spawning panes first, headless second, and say so in your report.
