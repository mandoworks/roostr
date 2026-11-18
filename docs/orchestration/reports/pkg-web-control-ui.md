# Report: pkg-web-control-ui

- Owner: Fernando (`fernando`)
- Branch: `crew/fernando`
- Status: Complete

## Changes Made

1. **`dashboard/public/control/index.html`**
   - Added `#sidebar-toggle-btn` in the topbar to collapse/expand `#sidebar-panel`.
   - Added sidebar view mode tabs (`#view-tabs`: All, Panes, Muse), `#pane-filter` search input, `#status-filter` status select (`all`, `working`, `blocked`, `idle`, `done`, `shell`), `#collapse-all-btn`, `#expand-all-btn`, and `#clean-dead-shells-btn`.
   - Added `#muse-list` container in the left sidebar below `#pane-list`.
   - Made right-hand pane sections collapsible `<details open class="detail-section">` (`#recovery-details`, `#screen-details`, `#keys-details`, `#prompt-details`).
   - Added `#session-panel-toggle-btn` ("Session / Model / Split") to `#detail-tools`.
   - Upgraded `#start-agent-form` with `#start-agent-model` (`datalist#model-presets`), `#start-agent-effort`, `#start-agent-session`, `#split-right-btn`, and `#split-down-btn`.
   - Added quick command chips (`Shift+Tab (Accept Edits)`, `/model medium`, `/clear`, `/new`) above the quick keys grid.
   - Added `#muse-detail-body` with `#muse-detail-header`, `#muse-override-form`, `#muse-summary-card`, `#muse-tasks-details`, `#muse-message-form` (PioRelay), and `#muse-docs-details` (`SOUL.md`, `AGENT.md`, `STATE.md`).
   - Added `#orchestration-details` drawer for Saved Sessions, Workspace Backups, and Orchestration Tasks, plus `#clean-shells-dialog` confirmation modal.
   - Preserved all required DOM IDs (`#pane-list`, `#pane-screen`, `#prompt-form`, `#prompt-input`, `#close-pane-btn`, `#start-agent-form`, `#start-agent-name`, `#start-agent-kind`, `#rename-form`, `#audit-details`, `#sign-out-btn`).

2. **`dashboard/public/control/style.css`**
   - Added styles for `.sidebar-collapsed`, `.view-tabs`, `.tab-pill`, `.filter-row`, `.sidebar-actions-row`, `.collapse-toggle`, `.detail-section`, `.quick-chips`, `.chip`, `.split-actions`, `.muse-header-card`, `.muse-summary-card`, `.muse-tasks-list`, `.muse-docs-container`, `.orch-row`, and `.btn-link`.

3. **`dashboard/public/control/app.js`**
   - Implemented collapsible workspace, tab, and Muse groups persisted in `localStorage` under `roostr_collapsed_ws`, plus Collapse All / Expand All and Sidebar Collapse toggle.
   - Implemented search/status filtering, view mode switching, and Clean Dead Shells confirmation workflow (identifying panes with `restore_error` or shell panes whose `cwd` ends with `(deleted)`).
   - Added graceful polling for `GET /agents/api/sessions` and `GET /agents/api/muse` alongside `/agents/api/state`.
   - Wired `#start-agent-form` with optional `model`, `effort`, and `session` fields on `POST /agents/api/pane/:id/start`, plus Split Right / Split Down via `POST /agents/api/pane/:id/split`.
   - Wired quick command chips (`data-key` and `data-prompt`), `#orchestration-details` drawer (with 1-click "Load into Start Form" and "Resume in Selected Pane"), and `#muse-detail-body` actions (`/agents/api/names/override`, `/agents/api/names/orchestrator`, `/agents/api/muse/message`).
   - Added `?select=<paneId|muse:slug>` deep-link support.

4. **`dashboard/public/names/names.js`**
   - Added "Manage in Control ->" links (`href="/agents/control/?select=muse:<slug>"` on slug cards in `renderSlugs()` and `href="/agents/control/?select=<paneId>"` on worker rows in `renderHosts()`).

## Verification

- `node --check dashboard/public/control/app.js && node --check dashboard/public/names/names.js`: exited 0.
- `(cd dashboard && npm test)`: 25 tests across 9 suites passed (0 failed).
- `env -u HERDR_ENV ./verify.sh`: exited 0 (`ALL CHECKS PASSED`, including `no em dashes`).

FERNANDO_DONE
