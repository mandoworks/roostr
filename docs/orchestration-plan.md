# Orchestration plan: Session Storage & Recovery + Web & TUI Dashboard Improvements + Muse Agents Workflow

Four parallel Hydrogen (`agy`) workers (`gemini-4-hydrogen-medium` / `gemini-4-hydrogen-low`) supervised by `roosty-argon` (`gemini-4-argon-medium`) in `/home/ubuntu/workspace/roostr`.

## Goal and done check

1. **Session Storage & Recovery (`pkg-session-recovery`)**:
   - Auto-detect and persist session IDs + exact models for `agy` (`~/.gemini/antigravity-cli/brain/`), `claude` (`~/.claude/projects/`), `opencode`, and `kilo` in `~/.roostr/sessions.json` and `~/.roostr/backups/`.
   - Pass `--model`, `--effort`, and `--conversation` / `--resume` / `--session` in `sessions.agentArgs(s)`.
   - Auto-save `~/.roostr/sessions.json` during `roostr --json` and `roostr workers` (so `roostr-publish.timer` persists live sessions every 60s even when no TUI board is open) and attach active orchestration task/worktree/handoff metadata.
   - Extend `roostr log` (`src/session-log.js`) to support `--kind agy|claude|opencode|kilo|all` so both CLI and TUI can list and resume `agy` and `claude` conversations.
2. **TUI Board Log & Backup Recovery Upgrades (`pkg-tui-recovery-ui`)**:
   - Upgrade `[L log]` and `[B backups]` drawers in `src/ui.js` and `src/board.js` to show `agy` and `claude` sessions alongside `opencode` and `kilo`, display session ID / model / handoff badges, and show inline restore/resume status.
3. **Web Dashboard Backend: Sessions, Recovery & Muse Agents API (`pkg-web-backend-muse`)**:
   - Add `/agents/api/sessions`, `/agents/api/sessions/restore`, and `/agents/api/backups/capture` to expose saved sessions (`~/.roostr/sessions.json`), resumable conversations, workspace backups, and active orchestration tasks/handoffs.
   - Enhance `POST /agents/api/pane/:id/start` with optional `model`, `effort`, and `session` resume args, and add `POST /agents/api/pane/:id/split` for spawning panes from the web UI.
   - Add `GET /agents/api/muse` and `POST /agents/api/muse/message` (`dashboard/src/muse.js`) to unify Muse agents (`data.json` `roman_desk`/`tier1`/`tier2`, `workers/workers.muse.json`, `status.json`, `names.json`) into `/agents/control/` and dispatch tasks/messages via PioRelay (`PIORELAY_BASE`).
4. **Web Control UI: Collapsible Panes, Agent Management & Muse Workflow (`pkg-web-control-ui`)**:
   - Collapsible workspaces, tabs, Muse desks, and detail sections (`Collapse All` / `Expand All`, persisted in `localStorage`) + search/host/status filter bar + batch cleanup of dead `(deleted)` panes.
   - Session & Backup Recovery panel in `/agents/control/` (1-click Resume Saved Session vs Start Fresh with tool/model/effort selector, Capture Backup, Restore Workspace Sessions, Split Pane, and quick command chips like `Shift+Tab` accept-edits, `/model`, `/clear`, `/new`).
   - Full Muse Agents workflow tab/view in `/agents/control/` and `/agents/names.html` showing live status, session ID, tasks (`in-progress`, `blocked`, `done`), collapsible `SOUL.md`/`AGENT.md`/`STATE.md` docs, inline canonical name/orchestrator controls, and direct PioRelay task/message dispatch.
5. **Done check**:
   - All 4 worker branches pass `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` with 0 failures, merge cleanly into `main`, and deploy to `/home/ubuntu/roostr-dashboard/` (`roostr-dashboard.service` restarted).

## Routing rationale

- `pkg-session-recovery` (`feature`, `gemini-4-hydrogen-medium`): session discovery and persistence across `src/sessions.js`, `src/session-log.js`, `src/workers.js`, and `bin/roostr`.
- `pkg-tui-recovery-ui` (`ui`, `gemini-4-hydrogen-low`): TUI `[L log]` and `[B backups]` drawer formatting and key handling in `src/ui.js` and `src/board.js`.
- `pkg-web-backend-muse` (`feature`, `gemini-4-hydrogen-medium`): HTTP routes, validation, Herdr resume/split args, and Muse/PioRelay integration in `dashboard/src/` + unit tests.
- `pkg-web-control-ui` (`ui`, `gemini-4-hydrogen-medium`): collapsible pane/workspace/Muse UI, session recovery controls, orchestration progress, and Muse workflow view in `dashboard/public/`.
