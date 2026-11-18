# pkg-p1-registry-governor report

Owner: Martin (branch `crew/martin`). Task: `docs/orchestration/tasks/pkg-p1-registry-governor.md`.

## What changed

Scope respected: only `bin/roostr`, `src/registry.js`, `src/governor.js`,
`test/registry.test.js`, `test/governor.test.js` were touched. No commits, no pushes.

### `src/registry.js` (new)

Standalone worker registry, heartbeat, token auth and closed-session log. Zero
external dependencies; `node:crypto` for hashing.

- Paths come from `src/state-dir.js` `resolvePath`, so files live under
  `~/.roostr/`: `registry.json`, `tokens.json`, `closed-sessions.jsonl`.
  Overrides: `ROOSTR_REGISTRY` (registry file), plus `ROOSTR_STATE_DIR` /
  `CREW_BOARD_STATE_DIR` (directory) for every file.
- Every write is atomic (temp file + `chmod 0600` + `renameSync`) with mode 0600.
- Record schema, in order: `id, owner, orchestrator, host, task, session, kind,
  pid, command, cwd, rssKb, state, mode, logFile, placement, placementReason,
  model, effort, lastHeartbeat, startedAt, updatedAt, source: 'reported'`.
  `state` in `working | waiting-approval | idle | done | failed`; `mode` in
  `headless | pane`. Invalid state or mode throws.
- Exports: `registerWorker(payload, options)`, `updateStatus(id, patch, options)`,
  `listWorkers(options)`, `getWorker(id, options)`, `issueToken(label, options)`,
  `verifyToken(rawToken, options)`, `appendClosedSession(entry, options)`,
  `readClosedSessions(options)`, `main(argv, deps)`. Also exposes `registryFile`,
  `tokensFile`, `closedSessionsFile`, `VALID_STATES`, `VALID_MODES`, `USAGE`.
- `registerWorker` generates a kind-prefixed id when `--id` is omitted, stamps
  `startedAt` + `lastHeartbeat`, and preserves `startedAt` on re-register.
- `updateStatus` patches only `state, task, session, rssKb, pid, command,
  lastHeartbeat, updatedAt` (unknown ids return `null`).
- Tokens store only the SHA-256 hex digest in `tokens.json`; the raw value is
  returned once by `issueToken`. `verifyToken` compares digests with
  `crypto.timingSafeEqual`. Re-issuing a label rotates it.
- `closed-sessions.jsonl` records `{ at, id, pid, command, model, ramKb, session,
  paneId, workspaceId, reason }`, one JSON object per line.
- `main` supports `roostr registry [--json]`,
  `registry register --id ... --owner ... --task ... [--host --state --mode ...]`,
  `registry status --id ... --state ... [--task --session --rss-kb --pid --command]`,
  `registry token --label ...`. Exit 2 on a usage error, 1 on runtime error.

### `src/governor.js` (new)

Resource governor, placement policy and idle reaper. Pure and dependency-injected
(no herdr, process table or kills required for tests).

- Defaults: `macMaxLivePanes: 3`, `swapThresholdPct: 80`, `idleReapMinutes: 30`.
- `checkPaneSpawn({ host, livePaneCount, swapUsedPct, placement, placementReason,
  needsHuman, config })`, in this order: a `mac` placement with no non-empty reason
  is refused back to `ovh`; on a `mac`/`darwin` host at the pane budget it is
  refused to `headless` with reason `pane budget exceeded (3/3 on mac)`;
  `swapUsedPct >= swapThresholdPct` is refused to `headless`; otherwise allowed.
- `findIdlePanes(panes, statusMap, now, thresholdMs)` returns non-board panes whose
  status is `idle` or `done` and whose `since` is at least `thresholdMs` old.
- `reapIdlePanes({ panes, statusMap, sessions, herdr, now, thresholdMs, dryRun,
  registryDir })` closes an idle pane only when a resumable session id is known
  (from `pane.agent_session`, a sessions map, or `sessions.validSession`). It calls
  `herdr.closePane(paneId)` unless `dryRun` and logs each close through
  `registry.appendClosedSession`. Returns `{ reaped, skipped, dryRun }`.
- `reapWorker({ id, pid, command, registry, processTable, killImpl, now,
  registryDir })` applies the Swapy rule: the pid and command must match the
  registry record and the live process table before `killImpl(pid, 'SIGTERM')`;
  on success it logs the close and marks the worker `failed`. Mismatches, unknown
  workers and missing pids are refused without a kill.
- `main(argv, deps)` supports `roostr governor [--json]` (config + counts) and
  `roostr governor reap [--dry-run] [--yes] [--minutes 30] [--json]`. A real close
  needs `--yes`; `--dry-run` (or its absence) previews. A missing herdr is a clean
  one-line error, exit 1.

### `bin/roostr`

Wired `registry` (sync), `governor` (promise), and `run`. `run` lazily requires
`../src/runner.js` inside a try/catch so the headless runner can land in parallel;
without it, `roostr run` prints `roostr run: headless runner not available
(src/runner.js missing)` and exits 1 rather than crashing. Help comment header
updated. `--help` output still comes from `board.js` (untouched).

## Interoperability notes for the parallel P1 tasks

These shapes are what `registry.json`, `tokens.json` and `closed-sessions.jsonl`
will contain, so the board, web bridge and runner branches can read them:

- `registry.json` is a JSON **array** of worker records (a `{ workers: [...] }`
  object is also read if present). `roostr registry` writes the array.
- `tokens.json` is a JSON array of `{ label, hash, createdAt }` (`{ tokens: [...] }`
  is also read). Only the SHA-256 hex `hash` is stored.
- `closed-sessions.jsonl` is one record per line with the schema above.
- Registry functions accept an `options` bag: `{ file }` (exact path), `{ dir }`
  (directory for every file), `{ env }` (an env object with the `ROOSTR_*`
  overrides), `{ now }` (ms or a function). This lets the board and web bridge
  point at `config.roostrStateDir` directly.

## Tests

Added `test/registry.test.js` and `test/governor.test.js` covering: record
stamping/schema/0600 file mode, id generation, re-register `startedAt`
preservation, state and mode validation, `updateStatus` allowed fields and unknown
ids, stable listing, token digest-only storage + constant-time verify + rotation,
closed-session append/read/0600, path resolution via `dir`/`env`/`ROOSTR_REGISTRY`
and `ROOSTR_STATE_DIR`, and the full CLI for both modules; plus the governor's
placement/mac-budget/swap refusals and check order, idle detection with threshold
and board-pane skipping, reaper dry-run vs real close with session gating,
Swapy-safe kill matching (command mismatch, dead pid, unknown worker, ram Map),
and the reap CLI preview plus herdr-down error.

## Verification

```
node --test test/registry.test.js test/governor.test.js
```
Result: exit 0, `# tests 20`, `# pass 20`, `# fail 0`.

```
env -u HERDR_ENV ./verify.sh
```
Result: exit 0, `ALL CHECKS PASSED` (syntax, full unit suite, manifest,
zero-dependency audit, hygiene, no shell execution). No em dashes in any touched
file. Manual smoke: `roostr registry register` and `roostr governor --json` work
against a temp `ROOSTR_STATE_DIR`; `roostr run` fails cleanly with runner absent.

MARTIN_DONE
