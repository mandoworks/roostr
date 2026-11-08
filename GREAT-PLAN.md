# GREAT-PLAN.md: Converging `crew-board` and `roostr` into the v0.3.0 Release

This document is a step-by-step execution blueprint for any coding agent assigned to finish merging, hardening, and shipping the remaining features between the internal `crew-board` repository and the open-source `roostr` Herdr plugin repository.

Read every section before touching code. Every phase has explicit file targets, exact invariants, and a mandatory verification gate.

## Live Resume Checklist (Update `[x]` As You Finish Each Item)

- [x] **Canonical `roostr` Skill & Reference Schema**: `skills/roostr/SKILL.md` and `skills/roostr/references/schemas-and-config.md` authored, tested (`test/skill.test.js`), and synced across toolchains; `agent-crew` superseded.
- [x] **Consolidated 3-Tab `[O orchestrate]` TUI Hub**: Implemented in `src/board.js` and tested in `test/board.test.js` (`107/107` board + skill tests passing).
- [x] **Event-Woken Orchestrator Token Discipline (`<20%` Orchestrator Spend, `<30%` Context)**: Documented in `skills/roostr/SKILL.md` (Rule 0) and `templates/agents/head-honcho.md`.
- [ ] **Phase 1**: Backport `roostr`'s newer `src/board.js` features (`cards` view, `options` view, `COMPACT` at 50%, `runLive` queued tick) into `crew-board/src/board.js` and fix the pre-existing `d90abb6` test regressions in `crew-board/test/board.test.js`.
- [ ] **Phase 2**: Expand `bin/roostr` header comments and `src/board.js` `HELP` so `roostr --help` lists all orchestration subcommands (`recommend`, `spawn`, `outcome`, `summary`, `tasks`, `template`, `name`) within the 80x28 terminal budget (`test/cli.test.js`).
- [ ] **Phase 3.1**: Add `--execute` (and `--reuse <pane-id>`) to `roostr spawn` in `src/orchestrator.js` (or `src/orchestrate.js`) with unit tests in `test/orchestrator.test.js`.
- [ ] **Phase 3.2**: Enforce all 5 procedural escalation triggers in `src/daemon.js` (`loop-3x`, `stalled-180s`, `blocked`, `context-ceiling` at 85%, `test-regression-2x`) and surface `subagent token share %` in `src/analytics.js`.
- [ ] **Phase 3.3**: Add `fs.realpathSync` path guard in `src/crewfile.js` / `src/report.js` and `.bak` state recovery in `src/state.js`.
- [ ] **Phase 4 (Optional)**: Extract `src/views/*.js` from `src/board.js` while keeping all exports on `src/board.js` intact.

---

## 0. Critical Architecture Warning: Why `scripts/publish-roostr.sh` Must Not Be Run Blindly

Historically, `crew-board` was the upstream development repository and `roostr` was a downstream mirror updated via `crew-board/scripts/publish-roostr.sh` (which runs `rsync --delete` from `crew-board/src/` onto `roostr/src/`).

**Do not run `scripts/publish-roostr.sh` as-is.** The two repositories have diverged in both directions:

### What `roostr` (`main`) has that `crew-board` (`integration/v0.2.0`) does NOT have:
1. **`cards` layout (`w` key) and `options` drawer (`o` key, `--options` flag)** in `src/board.js`:
   - `optionsLines(m, width, opts)` rendering Tokscale connection status, Context Compaction thresholds (`>=30% notice`, `>=50% warn`, `>=75% high`, `>=85% critical`), Board Settings, and Storage Paths.
   - `cards` view layout alongside `auto`, `columns`, `table`, `compact`, `line`.
   - Early `COMPACT` badge warnings starting at `50%` context dilution (`warn` at 50%, `high` at 75%, `critical` at 85%).
   - Queued interactive `tick()` handling (`running` / `pending` lock in `runLive`) preventing overlapping render ticks.
2. **Post-install skill registration (`scripts/postinstall.js` and `package.json`)**:
   - Copies `skills/roostr/` into `~/.herdr/skills/roostr`, `~/.claude/skills/roostr`, and `~/.config/opencode/skills/roostr`.
3. **OpenCode integration plugin renamed (`integrations/opencode/roostr.mjs`)**:
   - Uses `ROOSTR_BIN` and `roostr` paths instead of `CREW_BOARD_BIN` and `crew-board.mjs`.
4. **Public CLI strings in `src/board.js` and `test/cli.test.js`**:
   - `HELP` uses `usage: roostr [options]` and `roostr sessions [--json]`.

### What `crew-board` (`integration/v0.2.0`) has that `roostr` (`main`) still needs or differs on:
1. **CLI Help & Header Parity (`bin/roostr` and `src/board.js` `HELP`)**:
   - `crew-board/bin/roostr` documents all orchestration subcommands in its header comments (`recommend`, `spawn`, `outcome`, `summary`, `tasks`, `template`, `name`, `report`, `backups`, `analytics`, `sessions`, `restore`).
   - `roostr/src/board.js` `HELP` currently lists only `report`, `backups`, `analytics`, `sessions`, and `restore` in its `commands:` block; it should also list `recommend`, `spawn`, `outcome`, `summary`, `tasks`, `template`, and `name` so CLI users discover the full orchestration surface via `roostr --help`.
2. **Design & Backlog Documents (`crew-board` root)**:
   - `MULTI-AGENT-CODING-SYSTEM-DESIGN.md`, `GLYPH-IMPROVEMENTS.md`, `LATER-TASKS.md`, `IMPROVEMENT-PLAN.md`, and `web/` (marketing/docs landing page).
3. **Already Converged in Both Repos**:
   - Both repos already contain identical `src/advisor.js`, `src/analytics.js`, `src/backup.js`, `src/config.js`, `src/crewfile.js`, `src/daemon.js`, `src/herdr.js`, `src/ledger.js`, `src/log.js`, `src/names.js`, `src/orchestrate.js`, `src/pricing.js`, `src/report.js`, `src/sessions.js`, `src/setup.js`, `src/state.js`, `src/summary.js`, `src/tasks.js`, `src/tokscale.js`, `src/ui.js`.
   - Both repos already contain the consolidated 3-tab `[O orchestrate]` TUI hub (`O` or `T` key) in `src/board.js` and `test/board.test.js`.
   - Both repos already contain the canonical `skills/roostr/SKILL.md` and `skills/roostr/references/schemas-and-config.md`.

---

## Phase 1: Make `roostr` the Primary Source of Truth and Backport to `crew-board`

### Step 1.1: Port `roostr`'s Newer `src/board.js` Features into `crew-board/src/board.js`
1. Diff `roostr/src/board.js` against `crew-board/src/board.js`.
2. Port the following `roostr` additions into `crew-board/src/board.js` (while either keeping `crew-board`'s `HELP` binary name parameterized or updating `crew-board/test/cli.test.js` to accept `roostr`):
   - `VIEWS = ['auto', 'columns', 'cards', 'table', 'compact', 'line']`
   - `options` flag in `parseArgs` (`--options`), `[o options]` menu button, `o` keybinding, and `optionsLines(m, width, opts)`
   - `cards` view rendering (`w` keybinding and `cardsLines`)
   - `COMPACT` badge threshold at `50%` (`warn` at `>=50%`, `high` at `>=75%`, `critical` at `>=85%`)
   - `runLive` queued `tick()` concurrency guard (`running` / `pending` flags)
3. Port the corresponding unit tests from `roostr/test/board.test.js` (lines 1850 to 1923: context dilution `COMPACT` at 50%/82%, `menu: options item`, `help: options row`, `render: options view`, `parseArgs: --options flag`) into `crew-board/test/board.test.js`.
4. Fix the pre-existing `d90abb6` regressions in `crew-board/test/board.test.js` (add `const tokscale = require('../src/tokscale');` at the top of `test/board.test.js` for the U2 tests, and align line 521 / 1174 with `roostr/test/board.test.js`).

### Step 1.2: Enforce Orchestrator Token Discipline (`>80%` Subagent Spend)
When running any multi-agent batch using `roostr`:
1. **The Orchestrator Never Codes**: The orchestrator (Head Honcho / lead agent) must only interview, author `docs/orchestration-plan.md`, write `docs/orchestration/tasks.json` and compact subagent briefs (`docs/orchestration/tasks/<id>.md`), dispatch/supervise worker panes, review completion reports (`docs/orchestration/reports/<id>.md`), and merge verified worktrees.
2. **Token Distribution**: Over `80%` of batch tokens must be consumed by the subagent panes, keeping the orchestrator's own context window below `30%`.
3. **Analytics Visibility**: In `src/analytics.js` (`by: 'pane'` and `by: 'batch'`) and the `[O orchestrate]` Tab 2 (`analytics · summary`), consider surfacing a `subagent token share %` indicator (`worker tokens / total batch tokens`) so the human can immediately see if the orchestrator is coding instead of delegating.

### Step 1.3: Fix `crew-board/scripts/publish-roostr.sh`
Update `crew-board/scripts/publish-roostr.sh` so it never overwrites `roostr` without a fast-forward check:
1. Ensure `scripts/postinstall.js` and `integrations/opencode/roostr.mjs` are preserved in `roostr`.
2. Parameterize the binary name in `src/board.js` `HELP` (or unify both repos on `roostr` in `HELP` and update `crew-board/test/cli.test.js` line 15 to match `/roostr|crew-board/`).
3. Run `./verify.sh` in `crew-board` and `./verify.sh --public` in `roostr` to confirm 100% parity.

---

## Phase 2: Complete CLI Help & Subcommand Discovery in `roostr`

### Step 2.1: Expand `HELP` in `src/board.js` and `bin/roostr`
1. In `roostr/bin/roostr`, update the top comment block to match `crew-board/bin/roostr` so all subcommands (`report`, `recommend`, `spawn`, `outcome`, `summary`, `tasks`, `template`, `name`, `backups`, `analytics`, `sessions`, `restore`) are documented.
2. In `src/board.js`, update the `HELP` constant's `commands:` section so `roostr --help` lists all orchestration subcommands concisely on a single screen (fitting within the 80x28 terminal budget tested by `test/cli.test.js`!):
   - Verify `test/cli.test.js` (`help: fits in 80x24 or scrolls cleanly; every flag in parseArgs is documented` and `help: the command list ends on the page, no truncation`) passes after editing `HELP`.

---

## Phase 3: Ungating & Hardening v0.3.0 Orchestration Features

### Step 3.1: Smart Spawner Execution Mode (`roostr spawn --execute`)
Currently, `roostr spawn` (`src/orchestrate.js` `runSpawn`) is a dry-run planner: it picks a collision-free rooster handle (`src/names.js`), queries `advisor.recommend` (`src/advisor.js`), and returns a JSON object containing the `steps` array (`herdr pane split`, `herdr agent start`, `herdr pane rename`, `roostr report`, `herdr agent prompt`).
1. Add `--execute` (and `--cwd <worktree>`, `--direction right|down`, `--prompt <text>`) to `parseSpawnArgs` in `src/orchestrate.js`.
2. When `--execute` is passed:
   - If `--reuse <pane-id>` is passed for a warm idle worker pane (`ctx < 30%`):
     - Send `/clear` (or `/new` for OpenCode) via `herdr.run(['agent', 'prompt', name, resetCmd])` and wait for `idle` before injecting the new task brief.
   - Otherwise, execute `herdr pane split --current --direction <dir> --cwd <cwd> --no-focus`, capture the returned `pane_id`, run `herdr agent start <name> --kind <tool> --pane <pane_id> -- <toolArgs>`, run `herdr pane rename <pane_id> "<name> · <role>"`, register metadata via `report.writeReport`, and record the initial `spawned` event in `ledger.append`.
   - If `--prompt <text>` or `--brief-file <path>` is provided, wait for the agent to reach `idle` (`herdr agent wait <name> --state idle --timeout 30`) and send the prompt via `herdr agent prompt <name> "<prompt>"`.
3. Add unit tests in `test/orchestrate.test.js` using a mocked `herdr` runner so no real panes are required during unit testing.

### Step 3.2: Enforce the 5 Procedural Escalation Triggers in `src/daemon.js`
In `src/daemon.js`, expand `evaluatePane(row, report, history)` to detect all 5 structural escalation triggers defined in the system design:
1. **3 consecutive identical failing commands**: Track last 3 command hashes/exit statuses in daemon state or report events; flag `loop-3x`.
2. **Inactivity timeout (`> 180s` in `working` state with zero output delta)**: Compare last output timestamp / terminal snapshot hash; flag `stalled-180s`.
3. **Interactive permission or question prompt (`blocked` state)**: Already partially detected via `permissionPrompt`; classify into `safe-continue` vs `escalate-to-honcho`.
4. **Context ceiling (`ctx >= 85%` or turn budget exceeded)**: Flag `context-ceiling` and recommend handoff or fresh pane split (`ctx >= 30%` blocks warm-pane reuse for new tasks).
5. **Two consecutive test regression cycles**: Track consecutive failed test runs reported via `roostr report`; flag `test-regression-2x`.

Add unit tests for each trigger in `test/daemon.test.js`.

### Step 3.3: Symlink-Safe Path Resolution & State Corruption Recovery
1. **Symlink-Safe Path Guard (`src/crewfile.js` and `src/report.js`)**:
   - Before writing `.herdr/crew.json` or report files, resolve the target directory with `fs.realpathSync` and verify it stays inside the expected workspace or `~/.herdr/roostr` directory.
   - Add a test in `test/security.test.js` verifying that a symlinked path pointing outside the root is rejected.
2. **Automatic `.bak` Recovery (`src/state.js` and `src/ledger.js`)**:
   - Before atomic rename in `state.save`, copy the existing valid `state.json` to `state.json.bak`.
   - In `state.load`, if `JSON.parse` fails on `state.json`, log a warning via `src/log.js` and fall back to `state.json.bak`.
   - In `ledger.readAll`, already skips malformed JSONL lines; add a counter or `log.warn` with line number when skipping corrupted lines.
   - Add unit tests in `test/reliability.test.js`.

### Step 3.4: Enable Orchestration by Default for v0.3.0 (When Ready)
Currently, `board.orchestrationEnabled(cfg, opts)` (`src/board.js`) returns `true` only when `ROOSTR_ORCHESTRATION=1`, `ROOSTR_EXPERIMENTAL=1`, `--orchestration` is passed on the CLI, or `"orchestration": { "enabled": true }` is set in `~/.herdr/roostr/config.json`.
- Keep the gate opt-in during v0.2.x patch releases, or flip `orchestrationEnabled` to default `true` (with `ROOSTR_ORCHESTRATION=0` to disable) when cutting `v0.3.0` after live soak testing.
- If flipping the default for `v0.3.0`, update `test/board.test.js` (`menu: orchestration items are hidden by default` and `orchestrationEnabled: checks env, options and config`) accordingly.

---

## Phase 4: Modularizing `src/board.js` (Optional Clean Refactor)

`src/board.js` is currently ~4,180 lines. Once Phases 1 through 3 are green, extract pure view modules under `src/views/` while keeping all public exports on `src/board.js` intact (so `test/board.test.js` requires zero import changes):
1. `src/views/orchestrate.js`: `orchestrateState`, `orchestrateLines`, `orchestrateKey`, `loadOrchestrateContext`, `writeTaskOverride`, `ORCH_TABS`, `ORCH_EFFORTS`.
2. `src/views/setup.js`: `setupState`, `setupLines`, `setupKey`.
3. `src/views/today.js`: `todayLines`, `sparkline`, `hourHistogram`.
4. `src/views/backups.js`: `backupState`, `backupLines`, `backupKey`.
5. `src/views/options.js`: `optionsLines`.

Re-export each function from `src/board.js` so every existing test in `test/board.test.js` continues to pass unchanged.

---

## Phase 5: Skill Distribution & Repository Commit Policy

The `roostr` orchestration skill lives in two places that must stay identical:
1. **Inside the `roostr` plugin repo (`skills/roostr/SKILL.md` and `skills/roostr/references/schemas-and-config.md`)**:
   - Shipped with the plugin and automatically installed to `~/.herdr/skills/roostr`, `~/.claude/skills/roostr`, and `~/.config/opencode/skills/roostr` by `scripts/postinstall.js`.
   - Validated on every test run by `test/skill.test.js`.
2. **Inside the central skills repo (`roostr/SKILL.md` and `roostr/references/schemas-and-config.md`, with `crew-board -> roostr` symlink and `agent-crew/SKILL.md` deprecation redirect)**:
   - Synced across local agents via `python3 skills_manager.py sync`.

**Important `test/skill.test.js` rule**:
- Every `roostr report` example in `skills/roostr/SKILL.md` must keep `--pane` and `--task` on the **same line** as `roostr report` (do not put `--task` on a new line after a `\` continuation), because `test/skill.test.js` matches `roostr report([^\n]+)` on a single line.

---

## Phase 6: Mandatory Verification Gates

Before committing or pushing any change in either repository:

1. **In the open-source `roostr` repository**:
   ```bash
   ./verify.sh --public
   ```
   All 7 gates must pass with 0 failures:
   - Syntax check (`node --check` on every script and `src/**/*.js`)
   - Full unit test suite (`test/*.test.js` including `test/skill.test.js`)
   - Manifest check (`plugin.json` commands, keybindings, entry points)
   - Zero runtime dependencies check
   - Executable entry points check
   - Public hygiene check (zero private hostnames, usernames, `/Users/` or `/home/<user>/` paths in tracked files or git history)
   - Live Herdr smoke test

2. **In the internal `crew-board` repository**:
   ```bash
   ./verify.sh
   ```
   All gates must pass with 0 failures.

3. **Prose hygiene check**:
   - Never use an em dash or a spaced hyphen (` - `) to divide clauses in prose or comments.
