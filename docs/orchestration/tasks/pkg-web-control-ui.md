# Task pkg-web-control-ui

- Owner: Fernando (`fernando`), `gemini-4-hydrogen-medium`, branch `crew/fernando`
- Report: `docs/orchestration/reports/pkg-web-control-ui.md` ending with `FERNANDO_DONE` or `FERNANDO_BLOCKED`

## Scope (touch ONLY `dashboard/public/control/{index.html,style.css,app.js}`, `dashboard/public/names/{index.html,names.js}`, and your report)

1. **Collapsible Panes, Workspaces, Tabs & Layout in `/agents/control/` (`index.html`, `style.css`, `app.js`)**:
   - Add top-level mode/view tabs or filter pills in the left sidebar & main view:
     - **View switcher / filter bar**: Search input (`#pane-filter` filtering by name, pane ID, task, cwd), Status filter select/pills (`all`, `working`, `blocked`, `idle`, `done`, `shell`), and **Collapse All / Expand All** buttons.
     - Make every workspace group (`ws-group`) and tab group (`tab-group`) **collapsible** with a click on its header (chevron indicator + count badge of active/blocked panes, persisted in `localStorage` under `roostr_collapsed_ws`).
     - Add a **"Sidebar Collapse"** toggle button so the pane list sidebar can collapse on mobile/narrow screens, and make right-hand sections (Screen, Quick Keys, Session Recovery, Prompt) collapsible `<details open>` or toggleable panels.
     - Add a **"Clean Dead Shells"** button that identifies shell panes whose `cwd` ends with `(deleted)` or have `restore_error` and lets the user close them after confirmation.
2. **Session Storage & Recovery Panel + Richer Agent Management (`index.html`, `app.js`)**:
   - Fetch `GET /agents/api/sessions` alongside `/agents/api/state` (gracefully handling 404/errors if endpoint is loading).
   - Upgrade `#start-agent-form` / `#recovery-panel` (and allow opening it on ANY pane via a **"Session / Model / Split"** toolbar button):
     - Add optional **Model** input/preset select (`#start-agent-model`, e.g. `gemini-4-hydrogen-medium`, `gemini-4-hydrogen-low`, `gemini-4-argon-medium`, `claude-sonnet-4-6`, `openrouter/xiaomi/mimo-v2-pro`), **Effort** select (`#start-agent-effort`: `default`, `low`, `medium`, `high`), and **Saved Session picker** (`#start-agent-session` populated from `/agents/api/sessions` matching the pane's cwd/workspace or all saved sessions).
     - Clicking **"Resume Saved Session"** or **"Start Agent"** POSTs `{ name, kind, model, effort, session }` to `/agents/api/pane/:id/start`.
     - Add **"Split Right"** / **"Split Down"** buttons calling `POST /agents/api/pane/:id/split` so new worker panes can be spawned directly from the web UI.
   - Add quick command chips above the prompt box:
     - `Shift+Tab (Accept Edits)` (`sendKeys` or prompt), `/model medium`, `/clear`, `/new`, alongside existing `Approve (Enter)`, `Deny (Esc)`, `Yes (y)`, `No (n)`, `Up`, `Down`, `Tab`, `Ctrl+C`.
   - Add a collapsible **"Saved Sessions, Backups & Orchestration Tasks"** card/drawer (`#orchestration-details`) showing:
     - Saved sessions from `~/.roostr/sessions.json` with 1-click **"Load into Start Form"** or **"Resume in Selected Pane"**.
     - Workspace backups from `~/.roostr/backups/` (version, timestamp, pane count).
     - Active orchestration tasks (`tasks.json` packages, status badges, model/effort, report links).
3. **Muse Agents Workflow in `/agents/control/` and `/agents/names.html`**:
   - Fetch `GET /agents/api/muse` in `/agents/control/app.js`:
     - Render a collapsible **"Muse Agents (Roman & Desks)"** group in the left sidebar (with each Muse agent: `Roman`, `Engy`, `El Vigia`, `La Critica`, `Buildy 1`, `Buildy 2`, `Romy-Car`, `Romy-Ril`, `Archy`, `Historia`, `Fabu`, `Repy`, showing its emoji, canonical/override name, live state badge `working`/`blocked`/`idle`/`done`, and current task).
     - When a Muse agent is clicked in the sidebar, open the **Muse Agent Detail Panel** (`#muse-detail-body`) in the right column showing:
       - Header: Emoji + Name + Slug + State badge + Model + Session ID (`session`) + Last activity (`lastActivityAst`) + MuseSight bank (`bank`).
       - Inline **Canonical Name Override & Orchestrator Toggle** (calling `/agents/api/names/override` and `/agents/api/names/orchestrator`).
       - **Current & Next Task + Blockers** summary card and collapsible **Tasks Checklist** (`tasks[]` with `done` / `in-progress` / `blocked` badges).
       - **Send Task / PioRelay Message Form** (`#muse-message-form`: Subject input, Message/Task textarea, Project input default `muse`, and **"Send via PioRelay"** button calling `POST /agents/api/muse/message`).
       - Collapsible **Agent Docs (`SOUL.md`, `AGENT.md`, `STATE.md`)** viewer so you can read any Muse agent's charter and state without leaving `/agents/control/`.
   - In `/agents/names/index.html` and `/agents/names/names.js`, add direct **"Manage in Control ->"** links on each orchestrator/worker row (`href="/agents/control/?select=..."`) and support `?select=<paneId|muse:slug>` in `/agents/control/app.js`!
4. **Compatibility & Rules**:
   - Preserve all existing DOM IDs required by `dashboard/test/app.test.js` (`#pane-list`, `#pane-screen`, `#prompt-form`, `#prompt-input`, `#close-pane-btn`, `#start-agent-form`, `#start-agent-name`, `#start-agent-kind`, `#rename-form`, `#audit-details`, `#sign-out-btn`).
   - All CSS and JS must respect `Content-Security-Policy: default-src 'self'` (no inline `onclick=` or inline `<style>` tags).
   - No em dashes (`—`) anywhere. Run `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
(cd dashboard && npm test)
env -u HERDR_ENV ./verify.sh
```
