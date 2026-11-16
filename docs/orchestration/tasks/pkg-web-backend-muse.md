# Task pkg-web-backend-muse

- Owner: Valentin (`valentin`), `gemini-4-hydrogen-medium`, branch `crew/valentin`
- Report: `docs/orchestration/reports/pkg-web-backend-muse.md` ending with `VALENTIN_DONE` or `VALENTIN_BLOCKED`

## Scope (touch ONLY `dashboard/src/{config,validate,herdr,muse,sessions-bridge,app}.js`, `dashboard/test/{validate,app}.test.js`, and your report)

1. **`dashboard/src/config.js` & `dashboard/src/validate.js`**:
   - In `dashboard/src/config.js`, add:
     - `roostrStateDir`: `env.ROOSTR_STATE_DIR || path.join(homeDir, '.roostr')`
     - `roostrRepoDir`: `env.ROOSTR_REPO_DIR || path.resolve(__dirname, '..', '..')`
     - `piorelayBase`: `env.PIORELAY_BASE || 'http://100.97.196.10:3016/api/v1'`
   - In `dashboard/src/validate.js`, add and export:
     - `validateOptionalModel(raw)`: optional string (empty/null/undefined returns `{ ok: true, value: null }`), max 80 chars, `/^[A-Za-z0-9._:/-]+$/` (rejects leading `-`).
     - `validateOptionalEffort(raw)`: optional string, allowlist `['low', 'medium', 'high', 'xhigh']` (empty/null/undefined returns `{ ok: true, value: null }`).
     - `validateOptionalSessionId(raw)`: optional string, `/^[A-Za-z0-9_:-]{1,128}$/` (rejects leading `-`).
     - `validateSplitDirection(raw)`: `'right'` or `'down'` (defaults to `'right'`).
     - `validateMuseMessage(body)`: validates `{ to, subject, body, project, threadId }` (`to`: `/^[a-z0-9-]{1,32}$/`, `subject`: 1..140 chars no control chars, `body`: 1..16000 chars, optional `project`: `/^[a-z0-9-]{1,32}$/` default `'muse'`, optional `threadId`: max 80 chars).
2. **`dashboard/src/herdr.js`**:
   - Extend `startAgent(paneId, name, kind, opts = {})`:
     - Build native args after `'--'` when `opts.session`, `opts.model`, or `opts.effort` are provided:
       - `claude`: `--resume <session>`, `--model <model>`, `--effort <effort>`
       - `opencode` / `kilo`: `--session <session>`, `--model <model>`
       - `agy`: `--conversation <session>`, `--model <model>`, `--effort <effort>`
     - When none of `opts.session`, `opts.model`, `opts.effort` are set, keep exact existing argv `['agent', 'start', nv.value, '--kind', kv.value, '--pane', pv.value]` so existing unit tests pass!
   - Add `splitPane(paneId, direction = 'right', cwd = null)`: calls `runHerdr(['pane', 'split', '--pane', pv.value, '--direction', dir, ...(cwd ? ['--cwd', cwd] : []), '--no-focus'])`.
3. **`dashboard/src/sessions-bridge.js`**:
   - Create helper module reading:
     - `savedSessions`: reads `<roostrStateDir>/sessions.json` (array of saved pane sessions).
     - `backups`: reads `<roostrStateDir>/backups/*/v*.json` (summary list of workspace backups: `{ workspaceId, label, version, capturedAt, paneCount, panes }`).
     - `orchestration`: reads `<roostrRepoDir>/docs/orchestration/tasks.json` and lists `<roostrRepoDir>/docs/orchestration/handoffs/*.md` + `<roostrRepoDir>/docs/orchestration/reports/*.md`.
     - Provides `getRecoverySnapshot({ roostrStateDir, roostrRepoDir })` returning `{ sessions, backups, orchestration }`.
4. **`dashboard/src/muse.js`**:
   - Create helper module unifying Muse agents from `staticDir`, `statusPath`, and `namesStore`:
     - Reads `<staticDir>/data.json` (`roman_desk`, `tier1`, `tier2`), `<staticDir>/workers/workers.muse.json`, and `statusPath` (`status.json`).
     - Normalizes each Muse agent (including `roman` from `roman_desk` / `workers.muse.json` and every `tier1` agent like `engy`, `el-vigia`, `la-critica`, `buildy-1`, `buildy-2`, `romy-car`, `romy-ril`, `archy`, `historia`, `fabu`, `repy`) into:
       `{ slug, name, sourceName, overrideName, isOrchestrator, emoji, role, state, currentTask, nextTask, blocker, session, model, tokensToday, lastActivityAst, tasks, docs, bank }`.
     - Provides `sendPioRelayMessage({ piorelayBase, from, to, subject, body, project, threadId, fetchImpl })`: POSTs JSON `{ from_agent: from, to_agent: to, subject, body, thread_id: threadId, client_msg_id, project, kind: 'task' }` to `${piorelayBase}/agent-messages` with a 5s timeout (and returns `{ ok: true, result }` or `{ ok: false, status: 502, error }`).
5. **`dashboard/src/app.js` — Wire new authenticated API routes**:
   - `GET /agents/api/sessions`: returns `getRecoverySnapshot(...)`.
   - `POST /agents/api/pane/:id/start`: accepts optional `{ name, kind, model, effort, session }` and forwards `{ model, effort, session }` to `herdr.startAgent`.
   - `POST /agents/api/pane/:id/split`: accepts `{ direction, cwd, startAgent: { name, kind, model, effort, session } }` -> calls `herdr.splitPane` (and optionally `herdr.startAgent` on the returned pane ID), logs to `audit`, returns `{ ok: true, paneId }`.
   - `GET /agents/api/muse`: returns `{ romanDesk, agents, tier2, generatedEpoch, stampAst }`.
   - `POST /agents/api/muse/message`: validates with `validateMuseMessage`, calls `sendPioRelayMessage` (using injectable `deps.fetch` or global `fetch`), logs to `audit`, returns `200` `{ ok: true, relay: ... }` (or `502` if relay unreachable).
6. **Tests & Rules**:
   - Expand `dashboard/test/validate.test.js` and `dashboard/test/app.test.js` to test `/agents/api/sessions`, `/agents/api/pane/:id/start` with `session`/`model`/`effort`, `/agents/api/pane/:id/split`, `/agents/api/muse`, and `/agents/api/muse/message`.
   - No em dashes (`—`) anywhere. Run `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
(cd dashboard && npm test)
env -u HERDR_ENV ./verify.sh
```
