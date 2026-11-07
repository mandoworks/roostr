---
name: roostr
description: Use when planning, spawning, supervising, or reviewing worker agents in Herdr panes, running the Head Honcho and daemon secretary workflow, or checking agent status, costs, and blocked states via the JSON board.
---

# roostr

The Roostr board provides full observability and orchestration over agent panes in Herdr. It tracks each pane with its color tag, name, model, state, metrics, and active task line. Nothing is guessed: agents report their own status via `roostr report`, and uninspected panes display `?`.

## Orchestration Architecture

The orchestration architecture separates planning, mechanical supervision, and execution:

1. **Head Honcho (Planner)**: One lead reasoning agent owns architecture, scoping, decomposition, and review.
2. **Daemon Secretary (Supervisor)**: A deterministic background daemon (`src/daemon.js`, triggered by `scripts/status-event.js`) bound to Herdr socket events. It requires zero LLM tokens and no dedicated LLM pane. It dispatches approved plans, checks circuit breakers, sends structural nudges, records metrics, and wakes the lead only when human escalation is required.
3. **Workers (Executors)**: Autonomous workers (running Kilo, OpenCode, or agy) executing single, self-contained work packages inside isolated git worktrees.

## Phase 0: Pre-Plan Grilling Interview

Before writing any implementation plan or code, run the 7-question interview:

1. The problem, in one sentence.
2. What done looks like and how we check it.
3. Scope: in, and explicitly out.
4. File boundaries: allowed and forbidden paths.
5. Verification command: exact command and exit criteria.
6. Budget or token ceiling.
7. Failure recovery: policy on failure and escalation paths.

The interview generates `docs/orchestration-plan.md` with explicit human approval. Execution remains locked until the plan is approved.

## Phase 1: Crew Setup

Start the Head Honcho prompt from the canonical template:

```sh
roostr template head-honcho --name my-project --plan docs/orchestration-plan.md
```

Configuration lives in `.roostr.toml`:

```toml
[roles.head-honcho]
name = "Jefa"
model = "deepseek-v4.1-flash-1017"
effort = "high"

[roles.secretary]
mode = "daemon"

[limits]
max_concurrent_workers = 3
wakes_per_day = 12

[analytics]
rotation_days = 30
```

Inspect available CLI options at any time:

```sh
roostr --help
```

## Phase 2: Risk Tiering and Negotiation Protocol

Every work package receives an explicit risk tier:

- **Tier 1 (Trivial / Boilerplate)**: Fast models, minimal review.
- **Tier 2 (Standard Feature / Bugfix)**: Balanced models, standard verification.
- **Tier 3 (Architecture / Security / Core Logic)**: High reasoning models, dual review.

Consult empirical history before choosing effort:

```sh
roostr recommend "<task>"
```

The recommendation engine reads historical pass rates and rework counts from `~/.roostr/summary.json`. It never uses ungrounded guesses.

### Interactive Model and Effort Review Protocol

When presenting recommendations to the human, the Head Honcho must present the full allocation table and explicitly prompt:

> "Review the proposed tools, models, and efforts. Reply with 'Approve' to proceed as proposed, or specify your overrides (for example: 'Set WP-2 to Claude Sonnet, high effort'). Do not dispatch until overrides are applied or confirmed."

Never assume recommendations are immutable or treat a table presentation as an implicit dispatch mandate.

## Phase 3: Autonomous Spawning and Worktree Isolation

### Autonomous Execution Mandate

The Head Honcho or Daemon executes all Herdr spawning commands (`herdr pane split`, `herdr agent start`, `herdr agent rename`, `herdr pane rename`, `roostr spawn`, `herdr agent prompt`) directly through tool calls.

Never output shell snippets (such as `opencode run`) for the human to copy-paste. Never invoke `opencode run` headless in a terminal: headless runs lack interactive permission handling and auto-reject on security boundaries.

```sh
herdr pane split <pane-id> --direction right --cwd "$PWD/.worktrees/<name>"
herdr agent start diego --kind opencode --pane <new-pane-id>
herdr agent rename <new-pane-id> diego
herdr pane rename <new-pane-id> "Diego"
roostr report --pane <new-pane-id> --task "<task>" --effort medium --model deepseek-v4.1-flash-1017
roostr spawn --pane <new-pane-id> --task "<task>" --role worker
```

### Worktree Filesystem and Asset Boundaries

1. **Prerequisite verification**: The planner must verify that all required input files, raw media, and datasets exist on disk before drafting worker briefs.
2. **Git worktrees only check out tracked files**: Gitignored caches, `.env` files, or raw media directories do not exist in new worktrees automatically. If a task requires local media or cache directories, the planner must stage or symlink them into `.worktrees/<worker>/...` before dispatch.
3. **Hermetic boundaries**: Workers must only read and write within their assigned worktree. Never instruct a worker to inspect or `cd` into sibling worktrees or the parent repo, which triggers OpenCode `external_directory` security rejections.
4. **Inter-worker dependencies**: If Task B depends on Task A's output, Task A must finish and commit its artifact, or the planner must explicitly stage the artifact into Task B's worktree before launching Task B.
5. **Brief delivery**: Write structured instructions to `.scratch-<name>-task.md` on disk, and send a single pointer prompt: `herdr agent prompt <name> "Read .scratch-<name>-task.md and execute it."`. Keep one work package per fresh context.

## Phase 4: Deterministic Daemon Supervision

The background daemon secretary monitors pane lifecycle events automatically:

- **Circuit breakers**: Pauses dispatches if remaining pool falls below 15 percent; throttles to one worker if 1-hour burn reaches 80 percent.
- **Structural nudges**: Automatically prompts panes if output stalls or repeated command errors occur.
- **Operator hold**: Capped at 12 planner wakes per day. Non-critical excess alerts are held in `~/.roostr/operator-hold.json`.
- **Live worker updates**: Workers update their own single-line task description during execution:

```sh
roostr report --pane "$HERDR_PANE_ID" --task "writing unit tests for auth module"
```

## Phase 5: Artifact-Pointer Review Protocol

When a worker completes its package:
1. The worker writes its report to `.scratch-<name>-report.md` on disk including exit codes and diff summaries.
2. The worker never dumps raw transcripts into the prompt.
3. The lead or reviewer audits the diff, verifies test outputs, and commits. Workers never commit directly.

## Phase 6: Outcomes and Analytics

Record the execution outcome in the attempt ledger:

```sh
roostr outcome --run <runId> --result pass --rework 0 --cost 0.12 --note "Clean pass"
```

Update historical summary data before the next planning cycle:

```sh
roostr summary
```

Query performance and cost views across models, panes, kinds, and timelines:

```sh
bin/roostr analytics --by model
bin/roostr analytics --by pane
bin/roostr analytics --by kind
bin/roostr analytics --by timeline
```

## Inspecting Board State via JSON

Always prefer JSON output over screen scraping for exact, token-efficient state reads:

```sh
roostr --json --all
```

The returned envelope includes version, scope, summary, and pane objects (`paneId`, `name`, `status`, `task`, `tokens`, `cost`, `model`).

To check for blocked panes cleanly with Node:

```sh
node -e '
  const fs = require("fs");
  const data = JSON.parse(fs.readFileSync(0, "utf8"));
  const blocked = data.panes.filter((p) => p.status === "blocked");
  if (blocked.length) console.log(blocked.map((p) => `${p.paneId} ${p.name}: ${p.task || "?"}`).join("\n"));
' < <(roostr --json --all)
```

## Operational Rules

- Report only for panes you created or own.
- Keep task descriptions strictly to one line.
- Never write secrets, keys, or tokens to task lines or reports.
- Workers never push or commit without lead authorization.
- Zero external npm dependencies: all tools use pure Node builtins.
