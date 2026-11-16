# Task pkg-tui-recovery-ui

- Owner: Enrique (`enrique`), `gemini-4-hydrogen-low`, branch `crew/enrique`
- Report: `docs/orchestration/reports/pkg-tui-recovery-ui.md` ending with `ENRIQUE_DONE` or `ENRIQUE_BLOCKED`

## Scope (touch ONLY `src/ui.js`, `src/board.js`, `test/ui.test.js`, `test/board.test.js`, and your report)

1. **`src/ui.js` — Upgrade `[L log]` and `[B backups]` drawer rendering**:
   - In `renderLogDrawer` / log row formatting in `src/ui.js`:
     - Display the agent tool badge (`opencode`, `kilo`, `claude`, `agy`) clearly alongside the session ID prefix, updated age, directory basename, and conversation title.
     - Show a filter hint in the `[L log]` drawer header/footer (`k` to cycle kind filter `all ▸ opencode ▸ claude ▸ agy ▸ kilo`, `a` to toggle current workspace dirs vs all dirs, `Enter` to resume conversation in current workspace).
   - In `renderBackupsDrawer` / backup detail rendering in `src/ui.js`:
     - Show session resume readiness per pane (`[resumable]` when `session` is present, `[handoff]` when `handoff` brief path exists, `[fresh]` otherwise) and model/effort summary so operators can see at a glance what will recover.
2. **`src/board.js` — Key handling for `[L log]` kind filter**:
   - In the `[L log]` drawer key handler in `src/board.js`, support pressing `k` to cycle `logState.kind` through `['all', 'opencode', 'claude', 'agy', 'kilo']` and refresh the log list.
3. **Tests & Rules**:
   - Add/update unit tests in `test/ui.test.js` and `test/board.test.js` covering the `[L log]` kind badge/filter and `[B backups]` session/handoff badge rendering.
   - Zero external npm dependencies. No em dashes (`—`) anywhere. Run `node --test test/ui.test.js test/board.test.js` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
node --test test/ui.test.js test/board.test.js
env -u HERDR_ENV ./verify.sh
```
