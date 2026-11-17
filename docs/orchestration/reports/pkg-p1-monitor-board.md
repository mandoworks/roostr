# pkg-p1-monitor-board report

## Changes

All work stayed inside `src/board.js`, `test/board.test.js`, and this report.

### `src/board.js`

- **Standalone / `herdr`-stopped support** (`collect`): `herdr.snapshot()` is now wrapped in `try/catch`. When Herdr is stopped or unreachable the board falls back to an empty snapshot `{ agents: [], panes: [], workspaces: [], tabs: [], layouts: [] }` and records `model.herdrOnline = false` instead of failing, so `roostr --json` and the board still draw the registered headless workers. `model.herdrOnline = true` on a normal snapshot.
- **Registry + RAM census join**:
  - `readRegistry()` reads `~/.roostr/registry.json` via `src/state-dir.js` `resolvePath`, respecting `ROOSTR_REGISTRY` and `ROOSTR_STATE_DIR` / `CREW_BOARD_STATE_DIR`, and safely returns `[]` when the file is missing or malformed (accepts either an array or `{ workers: [...] }`).
  - `readHostMem()` reads host memory truth: the Mac Swapy census (`~/.roostr/swapy-census.json`, `physFreeKb`, `swapUsedKb`, optional `processes`) then `/proc/meminfo` (`MemAvailable`, `SwapTotal`, `SwapFree`) into `{ host: os.hostname(), physFreeKb, swapUsedKb, swapTotalKb }`. `parseMeminfo()` is exported and unit tested.
  - `buildModel` now accepts `registry`, `hostMem`, `herdrOnline`, and `sort`. Registry entries that match a live pane (by `paneId` or `id`) enrich that row with `owner`, `orchestrator`, `host`, `heartbeatAt`, `mode`, `source: 'reported'`, and its `rssKb` when that reading is higher or the pane had none. `mode === 'headless'` entries with no pane become rows via `headlessRow()` carrying `paneId`, `workspace`, `name`, `owner`, `orchestrator`, `host`, `kind`, `task`, `status` (with `waiting-approval` mapped to `blocked`), `session`, `mode: 'headless'`, `source: 'reported'`, `pid`, `command`, `ram: { v, src: 'reported' }`, and `heartbeatAt`. Those rows get the default fields the shared renderer needs, so they draw like any pane.
  - `model.hostMem` is attached and now included in the JSON envelope (`toJson`): keys are `schema, version, commit, generatedAt, scope, workspace, summary, hostMem, panes`.
- **RAM sorting and monitor rendering**:
  - `parseArgs` supports `--sort ram` (any other value throws `--sort must be ram`); `sortRowsByRam()` sorts rows by `r.ram.v` descending with rows that have no reading last, and is applied when `sort === 'ram'`.
  - In the TUI, `M` toggles `opts.sort` between `ram` and `null` and refreshes; the key is listed in the help screen.
  - `render` shows `PhysMem <free> free · swap <used> used` on the line 0 status bar when `model.hostMem` is present, and headless rows show `[headless]` (enriched pane rows show `[reported]`) plus a `· hb <age>` heartbeat age on the state cell.

### `test/board.test.js`

- Updated the `toJson` envelope key assertion to include `hostMem`.
- Added tests:
  - `collect` with `herdr.snapshot()` forced to throw and a `ROOSTR_REGISTRY` file holding headless workers: asserts `herdrOnline === false`, the headless rows (`owner`, `orchestrator`, `host`, `mode`, `source`, `ram`, `waiting-approval` to `blocked`), and `[headless]` + heartbeat age in the rendered frame.
  - `toJson` includes `hostMem` and headless worker rows (`owner`, `host`, `mode: 'headless'`, `ram`, `source`).
  - RAM sorting: `parseArgs(['--sort', 'ram'])`, the invalid-value throw, `sortRowsByRam` order (heaviest first, nulls last), and `buildModel` reordering under `sort: 'ram'`.
  - `parseMeminfo` parsing and the `PhysMem free · swap used` header.
  - A live pane joining its reported `owner` / `orchestrator` / `host` / `heartbeatAt`, with the higher reported RSS winning and the pane's own bigger reading kept.

## Verification

- `node --test test/board.test.js`
  - Result: exit 0, 130/130 tests passed.
- `env -u HERDR_ENV ./verify.sh`
  - Result: `ALL CHECKS PASSED` (exit 0). Syntax, the full `node --test test/*.test.js` suite, manifest, zero-dependency audit, public-repo hygiene, and no-em-dash / no-shell-execution checks all pass. Live smoke is skipped outside Herdr.
- Zero external npm dependencies: only Node builtins and local `require`s were added. No em dashes. Nothing committed or pushed.

VALENTIN_DONE
