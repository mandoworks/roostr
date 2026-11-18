# Package Brief: `pkg-p2-spawn-drawer-and-advisor`

## Objective
Let the operator pick (or accept empirical recommendations from `src/advisor.js` for) each spawned worker's `tool`, `model`, `effort`, and `host` directly from both the TUI (`[S spawn]` drawer) and Web GUI (`+ Spawn Worker` modal), launching workers detached and headless via `src/runner.js`.

## Owned Files (`owns`)
- `src/board/views.js`
- `dashboard/src/registry-bridge.js`
- `dashboard/public/control/app.js`
- `test/advisor-spawn.test.js`
- `docs/orchestration/reports/pkg-p2-spawn-drawer-and-advisor.md`

## Implementation Requirements

1. **Empirical Recommendation & Spawn API (`dashboard/src/registry-bridge.js`)**:
   - `GET /agents/api/recommend?task=<text>&kind=<kind>`: calls `advisor.recommend(task, { kind })` and returns `{ kind, recommended: { tool, model, effort, tier, host: 'ovh', passRate, avgCostUsd, rationale }, choices: { tools: ['opencode','claude','kilo','agy'], efforts: ['low','medium','high','xhigh'], modelsByTool } }`.
   - `POST /agents/api/spawn` (passkey or orchestrator token): validates `{ task, kind, owner, tool, model, effort, host, macReason, cwd }`, checks `governor.canSpawn()`, invokes `runner.spawnHeadless()` (`< /dev/null`, `unref()`), records the spawn in `src/ledger.js` and `src/registry.js`, and returns the registered worker row.
2. **TUI `[S spawn]` Drawer (`src/board/views.js`)**:
   - Pressing `S` opens the Spawn Drawer pre-populated from the selected pending task in `docs/orchestration/tasks.json` (or an inline task prompt).
   - Displays the empirical recommendation badge (`Recommended: agy / gemini-4-hydrogen-medium / medium [88% 1st-try pass, $0.14/pass]`) and lets the operator cycle `Tab` / arrow keys across `Tool`, `Model`, `Effort`, and `Host` (`ovh` vs `mac`), then press `Enter` to launch headless.
3. **Web GUI `+ Spawn Worker` Modal (`dashboard/public/control/app.js`)**:
   - Adds a `+ Spawn Headless Worker` button in the Monitor header that live-fetches `/agents/api/recommend` as the task/kind changes, pre-selects the empirical recommendation, allows one-click override of `tool`, `model`, `effort`, and `host` (requiring `macReason` when `host === 'mac'`), and launches the worker into the monitor table.

## Verification
- Run `node --test test/advisor-spawn.test.js` and `(cd dashboard && npm test)`.
