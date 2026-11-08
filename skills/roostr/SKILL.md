---
name: roostr
description: Orchestrate multi-agent coding crews in Herdr with the roostr board (`roostr` / `crew-board`). Use whenever planning, spawning, supervising, or reviewing worker panes in Herdr, routing tasks by empirical pass-rate data (`roostr recommend`, `roostr tasks`, `roostr summary`, `roostr analytics`), running the Head Honcho and Daemon/Secretary workflow, or inspecting agent status, context, and costs via the JSON board.
---

# Roostr Orchestration Skill

Canonical runbook for multi-agent orchestration in Herdr using the `roostr` plugin and CLI (`roostr`, or `./bin/roostr` inside the plugin repo). Load the `herdr` skill alongside this skill for cross-machine or advanced pane operations.

## Critical Traps (Read First)

0. **Orchestrator Token Discipline & Decomposition Threshold (`<20%` Orchestrator Overhead, `<30%` Context)**:
   - **When NOT to orchestrate (Equal-Budget Penalty)**: Multi-agent coordination adds serialization overhead. Do not spawn a crew for a single-file or `<30-line` surgical fix; execute trivial single-package tasks directly.
   - **When orchestrating a multi-package batch (`>=2` packages)**: The orchestrator (Head Honcho) acts as an **event-woken planner** (Anthropic Advisor / Devin Manager pattern). It writes `docs/orchestration-plan.md`, `docs/orchestration/tasks.json`, and compact briefs (`docs/orchestration/tasks/<id>.md`), and stays dormant while `src/daemon.js` supervises worker panes at zero LLM token cost. Do not write feature code, test suites, or refactors in the orchestrator pane (only `<15-line` merge-glue fixes during branch integration are permitted). This keeps orchestrator overhead under `20%` of batch tokens (`>80%` subagent spend) and keeps orchestrator context below `30%` (`30k to 50k` tokens, where multi-turn context rot accelerates).
1. **Require Herdr (`HERDR_ENV=1`)**: Always verify `test "${HERDR_ENV:-}" = 1` before calling `herdr`. Never run `opencode run` or headless background subshells; every worker must run interactively inside a visible Herdr pane so the human and board can watch and intervene.
2. **Never guess metrics or models**: Unreported fields stay `?`. Never pick worker models by intuition; run `roostr summary` and `roostr tasks` (or `roostr recommend`) so routing uses empirical pass rates from `~/.roostr/summary.json`.
3. **Warm-pane context hygiene (subagent reset protocol)**: Keep each worker's pane and `.worktrees/<name>` alive across tasks in a batch. Never start a new task in a dirty context. Before dispatching the next task brief, reset the agent's context with its native clear command (`herdr agent prompt <name> "/clear"` for Claude Code, `herdr agent prompt <name> "/new"` for OpenCode, or the CLI's native new-session command) and re-seed only the compact brief pointer. Trigger a full pane recycle (`herdr pane close` + fresh split) only on contamination signals (wrong-task edits, repeated tool loops, ignored stop hooks, or context `>= 75%` where compaction fails).
4. **Worktree asset boundary**: `git worktree add` does not copy gitignored files (`.env*`, `node_modules/`, build caches). Symlink or copy required gitignored assets into `.worktrees/<name>` during setup and run one smoke command before prompting the worker.
5. **No redundant `agent rename`**: `herdr agent start <name> --kind <kind> --pane <pane-id> -- <args>` already sets the lowercase `[a-z][a-z0-9_-]{0,31}` agent handle and waits up to 30s for readiness. Only call `herdr pane rename <pane-id> "<Display> · <task>"` to set the visible pane title.

## Phase 1: Pre-Planning Grill & Empirical Summary

1. **Verify Herdr & inspect board**:
   ```bash
   test "${HERDR_ENV:-}" = 1
   roostr --json --here   # or --all for every workspace
   ```
2. **Warm the empirical advisor**:
   ```bash
   roostr summary
   # If ~/.roostr/summary.json is missing or cold (<5 runs) and an external team ledger exists:
   roostr summary --from "${ROOSTR_LEDGER:-/path/to/team-ledger.jsonl}"
   ```
3. **Lock the plan**: Interview the user (via `grill-with-ui` when `[grill] mode = "recommended"`, or the 7-question pre-plan grill: Goal, Non-goals, Done check, Touched areas, Constraints, Parallelism, Verification) and write `docs/orchestration-plan.md`. Do not spawn workers until the human approves the plan.

## Phase 2: Machine Task List & Data-Driven Model Routing

1. **Write `docs/orchestration/tasks.json` and briefs (`docs/orchestration/tasks/<id>.md`)**:
   See [`references/schemas-and-config.md`](references/schemas-and-config.md) for the exact `tasks.json`, `.roostr.toml`, and brief/report schemas. Every task must declare its `id`, `title`, `kind` (`architecture`, `complex-impl`, `surgical-code`, `refactor`, `ui`, `docs`, `review`, `test-gen`, `research`), `brief`, `report`, `owns`, and `depends_on`.
2. **Validate & enrich with `roostr tasks`**:
   ```bash
   roostr tasks
   roostr tasks --json
   ```
   `roostr tasks` validates dependencies (rejecting cycles and duplicate file ownership), queries `advisor.recommend` per task against `~/.roostr/summary.json`, `.roostr.toml`, and `~/.roostr/config.json`, and prints the recommended `effort`, `tier`, `model`, `confidence`, and fallbacks.
3. **Human allocation sign-off**: Present the `roostr tasks` table (or open the board's `[O orchestrate]` TUI drawer with `O` / `T` to tweak tool, effort, or model overrides interactively) and get explicit approval before spawning.

## Phase 3: Naming, Worktrees & Exact `herdr` Spawning

1. **Draw human worker names once per batch**:
   ```bash
   roostr name --language es --count 3 --json
   ```
   Use the lowercase `agent` slug (`diego`) for `herdr agent start` and `.worktrees/diego`, and the capitalized `display` name (`Diego`) for the pane label.
2. **Create isolated git worktree**:
   ```bash
   git worktree add .worktrees/diego -b crew/diego
   ```
   Link any required gitignored files (`.env`, `node_modules`) into `.worktrees/diego`.
3. **Check geometry, split without stealing focus, and start the worker**:
   ```bash
   # 1. Check layout: split 'right' when wide (width >= height * 2), 'down' when tall
   herdr pane layout --pane "$HERDR_PANE_ID"
   # 2. Split pane in the worker's worktree without stealing focus
   PANE_ID=$(herdr pane split --current --direction right --cwd "$PWD/.worktrees/diego" --no-focus | jq -r '.result.pane.pane_id')
   # 3. Start agent with native model/effort args after --
   herdr agent start diego --kind opencode --pane "$PANE_ID" -- -m openrouter/xiaomi/mimo-v2-pro
   # 4. Set human-readable pane label
   herdr pane rename "$PANE_ID" "Diego · <short task>"
   ```
4. **Report metadata to the board & record the ledger spawn**:
   ```bash
   roostr report --pane "$PANE_ID" --role "worker" --about "<one-line scope>" --task "<short task>" --effort medium --model "xiaomi/mimo-v2-pro"
   RUN_ID=$(roostr spawn --pane "$PANE_ID" --task "<short task>" --kind surgical-code --effort medium --model "xiaomi/mimo-v2-pro" | awk '{print $1}')
   ```
5. **Dispatch the brief pointer (never paste giant specs into the prompt)**:
   ```bash
   herdr agent prompt diego "Read docs/orchestration/tasks/pkg-a.md and execute it. Write your report to docs/orchestration/reports/pkg-a.md ending with DIEGO_DONE or DIEGO_BLOCKED."
   ```
   Use `--wait --timeout 120000` only when blocking on a synchronous step; for parallel workers, dispatch without `--wait` and let supervision handle transitions.

## Phase 4: Supervision (Daemon, Secretary & Board TUI)

- **Event-Driven Daemon (Default, Zero LLM Tokens)**: `scripts/status-event.js` hooks Herdr's `pane.agent_status_changed` event and invokes `src/daemon.js`. On `idle`/`done`, it checks `docs/orchestration/reports/<id>.md` for `<NAME>_DONE` or `<NAME>_BLOCKED`. On `blocked`, it classifies the screen via `src/recover.js` (`herdr agent read <name> --source recent-unwrapped --lines 120`), auto-approves safe prompts when configured, or escalates up the `[daemon.ladder]`.
- **Board TUI Drawer (`[O orchestrate]`, key `O` or `T`)**:
  - **Tab 1 (Orchestrate & Tasks)**: Pick or spawn the **Orchestrator** (`o`), bind the **Active Plan & `tasks.json`** (`p`), start or poke the **Secretary Monitor** (`k` / `m`), and inspect or override every task's `tool`, `effort`, `model`, and `fallbacks` in-place.
  - **Tab 2 (Analytics & Summary)**: Interactive TUI for `roostr analytics` (`b` cycles `model ▸ pane ▸ kind ▸ batch`, `d` cycles `1d ▸ 7d ▸ 30d`, `s` refreshes `roostr summary`).
  - **Tab 3 (Setup)**: Configure enabled tools, tier models (`fast`, `balanced`, `reasoning`), and per-kind defaults.
  - Press `C` (or click a `◼ blocked` state cell) on the main board to allow or continue a stuck pane.

## Phase 5: Tiered Review, Outcome Recording & Warm Reuse

1. **Verify completed work package**:
   - Read `docs/orchestration/reports/<id>.md` and `git -C .worktrees/<name> diff --stat`.
   - **Tier 1 (Mechanical)**: Targeted grep, syntax check, and file-ownership check (`owns` in `tasks.json`).
   - **Tier 2 (Execution)**: Run package tests/build (`./verify.sh` or `npm test`).
   - **Tier 3 (Semantic)**: Check behavior against `docs/orchestration-plan.md` acceptance criteria.
2. **Record empirical outcome & refresh summary**:
   ```bash
   roostr outcome --run "$RUN_ID" --result pass --rework 0 --cost 0.04
   roostr summary
   roostr analytics --days 7 --by model
   ```
3. **Reuse warm pane for next task (subagent context reset)**:
   ```bash
   # 1. Clear previous task context inside the warm worker pane (/clear for Claude, /new for OpenCode)
   herdr agent prompt diego "/new"
   # 2. Update pane title, board task metadata, and ledger spawn for the new work package
   herdr pane rename "$PANE_ID" "Diego · <next short task>"
   roostr report --pane "$PANE_ID" --task "<next short task>"
   RUN_ID=$(roostr spawn --pane "$PANE_ID" --task "<next short task>" --kind surgical-code | awk '{print $1}')
   # 3. Dispatch the new brief pointer into the clean context
   herdr agent prompt diego "Read docs/orchestration/tasks/pkg-b.md and execute it. Write your report to docs/orchestration/reports/pkg-b.md ending with DIEGO_DONE or DIEGO_BLOCKED."
   ```
   When the entire batch is merged, remove worktrees (`git worktree remove .worktrees/<name>`) and close worker panes.
