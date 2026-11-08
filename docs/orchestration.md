# Run a crew

This guide describes a whole crew: one Head Honcho, one secretary, workers and optional reviewers. It works with any agent that can run shell commands. The board stays zero dependency and read only by default.

Examples use neutral names: a project called `example-app`, a worker called Diego, and a plan at `docs/orchestration-plan.md`. Worker names are random examples, not defaults.

## Runbook

1. Press `O` (or `T`) to open the `[O orchestrate]` hub. On the `3 setup` tab (or `S` shortcut), pick tools, tier models, role defaults and one row per task kind. Set a primary model and ordered fallbacks for each kind. Save.
2. In the `1 tasks · advisor` tab of `[O orchestrate]`, press `o` to pick an existing agent pane as Orchestrator and `g` to assign it `head-honcho` (or press `N` to spawn a new Head Honcho in a shell pane). Press `p` to bind the Active Plan repo.
3. The Head Honcho writes one brief per package and `docs/orchestration/tasks.json`. Run `roostr tasks` (or inspect and override tools, efforts, models and fallbacks live in the `1 tasks · advisor` tab) and fix every error.
4. Approve the plan and allocation table. No worker starts before approval.
5. The event-driven daemon (`src/daemon.js`) supervises workers with zero tokens, or press `k` (`K` on the board) to start/focus a Secretary pane.
6. Spawn a worker in an isolated worktree. Ask `roostr recommend "<task>" --kind <kind>`, split without stealing focus (`herdr pane split --current --direction right --cwd "$PWD/.worktrees/<name>" --no-focus`), start the agent (`herdr agent start <name> --kind <tool> --pane <id>`), and record the run (`roostr spawn --pane <id> --task "<task>" --kind <kind> --batch <batchId>`).
7. Workers write one report each and end with `<NAME>_DONE` or `<NAME>_BLOCKED`. They never commit.
8. Record one outcome per run with `roostr outcome`, then rebuild the advisor summary (`roostr summary` or `s` in `[O orchestrate]`) and review spend (`roostr analytics` or `2 analytics · summary` tab).
9. Press `m` (`M` on the board) for a monitor pass, or let the scheduled pass run every 15 minutes.
10. If a preferred model is disabled, pick a fallback. Never let the board substitute one silently.

## 1. Before you spawn

Press `S` in the board to pick coding tools, the crew language, preferred models and the settings for each task kind. The language row defaults to `en`, and `es`, `pt` and `fr` are supported. The setup writes `~/.crew-board/config.json` with mode `0600`. You can also set `CREW_BOARD_CONFIG` to another path.

Draw the worker names once, from the language you are using with the user, then keep them:

```sh
crew-board name --language es --count 3
```

The command prints lowercase names, one per line. A Spanish conversation draws Spanish names. An English conversation draws English names. Do not redraw a name on a tick or after a restart.

Check the recommendation before you choose effort:

```sh
crew-board recommend "add pagination to the orders endpoint"
```

Look at what is already live:

```sh
herdr workspace list
herdr agent list
```

Print the Head Honcho prompt, then send it after the agent starts:

```sh
crew-board template head-honcho --name la-jefa-example-app --plan docs/orchestration-plan.md
```

Do not invent numbers. The recommendation tier and effort come from the task kind and the ledger, or from the defaults.

## 2. The crew roles

- **Head Honcho**: the very expensive advisor. Owns the plan, names, work packages, acceptance tests, budgets, checks and hard decisions. Draws every worker name randomly from the language it uses with the user. Does not implement and does not run the routine loop. Template: `templates/agents/head-honcho.md`.
- **Secretary**: fast model. Always `Secretary - <workspace>` / `secretary-<workspace>`, with the stable role `secretary`. Runs the day to day loop: compares what each worker says it did with the plan, tells aligned workers to continue, records outcomes, and escalates only difficulty, stuck sessions and finished gates. Does not implement. Template: `templates/agents/secretary.md`.
- **Worker**: one work package in a fresh context. Has a randomly drawn human name, a stable role and a one line about. Reports effort and model. Never changes the plan, its role or its about. Does not grade itself. Template: `templates/agents/worker.md`.
- **Reviewer**: optional quality gate. Has a human name and the role `review-<package>`. Reviews against the plan and acceptance tests. Template: `templates/agents/reviewer.md`.

Every agent has four names in the data:

- `agentName`: the lowercase Herdr name, for example `diego`.
- `displayName`: the capitalized pane label, for example `Diego`.
- `role`: the stable core job, for example `board core and CLI`.
- `about`: one line describing what the agent does in this crew.

Set the role and about once, then set the current task as it changes. The board row shows `Diego · board core and CLI`. The detail box shows the role and about. Worker names come from the random pool. The board reads `~/.crew-board/names.json` and keeps recent names out of the next draw, so the same few names do not repeat every crew. The secretary is the fixed exception, `Secretary - <workspace>` / `secretary-<workspace>`.

The setup screen picks the tool, model and effort for each role. The crew file may override the secretary defaults for one project.

## 3. Context hygiene

- One work package per context.
- Clear or start a new session before the first tool call.
- Write a short handoff before clearing: package, files touched, current state, acceptance result, next step.
- Re-read the plan, the brief and the board after clearing.
- Two failed attempts means stop and escalate.
- Never paste transcripts, secrets, `.env` files, full logs or private paths.

The worker and reviewer templates carry these rules. The secretary template carries the escalation matrix.

## 4. Start Head Honcho with `O`

`O` opens a picker of shell panes in the current workspace. Pick one with `↑` `↓`, press `Enter`, then `y`. The board starts the configured head tool and model, renames the agent and pane, writes the task report and sends the template prompt. The default is `auto`: the board draws a boss title from the pool (`la-jefa`, `el-patron`, `il-capo`, `don`, `maharaja`, `shogun`, `pharaoh`, `sultan`, `cacique`, `tlatoani`) and appends the project, for example `la-jefa-example-app`.

The Head Honcho interviews you, writes `docs/orchestration-plan.md`, and waits for your approval. The grilling questions are in the template. A grilling or interview skill is optional.

If there is no shell pane, split one first:

```sh
herdr pane split <pane-id> --direction right --cwd "$PWD"
```

## 5. Spawn a worker

Ask the advisor before you choose effort, inspect layout, split without stealing focus, start the agent (which sets the Herdr agent name directly without a separate `herdr agent rename`), and record the attempt:

```sh
roostr recommend "<task>" --kind <kind>
herdr pane layout --pane "$HERDR_PANE_ID"
NEW_PANE=$(herdr pane split --current --direction right --cwd "$PWD/.worktrees/diego" --no-focus | awk '{print $NF}')
herdr agent start diego --kind <tool> --pane "$NEW_PANE"
herdr pane rename "$NEW_PANE" "Diego · <task>"
roostr report --pane "$NEW_PANE" --role "board core and CLI" --about "Owns the board core and command line" --task "<task>" --effort <effort> --model <model>
roostr spawn --pane "$NEW_PANE" --task "<task>" --role worker --kind <kind> --batch <batchId>
```

`crew-board spawn` prints a `runId`. Keep it: the outcome closes that attempt. A missing tier, effort or model is filled from the recommendation, and a flag wins over the recommendation. The command records the attempt in `~/.crew-board/orchestration.jsonl`. It does not start or prompt the agent.

The board assigns the colour tag. Do not type a tag into the label or the role. In the default `label` tag mode the board adds the emoji to the pane name, for example `🟦 Diego · board core`. The rest of the label is the display name.

## 6. Start a secretary

Press `K`. The board finds a free shell pane in the current workspace, starts the configured secretary tool and model, names it `Secretary - <workspace>` / `secretary-<workspace>`, sets the role `secretary`, writes the monitor task and sends the secretary template. If no shell pane exists, it splits one from the selected pane. If a secretary is already running, `K` focuses it.

The manual path is still available:

```sh
crew-board template secretary --name secretary-<workspace>
```

Start it with the Herdr name `secretary-<workspace>`, the display name `Secretary - <workspace>` and the role `secretary`, then give it the monitor task. The settings tab picks its tool, model and effort. The board finds the secretary by role first. The name is always the same so nobody has to guess who the secretary is.

Worker names use the shared history file, so a name used in a recent crew is less likely to come back immediately.

## 6b. Settings, task kinds and model fallbacks

Press `S`. The settings tab has four layers:

1. Tools and default tool.
2. Tier model map (`fast`, `balanced`, `reasoning`).
3. Role defaults for Head Honcho, secretary, worker and reviewer.
4. One row per task kind: `docs`, `review`, `tests`, `tooling`, `complex`, `feature`.

Each task kind row sets:

- the coding tool (`auto` follows the worker/default tool);
- the primary model (`auto` follows the tier map);
- an ordered fallback model list;
- the effort (`auto` follows the ledger and the archetype, otherwise pin it).

Controls: `↑↓` row, `←→` tool, `space` effort, `enter` primary model, `f` fallback list, `esc` cancel.

Precedence is:

1. per-run flag (`spawn --effort`, `--model`, `--kind`);
2. per-task override in `docs/orchestration/tasks.json`;
3. project override in `.crew-board.toml` under `[tasks.<kind>]`;
4. global task kind in the settings tab;
5. role default.

Example project override:

```toml
[tasks.docs]
tool = "opencode"
model = "docs-model"
fallbacks = ["docs-backup", "docs-backup-2"]
effort = "medium"
```

The board never substitutes a model silently. If the preferred model is disabled, the recommendation keeps the preferred name, returns the ordered fallbacks and requires a choice. Pick one fallback or update the settings.

### Effort decision table

This table is a prior from real runs. Use the advisor and the sample count. Override when the brief says the task is unusual.

| Task kind | Effort | Tier | Exception |
| --- | --- | --- | --- |
| `docs` | low to medium | fast to balanced | Architecture, release notes, research reviews: high |
| `review` | medium | balanced | Visual review: high plus a model that can judge frames |
| `tests` | medium | balanced | Release gate: high |
| `tooling` | low to medium | fast to balanced | Live deploy or infra: medium to high |
| `complex` | high | reasoning | None; medium is insufficient for engine state, camera and input work |
| `feature` | medium | balanced | Engine state, camera, input, physics: high |

Rule of thumb: effort follows hidden state, not file count. Use medium for an isolated diff with a test. Use high for engine state, visual proof, packaging, or a bug that survived one attempt. Use low for deterministic batch scripts and narrow docs.

The secretary reads board JSON, not pane screens, unless it needs an answer for a blocked worker. It records the outcome of every finished, failed or blocked attempt. The worker reports effort and model and writes the report. The worker does not grade itself.

## 7. Monitor pass

Press `M` for one pass. When auto monitor is on, the board also prompts the secretary every 15 minutes while it is idle. You can prompt by hand too:

```sh
herdr agent prompt <secretary-name> "Run one monitor pass now."
```

The secretary reads the Head Honcho workspace only by default. `scope = "all"` is opt in.

One pass means one board read, one task list comparison, a continue prompt for each aligned worker, the outcome records, then return. It does not wait. The secretary must not use `sleep`, `tail -f`, `watch` or any polling loop inside its session.

The secretary compares task lines and report claims to `docs/orchestration/tasks.json`, tells aligned workers to continue, sends status prompts when needed, records outcomes, and escalates only hard decisions, stuck sessions and finished gates. It refers to workers by display name and role. It never changes scope, assigns a work package, changes a role or about, commits or kills a pane. The automatic pass is skipped while the secretary is working or blocked.

### Wake budget

The Head Honcho is the very expensive advisor. Wake it only for plan approval, a scope change, a finished stage gate, two failed attempts, a stuck session, a fatal blocker, a conflict that needs judgment, or the final release decision. Never wake it to record an outcome, read a pane, run a build or smoke, or repeat a completion notice already recorded.

The secretary sends the Head Honcho one short message per stage gate: the marker, the report path, the outcome status and at most three lines of summary. It does not forward raw reports or logs. If two notifications carry the same marker, the first wins and the second is ignored.

When an attempt finishes, the secretary reads the report's last 30 lines and `git status --short`, then records exactly one outcome:

```sh
crew-board outcome --run <runId> --result pass|fail|blocked --rework <N> --cost <N> --note "<text>"
```

Use `--cost` only when the board or the report gives a real number. Use `--rework` for the number of extra attempts. Never invent either value. The outcome is refused for an unknown run id or a run that already has one.

## 8. Labels, roles and task lines

The pane label is the capitalized display name only, for example `Diego`. The board row adds the role: `Diego · board core and CLI`. Do not put the task in the label.

```sh
crew-board report --pane <pane-id> --role "board core and CLI" --about "Owns the board core and command line"
crew-board report --pane <pane-id> --task "<current task>"
```

`--role` and `--about` are stable for the life of the crew. `--task` is the current work and survives an agent plugin title update.

Tag modes:

```sh
crew-board --tags tokens|label|metadata|off
crew-board --tags-scope here|all
```

The default tag scope is `here`, so label and metadata marks only change in the board's home workspace. Use `all` only when you mean it.

Never rename panes you did not create.

## 9. Read the board

```sh
crew-board --json --all
```

The envelope has `schema`, `version`, `generatedAt`, `scope`, `workspace`, `summary` and `panes`.

Print blocked panes without jq:

```sh
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(0, "utf8"));
  const b = d.panes.filter((p) => p.status === "blocked");
  if (b.length) console.log(b.map((p) => `${p.paneId} ${p.name}: ${p.task || "?"}`).join("\n"));
' < <(crew-board --json --all)
```

Each pane has `agentName`, `displayName`, `role` and `about`, plus the usual fields. Each value is an object with `v` and `src`. `src` is `exact`, `screen`, `crew` or `unknown`. A bare `?` means unknown, never a guess.

For scripts that still expect the old array:

```sh
crew-board --json-rows --all
```

## 10. Triage a blocked agent

- Press `?` for help, `f` to jump to the pane, `y` to copy its pane id, `e` to edit its task line, `R` for backups.
- Press `C` on a blocked or long-idle pane. The board reads the visible screen. A safe allow or continue prompt needs a second `C`, then it sends Enter or a continue prompt. A screen that mentions push, delete, install, deploy, secrets, credentials or another destructive action is refused.
- Read context with `herdr pane read <pane-id>`.
- Update the task line with `crew-board report`.
- The secretary answers plan lookups and routing. The Head Honcho answers reasoning.
- Never close, interrupt or kill a worker automatically.

## 11. Budgets and checks

Set a budget in the crew file or on the command line:

```toml
[board]
budget = 20
daily_budget = 40

[[pane]]
name = "Diego"
budget = 2
```

```sh
crew-board --budget 5
```

A pane over its cap joins the banner. With tokscale installed, the footer shows today's total and the daily cap.

Checks are badges from the crew file:

```toml
[[check]]
name = "tests"
run = "npm test"

[[pane]]
name = "Valeria"
checks = ["GREEN: npm test"]
```

Press `a` to allow a new or changed crew file. The file is code.

Check limits:

```toml
[checks]
concurrency = 3
timeout_seconds = 2
```

The board displays only. It never stops an agent.

## 12. Attempts, effort and the ledger

One attempt is one `crew-board spawn` and one `crew-board outcome`. The spawn records what the run will use. The outcome records how it ended. The two share a `runId`.

The Head Honcho writes `docs/orchestration/tasks.json` next to the plan and briefs. Validate it before starting anyone:

```sh
crew-board tasks
crew-board tasks --json
```

The list is the machine readable version of the plan: id, title, kind, brief, report, owners, dependencies, status and optional effort, model and fallbacks. `crew-board tasks` prints the same recommendation the spawn will use.

```sh
crew-board recommend "<task>"
crew-board spawn --pane <pane-id> --task "<task>" --role worker --kind <kind>
crew-board outcome --run <runId> --result pass --rework 0 --cost 0.42 --note "tests green first try"
crew-board summary
```

Workers report their effort and model with `crew-board report --effort <effort> --model <model>`. `crew-board spawn` keeps the recommendation and the effort the run will use, so a run can show both. The outcome keeps `pass`, `fail` or `blocked`, the rework count, the cost and a short note. The secretary records outcomes. The worker does not grade itself.

A first try pass means an accepted run with no rework. In an imported team ledger, `accepted` counts as `pass`, `abandoned` counts as `fail`, and `partial` is not a first try pass. Any nonempty rework also makes the run not a first try pass. `rework` may be text such as `one retry`; text marks the attempt as reworked and is never parsed into a number. A missing or unparsable cost stays unknown, never `0`. Read the sample count and the kind before drawing a conclusion about a model.

The stores are local:

- `~/.crew-board/orchestration.jsonl` is the append only attempt ledger. It has mode `0600` and grows without bound, so rotate it by hand.
- `~/.crew-board/summary.json` is the aggregate. `crew-board summary` writes it unless you pass `--no-write`.
- `~/.crew-board/state/<pane>.json` is the per-pane exact report.

The next `recommend` reads the summary per kind. It never uses a global effort average. A model in `disabledModels` is never recommended.

`crew-board summary --from <path>` also reads an existing team ledger JSONL with `date`, `project`, `task`, `model`, `effort`, `kind`, `outcome`, `rework`, `cost_usd` and `notes`. Both schemas normalize into one row. A missing path is an error and a malformed line is skipped with a warning.

The ledger stores no prompts, transcripts, pane screens or secrets.

### Two attempts

```sh
crew-board spawn --pane w1:p2 --task "add pagination to the orders endpoint" --effort medium --model balanced-model
# run 815bb0ad-dcd2-464c-8e02-3b00956f080f
crew-board outcome --run 815bb0ad-dcd2-464c-8e02-3b00956f080f --result fail --rework 1 --cost 0.30 --note "tests red, second attempt needed"

crew-board spawn --pane w1:p3 --task "add pagination to the orders endpoint" --effort medium --model balanced-model
# run eb7e89c5-25c7-465f-9fec-d68210fe3a1a
crew-board outcome --run eb7e89c5-25c7-465f-9fec-d68210fe3a1a --result pass --cost 0.42 --note "tests green first try"

crew-board summary
```

The resulting row for the `feature` kind in `~/.crew-board/summary.json`:

```text
count 2 · first try 50% · avg cost $0.36 · avg rework 0.5
```

Four ledger lines result: two spawn entries and two outcome entries. The first attempt needed a rework, so only one of the two finished runs passed first try.

The full entry schema, the summary aggregates and the advisor rules are in [the reference](reference.md#ledger-attempts-and-summary).

## 13. Backups and restore

Press `R` in the board, or use the backup commands:

```sh
crew-board backups
crew-board backups show <label>
crew-board backups restore <label> --layout even
crew-board backups restore <label> --layout saved --yes
```

A restore builds a new workspace named `<label> *restored`. The old workspace is never touched. Confirm before any restore that starts agents.

`--layout` picks the shape of the new workspace:

- `even` (default) balances the panes into a grid, so every pane gets about the same area.
- `saved` rebuilds the split tree recorded in the backup, including its original ratios.
- `columns` puts every pane in one row.
- `rows` stacks every pane in one column.

In the board's backups view, `p` cycles the layout before `r` then `y`.

Before starting an agent, a restore asks the agent's own session store for the saved pane when the backup holds no usable id. For opencode it matches the working directory and the saved task or name against the session titles. A weak match is skipped, so a pane opens blank rather than resuming an unrelated conversation.

## 14. End of a crew

- Read the final board JSON.
- Record outcomes with `crew-board outcome`.
- Run `crew-board summary`.
- Check the backups.
- Close only panes you created.
- Keep the plan, briefs and reports as the record of the run.

## Prompt delivery

How a prompt reaches an agent depends on the agent and the Herdr version.

1. Try `herdr agent prompt <pane> "Read and do <path>"` first for every agent.
2. If the status stays `idle`, use `herdr pane send-text <pane> "Read and do <path>"` and then `herdr agent send-keys <pane> Return`.
3. Confirm the status turns `working` and the input box is empty.
4. One retry only. If it still stays idle, ask the human to paste the line by hand.

On the tested OpenCode version, `send-text` plus `send-keys` left the input empty, while `herdr agent prompt` worked. Do not claim that one delivery method works for every agent.

Do not send `/model` to a Claude worker. Start the worker with the model flag or the setup config instead.

## Briefs and reports

The Head Honcho writes one brief per work package at `docs/orchestration/tasks/<package>.md`.

A brief states:

- the user's request in their own words;
- decisions already made;
- the files the worker owns and the files it must not touch;
- the exact verification command;
- the report path;
- the instruction not to commit.

The worker reads only its brief and the relevant plan sections. It writes `docs/orchestration/reports/<package>.md` and ends the report with `<NAME>_DONE` or `<NAME>_BLOCKED`.

The reviewer writes `docs/orchestration/reports/review-<package>.md` with the same done markers.

Read the last 30 lines of a report, not the whole file, unless a line needs evidence. Workers and reviewers never commit. The Head Honcho or the human decides commits.

The secretary writes the monitor log in `docs/orchestration-log.md` and records outcomes in `~/.crew-board/orchestration.jsonl` with `crew-board outcome`.
