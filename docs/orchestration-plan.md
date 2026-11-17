# Orchestration plan: Multi-Tab Board & Session Recovery + Web Backup/Restore + Two-Way Muse Inbox

Three parallel Hydrogen (`agy`, `gemini-4-hydrogen-medium`) workers supervised by `roosty-argon` (`gemini-4-argon-medium`) in `/home/ubuntu/workspace/roostr`. Keep repo private on OVH (do not push to public remotes).

## Goal and done check

1. **Multi-Tab Agent Detection, Display & Restore (`pkg-multitab-board`)**:
   - Fix `selectAgents` / `collect` in `src/board.js` so agents across **all tabs** (`t1`, `t2`, `t3`, etc.) are included on the board: merge `snap.agents` with any pane in `snap.panes` (across all tabs of the workspace) that has `pane.agent`, `pane.agent_session`, `pane.restore_error`, a live agent child process in `ram.processTable()`, a `roostr report`, a saved entry in `sessions.json`, or a crew tag/label (`TAG_RE`).
   - Add `tabId`, `tab` (tab label/number from `snap.tabs`), and `tabNumber` to every board row in `src/board.js`, sort rows by `(workspace, tabNumber, pane)`, and render `[t2]` / `[tab 3 · migration]` tab badges/headers when a workspace has multiple tabs or a named tab.
   - Make `herdr.focusAgent(paneId)` in `src/herdr.js` fall back to `herdr pane focus <paneId>` so jumping to a pane on another tab works even if the agent process exited.
   - Save `tabId` and `tab` on every session in `src/sessions.js`, restore multi-tab sessions into their respective tabs in `restoreSessions`, and support reading `~/.local/share/opencode/opencode.db` (`session_v2` and `session` across all directories) in `sessionList('opencode')`.
2. **Web Backend: 1-Click Backup Capture, Workspace Restore & Two-Way Muse Inbox (`pkg-web-backend-inbox-api`)**:
   - Add `POST /agents/api/backups/capture` and `POST /agents/api/sessions/restore` in `dashboard/src/sessions-bridge.js` and `dashboard/src/app.js`.
   - Add `GET /agents/api/muse/messages` (`?agent=<slug>&limit=20`) in `dashboard/src/muse.js` and `dashboard/src/app.js` to fetch recent PioRelay inbox/thread messages for any Muse agent or `roman`.
3. **Web Control UI: Backup/Restore Controls, Tab Badges & Muse Inbox (`pkg-web-backup-inbox-ui`)**:
   - Add **Capture Backup** and **Restore Workspace Sessions / Backup** buttons in `#orchestration-details` in `dashboard/public/control/index.html` and `dashboard/public/control/app.js`.
   - Add a **Recent PioRelay Messages / Thread** section inside `#muse-detail-body` with a Refresh button and message list (`from -> to`, timestamp, subject, body, project).
4. **Done check**:
   - All 3 branches pass `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` with 0 failures, merge cleanly into `main`, deploy to `/home/ubuntu/roostr-dashboard/`, and update `roostr-publish.service`.
