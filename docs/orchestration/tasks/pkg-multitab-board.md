# Task pkg-multitab-board

- Owner: Martin (`martin`), `gemini-4-hydrogen-medium`, branch `crew/martin`
- Report: `docs/orchestration/reports/pkg-multitab-board.md` ending with `MARTIN_DONE` or `MARTIN_BLOCKED`

## Scope (touch ONLY `src/{herdr,board,sessions,restore,backup}.js`, `test/{board,sessions,restore}.test.js`, and your report)

1. **`src/board.js` — Show agents across ALL tabs (`t1`, `t2`, `t3`, etc.) and synthesize non-active-tab / exited agent rows**:
   - In `selectAgents(snap, workspace, opts = {})`:
     - Currently `selectAgents` only iterates `snap.agents`, which misses panes on other tabs (`t2`, `t3`, etc.) or panes whose agent exited/hasn't been viewport-rendered by Herdr yet.
     - Build a map of `snap.agents` by `pane_id`. Then also inspect `snap.panes`: if a pane `p` in `snap.panes` is not in `snap.agents` and not `isBoardAgent(p, myPaneId)`, synthesize an agent entry `{ ...p, pane_id: p.pane_id, workspace_id: p.workspace_id, tab_id: p.tab_id, agent: inferredKind, name: p.name || null, agent_status: p.restore_error ? 'blocked' : (p.agent_status || 'unknown') }` when ANY of the following holds:
       a) `p.agent` is a non-empty string, or `p.agent_session && p.agent_session.agent` is present.
       b) `p.restore_error` is present.
       c) `opts.reports && opts.reports[p.pane_id]` exists, or `opts.savedByPane && opts.savedByPane.has(p.pane_id)` exists.
       d) `typeof p.label === 'string' && TAG_RE.test(p.label)` (a roostr/crew colour-tagged pane).
       e) `opts.detectedByPane && opts.detectedByPane.has(p.pane_id)` (an agent binary detected in the pane's process tree or screen).
     - Sort selected agents by `(workspaceOrder, tabOrder, paneOrder)` using `snap.tabs` (`t.number` or index in `snap.tabs`), so tabs `t1`, `t2`, `t3` appear in order!
   - In `buildModel(...)`:
     - Map `snap.tabs` by `tab_id` (`tabById`).
     - Attach `tabId: a.tab_id || pane.tab_id || null`, `tabNumber: (tab && tab.number) || 1`, and `tab: (tab && tab.label) || null` to each row in `rows`, plus count how many distinct tabs exist in that workspace (`workspaceTabCount`).
   - In `renderBoard` (`src/board.js`, both table and cards view):
     - When a row belongs to a workspace with multiple tabs (`r.tabNumber > 1` or `(r.tab && !/^\d+$/.test(r.tab))`), include a compact tab badge in the row or subheader (for example `[t${r.tabNumber}${r.tab && !/^\d+$/.test(r.tab) ? ':' + r.tab : ''}]` or in `wsHeader` / card header) so the user immediately sees which tab (`[t2]`, `[t3:migration]`) each agent is on!
2. **`src/herdr.js` — Focus fallback for multi-tab panes**:
   - In `focusAgent(paneId)` (`src/herdr.js`), wrap `runJson(['agent', 'focus', paneId])` in `try/catch` and fall back to `runJson(['pane', 'focus', paneId])` so jumping to a pane on Tab 2 / Tab 3 works even when the agent is synthesized or exited.
3. **`src/sessions.js` & `src/restore.js` — Multi-tab session persistence & `opencode.db` (`session_v2`) lookup**:
   - In `fromRow` and `fromAgent` (`src/sessions.js`), persist `tabId: clean(row.tabId || (agent && agent.tab_id) || (pane && pane.tab_id))` and `tab: clean(row.tab)` when present.
   - In `restoreSessions` (`src/sessions.js`), when restoring multiple sessions into a workspace that have distinct `tabId` or `tab` values (and no existing live pane matches `s.paneId`), group by tab within the workspace and call `herdr.createTab(targetWsId, s.cwd, namedTabLabel)` (when `typeof herdr.createTab === 'function'` and it's a secondary tab not yet created) so agents from Tab 2 / Tab 3 restore into separate tabs rather than all piling into Tab 1! (Keep single-tab restore behavior 100% compatible with existing `sessions.test.js` and `restore.test.js`!)
   - In `sessionList('opencode', options)` (`src/sessions.js`), if `opencode session list` returns empty or misses sessions from other directories/tables, also support reading `~/.local/share/opencode/opencode.db` (`options.opencodeDb || process.env.ROOSTR_OPENCODE_DB`) via `sqlite3` CLI (`execFile('sqlite3', ['-json', dbPath, 'SELECT id, title, directory, time_updated AS updated FROM session_v2 UNION ALL SELECT id, title, directory, time_updated AS updated FROM session ORDER BY updated DESC LIMIT 200'])`) best-effort, merging and deduplicating by `id`!
4. **Tests & Rules**:
   - Add unit tests in `test/board.test.js`, `test/sessions.test.js`, and `test/restore.test.js` covering multi-tab agent selection/ordering, synthesized agent panes on Tab 2/Tab 3, `tabId`/`tab` in `sessions.json`, and multi-tab `restoreSessions`.
   - Zero external npm dependencies. No em dashes (`—`) anywhere. Run `node --test test/board.test.js test/sessions.test.js test/restore.test.js` and `env -u HERDR_ENV ./verify.sh` synchronously and wait for exit 0 before writing your report. Do not commit or push.

## Verification
```bash
node --test test/board.test.js test/sessions.test.js test/restore.test.js
env -u HERDR_ENV ./verify.sh
```
