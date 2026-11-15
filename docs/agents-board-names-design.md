# /agents board: orchestrator names, drill-down, and orchestrator handoff

Design for the /agents dashboard on OVH and for the Roostr skill's orchestrator handoff. The board becomes an orchestrator roster, not a list of every agent. Each orchestrator can be renamed from the board with a durable correction, clicked to see its workers, and replaced cleanly when a model or usage limit forces a handoff.

## Summary

The /agents page today merges two sources, a generated roster (`data.json`) and live announcements (`status.json`), and neither can be corrected. This design adds a single override map on OVH, written by a small editor at `/agents/names.html`, read by the announcing service and by the page, with drift detection, history and revert, and an explicit orchestrator list that drives both the roster view and the worker drill-down. Worker state is published per host as `workers.<host>.json` and merged by the page. Separately, the Roostr skill gains an orchestrator handoff: a compact brief plus a pointer to the raw session export, written to `docs/orchestration/handoffs/` on a manual command and on automatic triggers, linked from the Roostr backup versions so a successor can restart the work even when the agent session cannot be resumed.

## Terms

- **orchestrator**: the pane owner Armando designates for a project, who introduces itself on PioRelay and posts its own state. Avoid: boss, manager, lead agent.
- **slug**: the stable lowercase id used by Herdr, the relay and agent-status, for example `roosty` or `la-guardiana`. Avoid: handle, username.
- **agent name**: the canonical display name for a slug, the one thing a correction changes everywhere. Avoid: nickname, title.
- **announce label**: the free-text line in a status event, which today mixes identity and current task. Avoid: status text, message.
- **roster**: the persistent-agent list in `data.json` (`tier1`), with names, roles and states, regenerated about every 5 minutes. Avoid: directory, catalog.
- **override map**: one record per slug holding corrections, stored on OVH as `names.json`. Avoid: patch file, exception list.
- **handoff brief**: the compact orchestrator state written so a successor can take over. Avoid: summary, notes.
- **worker snapshot**: the per-host published list of live worker panes and their task state. Avoid: pane dump, scrape.

## Why

Armando's words: the dashboard "should allow us to fix any orchestrator/agent name", "it needs to stay refreshed", and "only orchestrators show up on the webui or can have their name changed, ideally we can also click on an orchestrator and see what the workers under him are doing". Later, while designing the refresh path, he added that "sometimes we run out of usage and need to make another model the orchestrator and we need to make this experience seamless". A wrong name is visible to every reader of the board, and a model swap at a usage limit currently loses the orchestrator's working state.

## Locked decisions

### One canonical name per slug

Decision: one override record per slug, applied to the roster name and to the announcement rendering. Rejected: roster-only and announce-only edits, because each leaves the other source wrong and dies at the next regeneration. Two separate editable names were rejected because they let the two names drift again, which is the original failure.

### Separate name field, never a rewritten label

Decision: announcements keep `label` as free text and the published agent object gains a separate `name`, rendered as `Name · label`. Rejected: prefixing the canonical name into the label (re-breaks when a task contains the separator), replacing the label entirely (loses what the agent is doing), and roster-only display (leaves the board wrong).

### Edit authority is a shared token

Decision: a shared edit token for Armando, Roosty and Roman, stored in `~/.secrets` and entered once per browser. Rejected: open tailnet writes (typos from many agent seats), Armando-only local file edits (removes the dashboard fix), and edit only by Roosty or Roman (puts a human in the loop for a cosmetic correction).

### One `names.json` on OVH, two readers

Decision: `names.json` lives on OVH. `agent-status` merges it into `status.json`, and the /agents page overlays it onto the roster at read time. Rejected: browser-only overlay (every other consumer ignores the fix), overrides owned by Roman's generator (blocks on his cadence), and PioRelay as the source (ties a display name to a mailbox schema).

### Drift is visible, the override wins

Decision: the override stays authoritative, but the editor compares it with the underlying name and flags drift, with one click to accept or clear. Rejected: permanent silent override (masks legitimate source renames), 30-day expiry (turns a correct fix back into a bug on a timer), and forbidding overrides for roster names (removes the fix where it is most needed).

### Only orchestrators are shown and editable

Decision: the board and the editor cover orchestrators only. The designation is an explicit list edited on the same page, set when Armando designates a pane. Rejected: inferring from relay `default_project` (marks one seat today), role text keywords (guessing), and Herdr pane role (only sees machines running Herdr).

### A hard rename is a single recorded ceremony

Decision: one action writes the map, retires the old slug on the relay with a note, creates the new seat, updates pane labels, and records the whole thing with one timestamp. Rejected: manual steps (half-renamed agents), two-step retire then create (half-named in between), and silent retention of the old seat (mail goes to a dead seat).

### The slug can be renamed, with full knowledge of the cost

Decision: q10 chose changing the handle, and q13 chose a hard rename. Verified: the relay has no alias support and the slug keys Herdr agent names and session resume, so a rename retires the old seat and drops session continuity. The ceremony must state this before it runs.

### Retired slugs stay visible for 30 days

Decision: show retired slugs with a retired badge for 30 days, then hide them, keeping them in the names history. Rejected: hiding immediately (loses the trail), a separate archive list (nobody opens it), and keeping them identical to active agents (dead seats compete with live ones).

### Worker snapshot per host

Decision: each host writes `workers.<host>.json` into the OVH static folder; the page merges by host and ignores files older than 90 seconds. Rejected: a new ingest endpoint (extra service and token), workers over PioRelay (mailbox churn), and OVH-only for now (fails the Muse-side requirement).

### Handoff brief plus a pointer to the raw export

Decision: the handoff is a compact brief with role, live plan, task states, blocked-on, open decisions, last actions and file pointers, plus a pointer to a raw session export. Rejected: brief only (hides detail behind a summary), transcript only (floods a fresh context), and last N messages (loses the older decisions that caused the state).

### Handoffs live with the project

Decision: `docs/orchestration/handoffs/<slug>-<timestamp>.md` plus a latest pointer. Rejected: central OVH storage (separates the brief from the code), relay attachments (document as mailbox traffic), and local-only state (dies with the machine).

### Manual and automatic handoff writes

Decision: a manual command or keybind, plus automatic writes when context or usage crosses a threshold, on quota failure, and on pane close, with a minimum interval and debounce. Rejected: manual only (fails at 3am), every status change (token burn and churn), and only on close (the context is already gone).

### Handoff pointers inside backup versions

Decision: Roostr backups keep layout and session references, and each version stores the path to the current handoff brief for that pane. Rejected: embedding the whole brief and transcript in every version (duplication), backups generating their own brief (two writers), and no link (restored workspace with no idea what was in flight).

## Routine choices

- Refresh: 10-second announcement polling and a 60-second roster. The roster interval requires Roman to move the generator from 5 minutes to 1.
- Editor surface: a small standalone `/agents/names.html`, linked from the dashboard, posting to the new endpoint. It can be folded into the SPA later. The /agents bundle already runs on OVH as static files; only its source and build are on Roman's side, and the ask to move the build to OVH goes to Roman.
- Eligible slugs: the union of roster, announcements and relay seats, searchable, so an orchestrator can be named before its first announcement. A name typed for an unknown slug is rejected.
- History and revert: append every change to a names history and offer one-click revert of the last change.
- Editor scope: the override record stores the name only and is shaped as a partial record so role and emoji can become editable later. Role and emoji are inherited from the roster and render unchanged.
- Backup cadence: a systemd user timer on each host captures every 5 minutes, writing only when the layout changed.
- Backup and handoff relationship: each backup version stores the handoff brief path, not its contents.

## Verified facts

- The /agents page is a built Vite SPA served statically from `/home/ubuntu/service-directory/agents`. It fetches `./data.json` (roster, roles, tier2 runs, monitor totals, library) and `/agent-status/status.json` every 30 seconds with `cache: no-store`, and states that data refreshes every 5 minutes.
- Names exist twice: `data.json` `tier1[].name` and `status.json` `agents[slug].label`. Neither has an edit path.
- `agent-status` (`/home/ubuntu/agent-status/agent_status_server.py`, systemd `agent-status.service`, `127.0.0.1:8955`) accepts `POST /announce` with `agent`, `state`, `label`, optional `ref` and `source`, appends to `events.jsonl`, and republishes `/home/ubuntu/service-directory/agent-status/status.json` atomically.
- `status.json` keys agents by slug under `agents`, and each event carries `agent`, `state`, `label`, `source`, `at_epoch`, `at_ast`.
- The roster marks no orchestrator role. `role` strings are job descriptions; `tier2` runs carry `parent_agent_id` and `child_agent_id` as opaque ids plus display-name agents.
- `data.json` is owned by `ubuntu` and rewritten every few minutes, but no writer exists in ubuntu's crontab, visible processes, or systemd units, so it is generated off-box, most likely on Roman's side, and pushed here.
- The relay backend has no alias support. A slug is also the Herdr agent name and the session-resume key.
- Herdr 0.9.5: detach keeps processes alive; a server restart restores layout and cwd and, with `resume_agents_on_restore` on by default, resumes native agent sessions through official integrations (`OpenCode` integration v5, `Claude Code` v6, `Kilo Code CLI` v1). It keeps 48 layout snapshots about 15 minutes apart for manual recovery. Pane screen history is off by default because it can contain secrets.
- Roostr backup: per-workspace versions under `~/.roostr/backups`, last 4 kept. A version records tabs, the split tree with direction and ratio, pane cwd and label, and for agent panes kind, name, task, effort, exact model and session id. Capture runs from the live board (`src/board.js`) and before a respawn (`src/respawn.js`). Restore builds a new workspace named `"<label> *restored"` and resumes each agent with its native command.
- On OVH, Herdr was down at the time of the first relay introduction, then came back; the snapshot then listed 18 agents. The editor and drill-down must tolerate a down Herdr without inventing data.

## Risks

- The hard rename ceremony crosses the names map, the relay, Herdr and pane labels. A partial failure must be visible and retryable, or the board shows a half-renamed agent.
- The edit token has a broad blast radius: it writes display names and triggers relay and Herdr actions. A leaked token can rename or retire seats.
- Two readers of `names.json` (the service and the page) can disagree if the shape changes. The shape is versioned.
- `workers.<host>.json` can go stale or lie if a host dies. The 90-second rule is the only guard, and it must be visible in the UI when a host is stale.
- Backups only capture while the board or a respawn runs today. The timer closes that gap but must be installed and monitored per host.
- Native session resume depends on current Herdr integration versions. A stale OpenCode integration turns a restore into a fresh shell with no conversation.
- A slug rename drops relay history and session continuity by design. The ceremony must say so before it runs.
- The roster generator is outside OVH. Applying overrides there depends on Roman's schedule and build.

## Deferred

- Moving the /agents source and build to OVH: reopen when Roman provides the repo, or when the standalone editor has been used enough to justify folding it into the SPA.
- The expanded self-registration API Roman is speccing: reopen when he sends its shape, then switch the announce path.
- Editing role and emoji from the board: reopen when a wrong role is reported, using the partial record shape.
- Ingesting Herdr's own 48 layout snapshots as extra Roostr restore points: reopen if restore ever loses a layout that Herdr still had.

## Open threads

None. Every question in the grill was answered.
