# Report: pkg-p1-headless-runner

- Owner: Enrique (`enrique`)
- Branch: `crew/enrique`
- Status: Complete

## Changes Implemented

1. **`src/runner.js`** (new) - detached headless runner, zero external deps:
   - `logsDir(options)` resolves `~/.roostr/logs/` through `state-dir.resolvePath('logs', [], { dirEnvNames: ['ROOSTR_STATE_DIR', 'CREW_BOARD_STATE_DIR'] })`; `registryFile(options)` resolves `registry.json` with `ROOSTR_REGISTRY` / `CREW_BOARD_REGISTRY` overrides.
   - `buildRunnerCommand(kind, opts)` returns `{ bin, args }`:
     - `opencode`: `opencode run <task>` plus `--session` / `--model`.
     - `kilo`: `kilo run <task>` plus `--session` / `--model`.
     - `claude`: `claude -p <task> --output-format json` plus `--resume` / `--model` / `--effort`.
     - `agy`: `agy <task>` plus `--conversation` / `--model` / `--effort`.
     - `custom`: uses `opts.bin` and `opts.args` verbatim (test and custom-worker hook).
     - Unknown kind throws `unknown kind: <kind>`.
   - `samplePidRssKb(pid, options)`: parses `VmRSS:` from `/proc/<pid>/status` on Linux; returns `null` on `ENOENT` (pid exited); otherwise falls back to `ram.processTable()` + `ram.treeRss()` for the total tree RSS in KiB. Injectable via `options.readFileSync` / `options.processTable` / `options.platform` for tests.
   - `spawnHeadless(opts, deps)`:
     - Defaults `placement` to `ovh`; rejects unknown placements and returns `{ error: 'mac placement requires placementReason' }` when `placement === 'mac'` and no reason is given, per `docs/spawn-policy.md`.
     - Opens `~/.roostr/logs/<id>.log` append/create `0600`, spawns with `{ cwd: opts.cwd || process.cwd(), detached: true, stdio: ['ignore', logFd, logFd], shell: false }`, closes the parent's fd, and calls `child.unref()`.
     - Samples RSS, then registers the run in `registry.json` with `mode: 'headless'`, `state: 'working'`, `pid`, `command`, `logFile`, `rssKb`, plus the rest of the shared record schema (`owner`, `orchestrator`, `host`, `task`, `session`, `kind`, `cwd`, `placement`, `placementReason`, `model`, `effort`, `lastHeartbeat`, `startedAt`, `updatedAt`, `source: 'reported'`).
     - Returns `{ id, pid, command, logFile, state: 'working' }`.
   - `tailLog(id, lines = 40, options)`: validates `id` against `/^[A-Za-z0-9_.:-]{1,64}$/` (path-traversal safe), reads a bounded tail (256 KiB) and returns the last `lines` lines.
   - `refreshHeadless(options)`: reads `registry.json`, checks every non-terminal `mode === 'headless'` entry against `ram.processTable()`; while the pid lives it updates `rssKb` + `lastHeartbeat` + `updatedAt`, once gone it marks `done` (or `failed` when a non-zero `exitCode` is recorded). Returns `{ checked, alive, done, failed, workers }`.
   - `main(argv, options)`: supports `roostr run --kind ... --task ... [--cwd] [--owner] [--model] [--effort] [--session] [--placement ovh|mac] [--mac-reason] [--json]`, `roostr run logs <id> [--lines 40]`, and `roostr run refresh [--json]`, returning a Promise that resolves to an exit code (the same async convention as `workers.main` / `session-log.main` in `bin/roostr`).

2. **`test/runner.test.js`** (new) - 8 tests, all passing:
   - `buildRunnerCommand` for every kind, with and without resume/model/effort flags and the unknown-kind throw.
   - `samplePidRssKb`: `VmRSS` parsing, Linux fast path, `ENOENT` -> `null`, invalid pids, and the process-table tree-sum fallback.
   - Mac placement rejection without a reason, unknown placement, and missing binary.
   - Detached spawn with a real short `node -e` child under a temp `ROOSTR_STATE_DIR`: log file created `0600` and captures output, registry entry persisted and shaped correctly, `tailLog` reads it back, `refreshHeadless` reports alive then done after the child exits.
   - `refreshHeadless` marking a dead pid `done`, a recorded failure `failed`, and leaving pane rows and terminal runs untouched.
   - Registry round trip: reads a bare array and writes back the same container, atomic `0600`.
   - `main`: help, usage errors, `logs` (plain and `--json`), and `refresh --json`.

## Design Notes

- **Standalone registry fallback.** `registry.json` is written directly (atomic tmp + rename, `0600`) so the runner works in its own worktree without `src/registry.js`. Reads accept both a bare workers array and an object with a `workers` array, and writes preserve whichever container the file already used, so the harness can merge cleanly with `pkg-p1-registry-governor`.
- **No shell anywhere.** Execution goes through `child_process.spawn(bin, args, { shell: false })` only; `verify.sh`'s shell-execution guard passes.
- **`custom` kind.** Exists so tests and custom workers can pass an exact argv (e.g. `node -e <script>`) without adding a new protected branch.

## Files Touched

- `src/runner.js` (new)
- `test/runner.test.js` (new)
- `docs/orchestration/reports/pkg-p1-headless-runner.md` (this report)

## Verification

- `node --test test/runner.test.js`: 8 passed, 0 failed.
- `env -u HERDR_ENV ./verify.sh`: exited 0 (`ALL CHECKS PASSED`; syntax, unit tests, zero-dependency audit, hygiene, and shell guard all ok).

ENRIQUE_DONE
