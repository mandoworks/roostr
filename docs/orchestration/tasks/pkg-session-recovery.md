# Task pkg-session-recovery

- Owner: Martin (`martin`), `gemini-4-hydrogen-medium`, branch `crew/martin`
- Report: `docs/orchestration/reports/pkg-session-recovery.md` ending with `MARTIN_DONE` or `MARTIN_BLOCKED`

## Scope (touch ONLY `bin/roostr`, `src/sessions.js`, `src/session-log.js`, `src/workers.js`, `test/sessions.test.js`, `test/session-log.test.js`, and your report)

1. **`src/sessions.js` — Multi-agent session discovery, model persistence, and orchestration metadata**:
   - In `agentArgs(s)`:
     - For `agy` / `antigravity`, pass `if (exactModel) args.push('--model', exactModel);` alongside `--conversation` and `--effort`.
   - Add local filesystem session store discovery (zero external deps, respecting env overrides for tests) inside `sessionList(kind, options)`:
     - `agy` / `antigravity`: scan `options.agyBrainDir || process.env.ROOSTR_AGY_BRAIN_DIR || path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')`. For each `<uuid>` directory matching `/^[0-9a-f-]{36}$/i`, inspect `.system_generated/logs/transcript.jsonl` (or directory `mtimeMs` fallback) to extract `{ id, kind: 'agy', directory, title, updated }`. Read only the first ~16 KB of `transcript.jsonl` to find workspace/cwd hints (`Active Workspaces:` or `Command Working Directory:`) and the first `USER_INPUT` content as `title`.
     - `claude`: scan `options.claudeProjectsDir || process.env.ROOSTR_CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects')`. For each project subdir and `<uuid>.jsonl` file, extract `{ id, kind: 'claude', directory, title, updated }` from the first few lines (`cwd` field and first user message text or summary) and file `mtimeMs`.
     - Keep `opencode` and `kilo` CLI `session list --format json` support unchanged.
   - Update `resolveAgentSessions(snap, options)` and `resolveSavedSessions(entries, options)` so unresolved `agy`, `claude`, and `kilo` panes also resolve their `session_id` / `session` by matching `directory === cwd` (most recently updated unclaimed session for that cwd, or title match when available).
   - In `fromRow` / `fromAgent`, also preserve `handoff` (path to `docs/orchestration/handoffs/latest-<slug>.md` when present in `cwd`) and `worktree` (`true` when `cwd` contains `/.worktrees/`) in each saved session entry in `sessions.json`.
2. **`src/session-log.js` — Support `agy` and `claude` in `roostr log`**:
   - Expand `KINDS` from `['opencode', 'kilo']` to `['opencode', 'kilo', 'claude', 'agy']` and update `USAGE` (`--kind opencode|kilo|claude|agy|all`).
   - Ensure `resume(item, options, deps)` works cleanly for `agy` and `claude` as well as `opencode` and `kilo`.
3. **`bin/roostr` & `src/workers.js` — Continuous session persistence**:
   - When `roostr --json` (`bin/roostr`) or `roostr workers` (`src/workers.js`) runs against a live Herdr snapshot, resolve agent sessions (`sessions.resolveAgentSessions`) and call `sessions.saveSessions(model)` (best-effort `try/catch`) so `roostr-publish.timer` keeps `~/.roostr/sessions.json` fresh every minute even when no interactive TUI is open.
4. **Tests & Rules**:
   - Add unit tests in `test/sessions.test.js` and `test/session-log.test.js` using temp dirs (`ROOSTR_AGY_BRAIN_DIR`, `ROOSTR_CLAUDE_PROJECTS_DIR`) verifying `agy` and `claude` session discovery, `agentArgs` `--model` for `agy`, and `roostr log --kind all`.
   - Zero external npm dependencies. No em dashes (`—`) anywhere. Run `node --test test/sessions.test.js test/session-log.test.js` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
node --test test/sessions.test.js test/session-log.test.js
env -u HERDR_ENV ./verify.sh
```
