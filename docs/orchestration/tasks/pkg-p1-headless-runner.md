# Task pkg-p1-headless-runner

- Owner: Enrique (`enrique`), `gemini-4-hydrogen-medium`, branch `crew/enrique`
- Report: `docs/orchestration/reports/pkg-p1-headless-runner.md` ending with `ENRIQUE_DONE` or `ENRIQUE_BLOCKED`

## Scope (touch ONLY `src/runner.js`, `test/runner.test.js`, and your report)

1. **`src/runner.js` — Detached Headless Runner**:
   - Logs directory: `stateDir.resolvePath('logs', [], { dirEnvNames: ['ROOSTR_STATE_DIR', 'CREW_BOARD_STATE_DIR'] })` (`~/.roostr/logs/`).
   - `buildRunnerCommand(kind, opts = {})`:
     - Builds `{ bin, args }` for headless execution without a terminal pane:
       - `opencode`: `opencode run <task>` (plus `--session <session>` if resuming, `--model <model>` if set)
       - `kilo`: `kilo run <task>` (plus `--session <session>`, `--model <model>`)
       - `claude`: `claude -p <task> --output-format json` (plus `--resume <session>`, `--model <model>`, `--effort <effort>`)
       - `agy`: `agy <task>` (plus `--conversation <session>`, `--model <model>`, `--effort <effort>`)
       - `custom`: uses `opts.bin` and `opts.args` directly (useful for testing and custom workers).
   - `samplePidRssKb(pid, options = {})`:
     - Reads `/proc/<pid>/status` (`VmRSS:`) on Linux or falls back to `ram.processTable()` (`ps -A -o pid=,ppid=,rss=`) to return total tree RSS in KiB (or `null` if exited).
   - `spawnHeadless(opts, deps = {})`:
     - Enforces `docs/spawn-policy.md` placement rule: defaults `placement` to `'ovh'`; if `placement === 'mac'` and `!opts.placementReason`, returns `{ error: 'mac placement requires placementReason' }`.
     - Opens `~/.roostr/logs/<id>.log` (append/create `0600`), spawns child with `{ cwd: opts.cwd || process.cwd(), detached: true, stdio: ['ignore', logFd, logFd] }` (`execFile` / `spawn` with `shell: false` — remember `verify.sh` forbids `shell: true` and `spawn('sh', ...)`!), calls `child.unref()`.
     - Registers the run in `~/.roostr/registry.json` (read/write JSON directly or via `require('./registry')` if present, with a clean fallback so it works standalone in its worktree!) with `mode: 'headless'`, `state: 'working'`, `pid`, `command`, `logFile`, `rssKb`.
     - Returns `{ id, pid, command, logFile, state: 'working' }`.
   - `tailLog(id, lines = 40, options = {})`: reads the last `lines` of `~/.roostr/logs/<id>.log`.
   - `refreshHeadless(options = {})`: inspects running `mode === 'headless'` entries in `registry.json` against `ram.processTable()`; updates `rssKb` + `lastHeartbeat` if alive, or marks `done` (or `failed` if exit status recorded) when the PID is no longer running.
   - `main(argv)` supporting `roostr run --kind <kind> --cwd <dir> --task <text> [--owner <name>] [--model <m>] [--effort <e>] [--session <id>] [--placement ovh|mac] [--mac-reason <why>] [--json]`, `roostr run logs <id> [--lines 40]`, and `roostr run refresh [--json]`.
2. **Tests & Rules**:
   - Add unit tests in `test/runner.test.js` testing `buildRunnerCommand`, Mac placement rejection without `placementReason`, detached spawn + log file creation + registry persistence (using a real short `node -e` child process in temp `ROOSTR_STATE_DIR`), `tailLog`, and `refreshHeadless`.
   - Never use `shell: true` or `spawn('sh', ...)` (`verify.sh` rejects it).
   - Zero external npm dependencies. No em dashes (`—`) anywhere. Run `node --test test/runner.test.js` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
node --test test/runner.test.js
env -u HERDR_ENV ./verify.sh
```
