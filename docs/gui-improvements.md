# Roostr TUI / GUI Analysis & Improvement Brief (`docs/gui-improvements.md`)

This brief defines five concrete, self-contained TUI/GUI upgrades for `src/board.js` and `src/analytics.js`. Every item preserves the zero-dependency terminal architecture (`src/ui.js`) and has explicit acceptance criteria for `test/board.test.js`.

---

## 1. Full Mouse Click Support Inside the `[O orchestrate]` Hub (`src/board.js`)

**Problem**:
The main board (`render`), `d today` view (`todayLines`), and `R backups` view register mouse hit boxes in the `hits` array (`{ y, x0, x1, action, ... }`), but `orchestrateLines(m, width, st)` currently only supports keyboard navigation (`1`, `2`, `3`, `Tab`, `j`/`k`, `Space`, `Enter`, `b`, `d`, `s`, `Esc`).

**Solution**:
Pass `hits` (and line offset `y0`) into `orchestrateLines(m, width, st, hits, y0)` (just like `todayLines(m, width, metric, subviews, hits, y0)` does):
1. **Header tab pills**: Register clickable hit regions on the header line for:
   - `[1 tasks · advisor]` -> `{ y: y0, x0, x1, action: 'orch-tab', tab: 'tasks' }`
   - `[2 analytics · summary]` -> `{ y: y0, x0, x1, action: 'orch-tab', tab: 'analytics' }`
   - `[3 setup]` -> `{ y: y0, x0, x1, action: 'orch-tab', tab: 'setup' }`
   - `[esc close]` -> `{ y: y0, x0, x1, action: 'orch-close' }`
2. **Tab 1 (`tasks · advisor`) rows**:
   - Clicking a task row selects that task (`action: 'orch-task-row', index: i`).
   - Clicking the `eff` column on the selected row cycles effort (`action: 'orch-effort', index: i`, same as pressing `Space`).
   - Clicking the `model` column on the selected row opens the inline model editor (`action: 'orch-model', index: i`, same as pressing `Enter`).
3. **Tab 2 (`analytics · summary`) filter pills**:
   - Clicking `[model]`, `[pane]`, `[kind]`, or `[batch]` switches `st.by` (`action: 'orch-by', by: v`).
   - Clicking `[1d]`, `[7d]`, or `[30d]` switches `st.windowIndex` (`action: 'orch-window', index: idx`).
   - Clicking `[s refresh summary]` refreshes `summary.json` (`action: 'orch-refresh-summary'`).
4. Wire these `action` types in the mouse handler inside `runLive` (`src/board.js`).

---

## 2. Active Drawer Highlight & Toggle on the Top Menu Bar (`src/board.js`)

**Problem**:
When a sub-drawer (`[O orchestrate]`, `[d today]`, `[R backups]`, `[o options]`, or `[? keys]`) is open, the top menu bar (`menuBar` in `src/board.js`) renders every button in the same dim/normal style, and clicking the already-open drawer button does not close it.

**Solution**:
1. In `menuBar(m, width, menu, hits, y, activeDrawer)`:
   - Accept or derive the active drawer (`orchestrate`, `today`, `backups`, `options`, `help`).
   - Style the currently open drawer's pill with `ui.bold(ui.cyan(label))` (and a leading `▾` indicator, e.g., `[▾ O orchestrate]`) so the user immediately sees which drawer is active.
2. In `runLive`'s mouse click handler:
   - If the user clicks the top-bar button for the drawer that is already open (`orchestrate`, `today`, `backups`, `options`, `help`), toggle that drawer closed (returning to the main pane table).

---

## 3. Responsive Narrow-Split Layout (`<95 cols`) in `[O orchestrate]` Tab 1 (`src/board.js`)

**Problem**:
`roostr` often runs in a side split pane (`width` between `72` and `94` columns). In `orchestrateLines` Tab 1 (`tasks · advisor`), the 8-column header (`id | st | kind | eff | tier | model | conf | title`) uses 76 fixed columns before `title`, leaving almost no space for the task title in narrow panes.

**Solution**:
In `orchestrateLines` (`src/board.js`):
- When `inner < 92`:
  - Switch to a compact 6-column table: `id (8) | st (7) | kind (12) | eff (4) | model (18) | title (remaining)` by omitting the separate `tier` and `conf` columns (instead, color-code `eff` using the confidence color: green for `high`, yellow for `medium`, dim for `low`/`cold`).
- When `inner >= 92`:
  - Keep the full 8-column table (`id | st | kind | eff | tier | model | conf | title`).

---

## 4. Subagent Token Share Gauge (`>80%` Target) in `[O orchestrate]` Tab 2 (`src/board.js`)

**Problem**:
Rule 0 of the `roostr` orchestration skill states that over `80%` of batch tokens/cost should come from delegated worker panes while the orchestrator (`head-honcho` / `orchestrator` / `lead`) stays under `20%` overhead and `<30%` context. Currently there is no visual indicator showing whether the batch is meeting that target.

**Solution**:
In `orchestrateLines` Tab 2 (`2 analytics · summary` in `src/board.js`):
1. Compute `orchestratorCost` (sum of `row.cost` for rows in `m.rows` whose `role` matches `/^(head-honcho|orchestrator|lead)$/i`) and `workerCost` (sum of `row.cost` for all other rows with `row.cost > 0`), falling back to `row.tokens` when `cost` is unavailable.
2. When `orchestratorCost + workerCost > 0`, render a 1-line **Delegation Efficiency Bar** right above the analytics table:
   - `delegation share: ████████░░ 84% workers · 16% orchestrator  (target ≥80% workers)`
   - Color the percentage green (`ui.green`) when worker share is `>= 80%`, yellow (`ui.yellow`) when `60%..79%`, and red (`ui.red`) when `< 60%`.

---

## 5. Keyboard & Click Copy of Recommended `roostr spawn` Command (`c` key in Tab 1)

**Problem**:
In `[O orchestrate]` Tab 1 (`1 tasks · advisor`), users can inspect the advisor's recommended `tool`, `effort`, and `model` for each task in `tasks.json`, and override `effort` (`Space`) or `model` (`Enter`), but cannot copy the ready-to-run `roostr spawn` command for the selected task.

**Solution**:
In `orchestrateKey(st, key, m)`:
- When `st.tab === 'tasks'` and `!st.edit`, pressing `c` formats the command for the selected task:
  `roostr spawn --task "<title>" --kind <kind> --effort <effort> --model <model>`
  copies it via `copyToClipboard(cmd)`, and sets `st.notice = 'copied spawn command for ' + task.id`.

---

## Verification Gate

After implementing items 1 through 5:
1. Add unit tests covering each item in `test/board.test.js`:
   - Mouse hit regions for `orch-tab`, `orch-close`, `orch-task-row`, `orch-by`, `orch-window`.
   - Narrow (`width: 80`) vs wide (`width: 140`) rendering of Tab 1 (`tasks · advisor`).
   - Delegation share bar rendering when worker and orchestrator panes report costs/tokens.
   - Pressing `c` on a task row sets `st.notice` with `copied spawn command for t1`.
2. Run `./verify.sh --public` and confirm 0 failures and 0 prose hygiene warnings (never use em dashes or spaced hyphens in prose or comments).
