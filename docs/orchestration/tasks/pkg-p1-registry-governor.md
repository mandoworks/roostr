# Task pkg-p1-registry-governor

- Owner: Martin (`martin`), `gemini-4-hydrogen-medium`, branch `crew/martin`
- Report: `docs/orchestration/reports/pkg-p1-registry-governor.md` ending with `MARTIN_DONE` or `MARTIN_BLOCKED`

## Scope (touch ONLY `bin/roostr`, `src/registry.js`, `src/governor.js`, `test/registry.test.js`, `test/governor.test.js`, and your report)

1. **`src/registry.js` — Standalone Worker Registry, Heartbeat & Closed-Session Log**:
   - Use `src/state-dir.js` (`resolvePath`) so all files live under `~/.roostr/` (`registry.json`, `tokens.json`, `closed-sessions.jsonl`) and respect `ROOSTR_STATE_DIR` / `ROOSTR_REGISTRY` overrides. Atomic `0600` writes.
   - Schema per worker record:
     `{ id, owner, orchestrator, host, task, session, kind, pid, command, cwd, rssKb, state, mode, logFile, placement, placementReason, model, effort, lastHeartbeat, startedAt, updatedAt, source: 'reported' }`
     Valid `state`: `'working' | 'waiting-approval' | 'idle' | 'done' | 'failed'`. Valid `mode`: `'headless' | 'pane'`.
   - Export:
     - `registerWorker(payload, options)` (generates `id` if omitted, sets `startedAt` + `lastHeartbeat`, persists)
     - `updateStatus(id, patch, options)` (updates `state`, `task`, `session`, `rssKb`, `pid`, `command`, `lastHeartbeat`, `updatedAt`)
     - `listWorkers(options)` & `getWorker(id, options)`
     - `issueToken(label, options)` & `verifyToken(rawToken, options)` (stores SHA-256 hex digest in `tokens.json`, never plaintext)
     - `appendClosedSession(entry, options)` & `readClosedSessions(options)` (`closed-sessions.jsonl`: `{ at, id, pid, command, model, ramKb, session, paneId, workspaceId, reason }`)
     - `main(argv)` supporting `roostr registry [--json]`, `roostr registry register --id ... --owner ... --task ...`, `roostr registry status --id ... --state ...`, `roostr registry token --label ...`.
2. **`src/governor.js` — Resource Governor, Placement Policy & Idle Reaper**:
   - Config defaults: `macMaxLivePanes: 3`, `swapThresholdPct: 80`, `idleReapMinutes: 30`.
   - `checkPaneSpawn({ host, livePaneCount, swapUsedPct, placement, placementReason, needsHuman, config })`:
     - Per `docs/spawn-policy.md`: default placement is `'ovh'`. If `placement === 'mac'` without a non-empty `placementReason`, return `{ allowed: false, reason: 'mac placement requires placementReason', fallback: 'ovh' }`.
     - If `host === 'mac'` (or `darwin`) and `livePaneCount >= maxLivePanes`, return `{ allowed: false, reason: 'pane budget exceeded (3/3 on mac)', fallback: 'headless' }`.
     - If `typeof swapUsedPct === 'number' && swapUsedPct >= swapThresholdPct`, return `{ allowed: false, reason: 'swap pressure threshold exceeded', fallback: 'headless' }`.
     - Otherwise `{ allowed: true, reason: null }`.
   - `findIdlePanes(panes, statusMap, now, thresholdMs = 30 * 60 * 1000)`: returns panes where `agent_status` is `'idle'` or `'done'` and `now - since >= thresholdMs` (skipping orchestrator/board panes).
   - `reapIdlePanes({ panes, statusMap, sessions, herdr, now, thresholdMs, dryRun, registryDir })`:
     - Only closes an idle pane if `sessions` (or `pane.agent_session`) has a resumable `session` ID saved!
     - Calls `herdr.closePane(paneId)` (unless `dryRun`) and appends to `closed-sessions.jsonl` via `registry.appendClosedSession`.
   - `reapWorker({ id, pid, command, registry, processTable, killImpl, now, registryDir })`:
     - Swapy safety rule: verifies `pid` and `command` match the live process table / registry record at click time before sending `SIGTERM` (`killImpl(pid, 'SIGTERM')`), logs to `closed-sessions.jsonl`, and marks worker `failed` in `registry`.
   - `main(argv)` supporting `roostr governor [--json]` and `roostr governor reap [--dry-run] [--yes] [--minutes 30]`.
3. **`bin/roostr`**:
   - Wire `registry`, `governor`, and `run` (calling `require('../src/runner').main(rest)` lazily so `pkg-p1-headless-runner` can be developed in parallel) into `bin/roostr`.
4. **Tests & Rules**:
   - Add thorough unit tests in `test/registry.test.js` and `test/governor.test.js`.
   - Zero external npm dependencies. No em dashes (`—`) anywhere. Run `node --test test/registry.test.js test/governor.test.js` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
node --test test/registry.test.js test/governor.test.js
env -u HERDR_ENV ./verify.sh
```
