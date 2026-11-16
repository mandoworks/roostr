# Report: pkg-session-recovery

- Owner: Martin (`martin`), branch `crew/martin`
- Status: Complete

## Changes Made

1. **`src/sessions.js`**
   - Updated `agentArgs(s)` so `agy` and `antigravity` pass `--model <exactModel>` when `modelSrc === 'exact'`, alongside `--conversation` and `--effort`.
   - Added local filesystem session store discovery in `sessionList(kind, options)`:
     - `agy` / `antigravity`: scans `options.agyBrainDir || process.env.ROOSTR_AGY_BRAIN_DIR || ~/.gemini/antigravity-cli/brain` for `<uuid>` directories, reading up to 16 KB of `.system_generated/logs/transcript.jsonl` for `Command Working Directory:` / `Active Workspaces:` hints and the first `USER_INPUT` content as `title`, with directory `mtimeMs` fallback.
     - `claude`: scans `options.claudeProjectsDir || process.env.ROOSTR_CLAUDE_PROJECTS_DIR || ~/.claude/projects` for `<project>/<uuid>.jsonl` files, extracting `cwd`, first user message text or `summary`, and file `mtimeMs`.
     - Kept `opencode` and `kilo` CLI `session list --format json` support unchanged.
   - Updated `resolveAgentSessions(snap, options)` and `resolveSavedSessions(entries, options)` to resolve unresolved `agy`, `claude`, and `kilo` panes/entries by `directory === cwd` (preferring title match when available, falling back to the most recently updated unclaimed session for that `cwd`), while preserving conservative title-only matching for `opencode`.
   - Updated `fromRow`, `fromAgent`, and `signature` to preserve `handoff` (`docs/orchestration/handoffs/latest-<slug>.md` when present in `cwd`) and `worktree: true` (when `cwd` contains `/.worktrees/`).

2. **`src/session-log.js`**
   - Expanded `KINDS` to `['opencode', 'kilo', 'claude', 'agy']` and updated `USAGE` to `--kind opencode|kilo|claude|agy|all`.
   - Passed `agyBrainDir` and `claudeProjectsDir` options through `list()` to `sessions.sessionList()`.
   - Verified `resume(item, options, deps)` handles `agy` (`--conversation`) and `claude` (`--resume`) cleanly via `sessions.validSession` and `sessions.agentArgs`.

3. **`bin/roostr` & `src/workers.js`**
   - `bin/roostr`: when `roostr --json` (or `--json-rows`) exits 0, best-effort fetches a live Herdr snapshot, runs `sessions.resolveAgentSessions`, and calls `sessions.saveSessions(snap)`.
   - `src/workers.js`: when `roostr workers` runs against a live Herdr snapshot, best-effort runs `sessions.resolveAgentSessions(snap, { now: nowMs })` and `sessions.saveSessions({ snapshot: snap, reports })`.

4. **Tests (`test/sessions.test.js`, `test/session-log.test.js`)**
   - Added unit tests for `agy` `--model` handling in `agentArgs`, `ROOSTR_AGY_BRAIN_DIR` and `ROOSTR_CLAUDE_PROJECTS_DIR` session discovery, `resolveAgentSessions` / `resolveSavedSessions` for `agy` and `claude`, `handoff` / `worktree` metadata preservation, `roostr log --kind all`, and `log.resume` for `agy` and `claude`.

## Verification

- `node --test test/sessions.test.js test/session-log.test.js`: 42/42 passed (exit 0).
- `env -u HERDR_ENV ./verify.sh`: all checks passed (exit 0).

MARTIN_DONE
