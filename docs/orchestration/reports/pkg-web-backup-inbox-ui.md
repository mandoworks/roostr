# Report: pkg-web-backup-inbox-ui

- Owner: Fernando (`fernando`)
- Branch: `crew/fernando`
- Status: Complete

## Changes Made

1. **1-Click Backup Capture & Workspace Restore (`dashboard/public/control/index.html`, `dashboard/public/control/style.css`, `dashboard/public/control/app.js`)**:
   - Added `.orch-toolbar` inside `#orchestration-details` with:
     - `#capture-backup-btn` ("Capture Backup Now") calling `POST /agents/api/backups/capture`, disabling the button while in flight, updating `#orchestration-status`, and refreshing `GET /agents/api/sessions` and the audit log.
     - `#restore-workspace-form` with `#restore-workspace-select` (populated from saved sessions and backups plus `"all"`), `#restore-mode-select` (`sessions` and `backup`), and `#restore-workspace-btn` ("Restore Workspace") calling `POST /agents/api/sessions/restore`.
   - Rendered backup rows inside `#backups-list` with an inline **Restore Backup** button calling `POST /agents/api/sessions/restore` with `{ workspace: b.workspaceId || b.label, mode: 'backup' }`.
   - Added a `tab: ...` badge to saved session rows in `renderOrchestrationDrawer` whenever `s.tab` or `s.tabId` is present.

2. **Two-Way PioRelay Inbox / Thread Viewer (`dashboard/public/control/index.html`, `dashboard/public/control/style.css`, `dashboard/public/control/app.js`)**:
   - Added `<details id="muse-inbox-details" class="detail-section sub-panel" open>` inside `#muse-detail-body` titled **Recent PioRelay Messages & Thread**, containing `#muse-inbox-refresh-btn` ("Refresh Inbox"), `#muse-inbox-status`, and `#muse-inbox-list`.
   - Added `loadMuseInbox(slug)` fetching `GET /agents/api/muse/messages?agent=<slug>&limit=20` on `selectMuseAgent(slug)`, on `#muse-inbox-refresh-btn` click, and after sending a message via `#muse-message-form`.
   - Rendered messages with `from -> to` badge, timestamp, optional project pill, bold subject, message body, and a **Reply in Form** button that pre-fills `#muse-msg-subject` (`Re: ...`) and `#muse-msg-project` and focuses `#muse-msg-body`.
   - Handled `502`, non-OK, network errors, and empty lists cleanly with muted status text inside `#muse-inbox-list` without throwing unhandled errors.

3. **Multi-Tab Clarity in Sidebar Pane List (`dashboard/public/control/app.js`, `dashboard/public/control/style.css`)**:
   - Updated `renderPaneList` and `buildCollapseHeader` so tab headers use the `tab-title` class, format tab number and custom label (e.g. `Tab 1`, `Tab 3 · migration`), and always include a pane count badge (`N pane` / `N panes`) in each collapsible tab group.

## Verification

- `node --check dashboard/public/control/app.js`: exited 0
- `(cd dashboard && npm test)`: exited 0 (32 tests across 11 suites passed)
- `env -u HERDR_ENV ./verify.sh`: exited 0 (ALL CHECKS PASSED)

FERNANDO_DONE
