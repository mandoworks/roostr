# Task pkg-p1-monitor-board

- Owner: Valentin (`valentin`), `gemini-4-hydrogen-medium`, branch `crew/valentin`
- Report: `docs/orchestration/reports/pkg-p1-monitor-board.md` ending with `VALENTIN_DONE` or `VALENTIN_BLOCKED`

## Scope (touch ONLY `src/board.js`, `test/board.test.js`, and your report)

1. **`src/board.js` — Spec Section 6: The Board is the Monitor**:
   - **Standalone / `herdr`-stopped support**:
     - In `collect(opts, mem)`, wrap `herdr.snapshot()` in `try/catch`: if `herdr` is stopped or unreachable, fall back to an empty snapshot `{ agents: [], panes: [], workspaces: [], tabs: [], layouts: [] }` and record `model.herdrOnline = false` (instead of failing!), so `roostr --json` and the board still display all registered headless workers from `~/.roostr/registry.json`!
   - **Registry + RAM Census Join**:
     - Read `~/.roostr/registry.json` (respecting `ROOSTR_STATE_DIR` / `ROOSTR_REGISTRY`, safely returning `[]` if missing).
     - Read host memory truth:
       - On Linux: parse `/proc/meminfo` (`MemAvailable`, `SwapTotal`, `SwapFree`) into `hostMem = { host: os.hostname(), physFreeKb, swapUsedKb, swapTotalKb }`.
       - Also check `~/.roostr/swapy-census.json` (if present) for Mac Swapy census (`physFreeKb`, `swapUsedKb`, `processes: [{ pid, command, rssKb }]`).
     - Merge `registry` workers into `model.rows`:
       - If a registry entry matches a live `herdr` pane (`paneId`), enrich that row with `owner`, `orchestrator`, `host`, `heartbeatAt`, `mode`, `source: 'reported'`, and `rssKb` if higher/present.
       - If a registry entry is `mode === 'headless'` (no pane), add a row with `paneId: entry.id`, `workspace: entry.owner || entry.host || 'headless'`, `name: entry.id`, `owner: entry.owner || null`, `orchestrator: entry.orchestrator || null`, `host: entry.host || 'ovh'`, `kind: entry.kind || 'headless'`, `task: entry.task || null`, `status: entry.state === 'waiting-approval' ? 'blocked' : (entry.state || 'working')`, `session: entry.session || null`, `mode: 'headless'`, `source: 'reported'`, `pid: entry.pid || null`, `command: entry.command || null`, `ram: { v: liveOrReportedRssKb, src: 'reported' }`, `heartbeatAt: entry.lastHeartbeat || entry.updatedAt || null`.
     - Attach `model.hostMem` (and include `hostMem` in `jsonOutput(model)`).
   - **RAM Sorting & Monitor Rendering**:
     - Support `--sort ram` in `parseArgs` and pressing `M` (Shift+m) in the TUI to toggle `sortByRam` (sorting rows by `r.ram.v` descending, nulls last).
     - In `renderBoard`: show `PhysMem free` + `swap used` in the header/status line when `model.hostMem` is available, and show `[headless]` / `[reported]` + `heartbeat` age on headless worker rows.
2. **Tests & Rules**:
   - Add unit tests in `test/board.test.js` covering:
     - `collect` with `herdr` down + `ROOSTR_STATE_DIR/registry.json` containing headless workers (verifying `herdrOnline === false` and headless rows rendered).
     - `jsonOutput` including `hostMem` and headless worker rows (`owner`, `host`, `mode: 'headless'`, `ram`).
     - RAM sorting (`--sort ram`).
   - Zero external npm dependencies. No em dashes (`—`) anywhere. Run `node --test test/board.test.js` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
node --test test/board.test.js
env -u HERDR_ENV ./verify.sh
```
