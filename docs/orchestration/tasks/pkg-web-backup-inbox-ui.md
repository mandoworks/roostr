# Task pkg-web-backup-inbox-ui

- Owner: Fernando (`fernando`), `gemini-4-hydrogen-medium`, branch `crew/fernando`
- Report: `docs/orchestration/reports/pkg-web-backup-inbox-ui.md` ending with `FERNANDO_DONE` or `FERNANDO_BLOCKED`

## Scope (touch ONLY `dashboard/public/control/{index.html,style.css,app.js}` and your report)

1. **1-Click Backup Capture & Workspace Restore in `#orchestration-details` (`index.html`, `style.css`, `app.js`)**:
   - In the `#orchestration-details` section (`Saved Sessions, Backups & Orchestration Tasks`):
     - Add a toolbar with:
       - **`#capture-backup-btn` ("Capture Backup Now")**: calls `POST /agents/api/backups/capture`, disables button while in flight, shows feedback toast/status, and refreshes `GET /agents/api/sessions`.
       - **Workspace Restore form (`#restore-workspace-form`)**: a workspace selector/input (`#restore-workspace-select`, populated from saved sessions & backups plus `"all"`), mode select (`#restore-mode-select`: `sessions` = "Restore Saved Sessions in Workspace", `backup` = "Rebuild Workspace from Latest Backup"), and **`#restore-workspace-btn` ("Restore Workspace")** calling `POST /agents/api/sessions/restore`.
     - On each workspace backup row in `#backups-list`, add an inline **"Restore Backup"** button that calls `POST /agents/api/sessions/restore` with `{ workspace: b.workspaceId || b.label, mode: 'backup' }`.
     - Show each saved session's `tab` / `tabId` badge when present so multi-tab sessions are clearly labeled.
2. **Two-Way PioRelay Inbox / Thread Viewer in `#muse-detail-body` (`index.html`, `style.css`, `app.js`)**:
   - Inside `#muse-detail-body`, add a collapsible `<details id="muse-inbox-details" class="sub-panel" open>` section titled **"Recent PioRelay Messages & Thread"**:
     - Include a **`#muse-inbox-refresh-btn` ("Refresh Inbox")** button and a `#muse-inbox-list` container.
     - Whenever a Muse agent is selected (`selectMuseAgent(slug)`), fetch `GET /agents/api/muse/messages?agent=<slug>&limit=20` (and also refresh after sending a message via `#muse-message-form`).
     - Render each message with `from -> to` badges, timestamp, project pill, subject (bold), and message body, plus a **"Reply in Form"** button that pre-fills `#muse-msg-subject` (`Re: ...`) and `#muse-msg-project` in `#muse-message-form`!
     - If the relay returns `502` or empty, show a clean muted status line inside `#muse-inbox-list` without throwing unhandled errors.
3. **Multi-Tab Clarity in Sidebar Pane List (`app.js`)**:
   - Ensure tab headers (`tab-title`) in `renderPaneList` clearly show the tab number AND custom label (e.g. `Tab 1`, `Tab 3 · migration (9 panes)`) and show a count badge of panes/agents inside each collapsible tab group so multi-tab workspaces (`w2` with `t1`, `t2`, `t3 · migration`) are crystal clear.
4. **Compatibility & Rules**:
   - Preserve all existing DOM IDs required by `dashboard/test/app.test.js`.
   - Respect `Content-Security-Policy: default-src 'self'` (no inline `onclick=` or inline `<style>`).
   - No em dashes (`—`) anywhere. Run `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
(cd dashboard && npm test)
env -u HERDR_ENV ./verify.sh
```
