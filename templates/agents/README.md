# Role templates

These templates make a crew work with any agent that can run shell commands: Claude Code, OpenCode, Kilo, agy, Codex or anything else Herdr starts. They are plain Markdown.

## Use

```sh
crew-board template <role> [--name <name>] [--plan <path>] [--package <text>]
```

Roles: `head-honcho`, `worker`, `reviewer`.

Set the placeholders before you send the prompt:

- `{{ROLE}}` is the role name.
- `{{NAME}}` is the lowercase Herdr agent name, not the pane label.
- `{{PLAN}}` is the plan file, default `docs/orchestration-plan.md`.
- `{{PACKAGE}}` is the work package, default `(unassigned)`.

A missing value keeps the template default. The command reads a fixed file inside the plugin root and never accepts a path from a caller.

## Human names

Worker names are randomly generated from the language the Head Honcho is using with the user. A Spanish speaking head draws Spanish names. An English head draws English names.

The head draws the names once, before the workers start:

```sh
crew-board name --language es --count 3
```

The command prints lowercase names, one per line. The head then names each worker with `herdr agent rename` and `herdr pane rename`. It does not draw again on a tick.

- Herdr agent name: lowercase, for example `diego`, `valeria`.
- Pane label: the capitalized display name only, for example `Diego`, `Valeria`.
- Board row: the display name and the role, for example `Diego · board core and CLI`.
- Do not reuse a name in the same crew. The pool appends `-2`, `-3` when it is exhausted.
- A worker with no name yet keeps its pane id. Do not invent a name.

The setup screen has a `language` row. The default is `en`. `es`, `pt` and `fr` are supported. The head may override it with `--language`.

The deterministic daemon (`src/daemon.js`) watches lifecycle events, nudges, recycles and escalates with zero LLM tokens. No extra agent pane is needed.

The Head Honcho sets the name on the agent and the pane, then reports the stable role and the one line about. The worker updates only its current task.

The head name is `<boss-title>-<project>`. The setup default is `auto`, which draws a boss title from `la-jefa`, `el-patron`, `il-capo`, `don`, `maharaja`, `shogun`, `pharaoh`, `sultan`, `cacique` and `tlatoani`. Recent titles are kept in the name history so a crew does not come back as the same boss every time.

## Role, about and task

- Role: the stable core job, 1 to 32 characters, for example `board core and CLI`, `camera and UX`, `docs and release`. Reviews use `review-<package>`.
- About: one line, 1 to 120 characters, describing what the agent does in this crew.
- Task: what the agent is doing now. It changes with the work.

The role and about do not change when the task changes. Work packages are work. Workers are people, never packages.

## Model tiers

The setup screen also chooses a language and a model for each tier:

- `fast` for docs, rote edits and monitoring.
- `balanced` for normal features, tests and tooling.
- `reasoning` for architecture, security and hard debugging.

The Head Honcho starts at the cheap tier and moves up only for core work or after two failed attempts with evidence.

## Attempts and outcomes

One attempt is one `crew-board spawn` and one `crew-board outcome`.

- Before the spawn, the Head Honcho runs `crew-board recommend "<task>"` and uses its tier and effort unless the plan overrides them.
- The Head Honcho records the attempt with `crew-board spawn --pane <id> --task "<task>" --role worker` and keeps the printed run id.
- The spawn writes `~/.crew-board/orchestration.jsonl`. It keeps the recommendation and the effort the run will use. It does not start an agent.
- The Head Honcho or the human records `pass`, `fail` or `blocked` with `crew-board outcome --run <runId>`, plus a real rework count and cost when known.
- A first try pass is an accepted run with no rework. An imported `accepted` counts as `pass`, `abandoned` as `fail`, and partial or reworked runs are not first try passes. Rework may be text, so do not invent a number.
- The worker reports effort and model and writes the report. It does not grade itself.
- `crew-board summary` writes `~/.crew-board/summary.json`, and the next recommendation reads it per kind.
- The ledger stores no prompts, transcripts, pane screens or secrets.

The full entry schema and the summary aggregates are in [docs/reference.md](../../docs/reference.md#ledger-attempts-and-summary).

## Context hygiene

- One work package per context.
- Write a short handoff before clearing.
- Re-read the plan, the brief and the board after clearing.
- Two failed attempts means stop and escalate.
- Never paste secrets, .env files, full logs or private paths.

## Escalation

The daemon handles routine status, drift, location, budget and check signals without tokens. It escalates ambiguity, architecture tradeoffs, plan changes, two failed attempts, cross-worker conflicts and any security exposure to the Head Honcho. A security exposure also goes to the human.

## Protocol

- The Head Honcho writes the plan and one brief per work package.
- The worker writes one report with a `<NAME>_DONE` or `<NAME>_BLOCKED` marker.
- The reviewer writes `review-<package>.md`.
- Workers and reviewers never commit. The Head Honcho or the human decides commits.
- The plan is the source of truth for scope. The board JSON is the source of truth for live status.
