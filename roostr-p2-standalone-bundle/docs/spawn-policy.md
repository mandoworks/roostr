# Spawn Policy: Guiding Instructions for Every Orchestrator and Subagent

One page. Every agent that spawns or is spawned works under this policy.
Spec: `docs/roostr-standalone.md`.

## The Rules

1. **Headless by default.** Subagents and workers run in the background (`roostr run`, detached, no terminal pane). A pane is an optional viewer for a human, not a runtime.
2. **Pick or accept empirical `(tool, model, effort)`.** Before spawning, run `roostr recommend "<task>" --kind <kind>` (or use the TUI `[S spawn]` / Web `+ Spawn Worker` drawer) so tool, model, and effort follow empirical pass-rate and cost-per-pass data.
3. **Pane only with a reason.** Request a pane only when a human must watch or steer live (`needs_human: <why>`). Budget on macOS is 3 live panes; the Roostr governor can refuse or queue a pane request. Accept the refusal and run headless.
4. **Register before you start.** Every run registers with Roostr (`/agents/api/register`), heartbeats while working, and reports a terminal state (`/agents/api/status`: `done` | `failed` | `blocked`) with pointers to its artifacts.
5. **Placement: OVH unless Mac-bound.** Run where the RAM is (`ovh` default). Request `mac` only when the task requires local macOS hardware or apps (`--mac-reason <why>`).
6. **Your viewer can be closed; your session cannot be lost.** Idle panes are reaped after 30 minutes at a prompt. Sessions persist on disk and resume from the `sessionId` in your registry entry.
7. **Never sit on a terminal prompt (60s Poll -> Zero-RAM Hibernate).** If you need approval, file an approval request (`roostr approval request`) with `action`, `command`, `cwd`, `riskClass`, and `context`. For `routine` actions, `roostr approval wait` long-polls up to 60 seconds; if undecided after 60 seconds (or immediately for `big-decision`), exit `0` so your process frees 100% of its RAM while `roostrd` wakes and resumes your `sessionId` automatically once decided.
8. **Risk classes are hard lines.**
   - `routine` = build/test/git inside a worktree, restarts, reads. Approvable on OVH scope by the resident operator (`Hermita`) or by human passkey; Mac `routine` requires human passkey.
   - `big-decision` = publishing, credentials or access changes, money, deleting data, external outreach. Human passkey session only (no token self-approval, no inferring consent from silence). Automatically alerts Web Push / Pushover + lead orchestrator PioRelay, and may be escalated into a Chicken-Grill spec session. Expired approvals (`24h TTL`) become `denied-timeout`.
9. **Report outcomes, not intentions.** Terminal report = what changed, where the artifacts are, and what is still open.

## For Orchestrators
- Spawn workers under the agent who owns the domain; the owner holds the context and the board attributes the run to the owner.
- One orchestrator per project reports upward.
- When a host is under swap pressure, stop spawning panes first, headless second, and state so in your report.
