# Package Brief: `pkg-p2-board-split-and-tui-viewer`

## Objective
Split `src/board.js` (~4,700 lines) cleanly into 7 zero-dependency modules under `src/board/` while keeping `src/board.js` as a 100% backward-compatible barrel re-export, and add the standalone collapsible log-tail split (`Enter` / `l`), native CLI interactive TTY attach (`i`), and `[A approvals]` TUI tab.

## Owned Files (`owns`)
- `src/board.js`
- `src/board/index.js`
- `src/board/state.js`
- `src/board/model.js`
- `src/board/collect.js`
- `src/board/render.js`
- `src/board/views.js`
- `src/board/viewer.js`
- `test/board.test.js`
- `docs/orchestration/reports/pkg-p2-board-split-and-tui-viewer.md`

## Implementation Requirements

1. **Modular Split (`src/board/*`) with Zero External Dependencies**:
   - `src/board/state.js`: `TAGS`, `parseLabel`, `stripTag`, `assignTags`, `trackStatus`, `loadMemory`, `saveMemory`, `persistedStatus`.
   - `src/board/model.js`: `buildModel` (including Section 6 monitor join of registry workers + optional Herdr panes + host `PhysMem free` / `swap used`), `selectAgents`, `needsScreen`, `budgetState`, `fmtRam`, `fmtDuration`, `fmtTokens`, `fmtCost`, `shortModel`, `toJson`, `toJsonRows`.
   - `src/board/collect.js`: `collect`, `paneRss`, Swapy census + `/proc/meminfo` reader, registry reader, Tokscale/burn forecast.
   - `src/board/render.js`: `render`, `rowCells`, `fitColumns`, `banner`, `menuBar`, `wsHeader`, `limitsLine`, height priority dropping, mouse hit-boxes.
   - `src/board/views.js`: `todayLines`, `hourChart`, `modelTableLines`, `backupLines`, `setupLines`, `setupState`, `helpLines`, `detailBox`, and `[A approvals]` view (`approvalLines`, `a` to approve, `x` to deny on local TUI for `routine`).
   - `src/board/viewer.js`:
     - `LogTailViewer`: watches `~/.roostr/logs/<workerId>.log` via `fs.watch` + byte-offset `fs.readSync` into a 500-line ring buffer and renders a collapsible right or bottom split panel in the TUI when toggled with `Enter` or `l`.
     - `attachInteractiveSession(worker, ttyPauseFn, ttyResumeFn)`: pauses raw mode on stdin/stdout, invokes `execFile`/`spawn` with `stdio: 'inherit'` in `worker.cwd` (`opencode --session <id>`, `claude --resume <id>`, `kilo --session <id>`, `agy --session <id>`), and restores the TUI when the user detaches.
   - `src/board/index.js`: `runLive`, `runOnce`, `parseArgs`, `onKey`, `onClick`, `MOUSE_RE`, `isDoubleClick`, `copyToClipboard`, `main`.
   - `src/board.js`: Re-exports every symbol from `src/board/index.js`, `src/board/state.js`, `src/board/model.js`, `src/board/collect.js`, `src/board/render.js`, `src/board/views.js`, and `src/board/viewer.js`.

## Verification
- Run `node --test test/board.test.js` and add unit tests for `LogTailViewer` ring-buffer slicing, split rendering, and `attachInteractiveSession` command construction.
