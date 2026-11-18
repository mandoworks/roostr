# Package Brief: `pkg-p2-herdr-demotion-and-orchestrator`

## Objective
Demote `src/herdr.js` into an optional viewer adapter (`src/viewers/herdr.js`), build the unified `src/roostrd.js` control-plane daemon (`~/.roostr/roostrd.sock` + timer loop), and add `roostr tasks dispatch` worktree + `owns` verification gating to `src/tasks.js`.

## Owned Files (`owns`)
- `src/roostrd.js`
- `src/herdr.js`
- `src/viewers/herdr.js`
- `src/daemon.js`
- `src/tasks.js`
- `bin/roostr`
- `test/roostrd.test.js`
- `docs/orchestration/reports/pkg-p2-herdr-demotion-and-orchestrator.md`

## Implementation Requirements

1. **Unified `roostrd` Control-Plane Daemon (`src/roostrd.js` & `bin/roostr`)**:
   - Listens on Unix domain socket `~/.roostr/roostrd.sock` (`0600`) with PID file `~/.roostr/roostrd.pid`.
   - Subcommands in `bin/roostr`: `roostr daemon serve`, `roostr daemon ensure` (idempotent background start), `roostr daemon status`, `roostr daemon stop`.
   - Owns the 10-second tick loop:
     1. Samples host memory (`/proc/meminfo` + Swapy census) and per-worker RSS (`src/ram.js`).
     2. Reconciles dead PIDs in `src/registry.js` (marks crashed `working` workers as `failed` unless `hibernated: true`).
     3. Runs `governor.reapIdle()` (30m idle threshold, Swapy PID+command check) and `approvals.expireStaleApprovals()`.
     4. Emits newline-delimited JSON events to connected socket clients (TUI and `dashboard/`).
2. **Optional Herdr Viewer Adapter (`src/viewers/herdr.js` & `src/herdr.js`)**:
   - Move `src/herdr.js` into `src/viewers/herdr.js` and add `isAvailable()` (checks `HERDR_BIN_PATH` or `herdr` on `PATH` AND probes `herdr api snapshot` with a 500ms timeout, caching `false` when stopped so standalone runs never block or throw).
   - Add `openViewerPane(worker)`: opens or focuses a Herdr pane running `<tool> --session <worker.sessionId>` only when explicitly requested (`roostr attach --herdr <id>` or `H` in TUI).
   - Remove hardcoded `'roman'` from `src/daemon.js` (`holdReportForOrchestrator` using `cfg.orchestratorName || 'head-honcho'`) and route `daemon.executePlan` to `runner.spawnHeadless` by default instead of `herdr.splitPane`.
3. **Self-Driving Worktree Dispatch & `owns` Gate (`src/tasks.js`)**:
   - `roostr tasks dispatch [--dry-run]`: finds all `pending` tasks in `docs/orchestration/tasks.json` whose `depends_on` are all `done`, creates git worktrees (`execFile('git', ['worktree', 'add', ...])`), and spawns each worker headless via `runner.spawnHeadless`.
   - `roostr tasks verify <task-id>`: checks `git diff --name-only` against `task.owns`, runs `env -u HERDR_ENV ./verify.sh`, and logs the outcome to `src/ledger.js`.

## Verification
- Run `node --test test/roostrd.test.js`, `(cd dashboard && npm test)`, and `env -u HERDR_ENV ./verify.sh --public`.
