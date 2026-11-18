# Package Brief: `pkg-p2-state-lock-and-hygiene`

## Objective
Fix same-process `.tmp` collisions and cross-process read-modify-write races in `src/state.js`, generalize `validPaneId` so standalone headless worker IDs work in `roostr report`, and clean up all repository files so `env -u HERDR_ENV ./verify.sh --public` passes with 0 failures.

## Owned Files (`owns`)
- `src/state.js`
- `src/report.js`
- `verify.sh`
- `docs/roostr-standalone.md`
- `docs/spawn-policy.md`
- `docs/orchestration-plan.md`
- `dashboard/src/config.js`
- `test/security.test.js`
- `docs/orchestration/reports/pkg-p2-state-lock-and-hygiene.md`

## Implementation Requirements

1. **Atomic Unique Temp File & Advisory Lock in `src/state.js`**:
   - In `writeJson(file, data)`, replace `const tmp = "${file}.${process.pid}.tmp"` with a monotonic counter + random suffix:
     `const tmp = "${file}.${process.pid}.${++tmpSeq}.${crypto.randomBytes(4).toString('hex')}.tmp"`.
   - Export `withFileLock(file, fn, opts = { timeoutMs: 2500, staleMs: 15000 })` using `fs.openSync(lockPath, 'wx', 0o600)` (writing `{ pid: process.pid, at: Date.now() }` and cleaning up stale locks if the holder PID is dead or older than `staleMs`), and export `updateJson(file, fallback, mutatorFn)` that wraps read-modify-write inside `withFileLock`.
2. **Standalone Worker ID Support in `src/state.js` & `src/report.js`**:
   - Export `validWorkerId(id)` in `src/state.js` that accepts both Herdr pane IDs (`w1:p2`) and standalone worker IDs (`^[A-Za-z0-9_.:-]{1,64}$`, rejecting `..`, `/`, `\`, and leading dots). Keep `validPaneId` as an alias for `validWorkerId` so existing callers and tests pass.
   - In `src/report.js`, accept `--worker <id>` as a synonym for `--pane <id>` and fallback to `process.env.ROOSTR_AGENT_ID || process.env.HERDR_PANE_ID`.
3. **Public Repo Hygiene (`verify.sh --public`)**:
   - In `dashboard/src/config.js`, replace any hardcoded machine paths or private hostnames with `process.env.ROOSTR_STATE_DIR || path.join(os.homedir(), '.roostr')`, `process.env.ROOSTR_MUSE_DIR`, and `process.env.ROOSTR_PRIMARY_HOST || 'ovh'`.
   - Ensure `HELP-ARGON.md` and `AGENT-PROMPT.md` are removed (or listed in `.gitignore`), and scrub any remaining matches of `FORBIDDEN_PATTERN` or em dashes in `docs/`.
   - In `verify.sh`, make the `herdr-plugin.toml` manifest check run if `herdr-plugin.toml` or `integrations/herdr/herdr-plugin.toml` exists, and add a standalone JSON smoke check (`node bin/roostr --json >/dev/null` when `HERDR_ENV` is unset).

## Verification
- Run `node --test test/security.test.js` and `env -u HERDR_ENV ./verify.sh --public`.
- Write completion evidence to `docs/orchestration/reports/pkg-p2-state-lock-and-hygiene.md`.
