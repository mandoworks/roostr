# Report: pkg-multitab-board

- Owner: Martin (`martin`)
- Branch: `crew/martin`
- Status: Complete

## Changes Implemented

1. **`src/board.js`**:
   - Updated `selectAgents(snap, workspace, opts = {})` to map `snap.agents` by `pane_id`, inspect `snap.panes` for non-active-tab or exited agent panes matching any of the 5 criteria (`p.agent` or `p.agent_session.agent`, `p.restore_error`, `opts.reports` or `opts.savedByPane`, `TAG_RE.test(p.label)`, `opts.detectedByPane`), synthesize agent rows with `agent_status: p.restore_error ? 'blocked' : (p.agent_status || 'unknown')`, and sort by `(workspaceOrder, tabOrder, paneOrder)` using `snap.tabs`.
   - Updated `buildModel(...)` to map `snap.tabs` by `tab_id`, compute `workspaceTabCount`, and attach `tabId`, `tabNumber`, `tab`, and `workspaceTabCount` to each row.
   - Added `tabBadge(r)` and rendered compact tab badges (`[t2]`, `[t3:migration]`) in both table (`rowCells` `id` cell) and cards (`renderBoard` card header) views when `r.tabNumber > 1` or a named tab label is present.

2. **`src/herdr.js`**:
   - Updated `focusAgent(paneId)` to wrap `runJson(['agent', 'focus', paneId])` in `try/catch` and fall back to `runJson(['pane', 'focus', paneId])`.

3. **`src/sessions.js`**:
   - Updated `rowsFromModel`, `fromRow`, `fromAgent`, and `signature` to persist `tabId` and `tab` when present.
   - Updated `restoreSessions(sessions, options = {})` to group sessions by tab within a workspace when multiple distinct tabs exist and `typeof herdr.createTab === 'function'`, calling `herdr.createTab(targetWsId, s.cwd, namedTabLabel)` for secondary tabs and keeping per-tab split state while preserving single-tab behavior.
   - Updated `sessionList('opencode', options)` to best-effort query `opencode.db` (`options.opencodeDb || process.env.ROOSTR_OPENCODE_DB || ~/.local/share/opencode/opencode.db`) via `sqlite3 -json` (`session_v2` and `session` tables) and merge/deduplicate results by `id`.

4. **Tests**:
   - Added unit tests in `test/board.test.js`, `test/sessions.test.js`, and `test/restore.test.js` covering multi-tab agent selection/ordering, synthesized panes, tab metadata and badges in table/cards views, `tabId`/`tab` persistence, multi-tab `restoreSessions` / `restore.execute`, and `opencode.db` `sqlite3` merging.

## Verification

- `node --test test/board.test.js test/sessions.test.js test/restore.test.js`: 176 passed, 0 failed.
- `env -u HERDR_ENV ./verify.sh`: exited 0 (`ALL CHECKS PASSED`).

MARTIN_DONE
