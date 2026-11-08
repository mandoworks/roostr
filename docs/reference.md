# roostr reference

Deep reference for the board. The [README](../README.md) is the quick start.

`roostr` is the primary command. `crew-board` remains supported as a legacy alias.

## Exact usage: `roostr report`

```sh
roostr report --pane <id> [--ctx N] [--tokens N] [--input N] [--output N] [--cost N] [--model S] [--effort E] [--role S] [--about S] [--task T] [--session ID] [--from claude|agy]
```

`crew-board report` remains supported as a legacy alias.

Writes `~/.roostr/state/<pane>.json`, named for the pane id with `:` replaced by `_`, and an existing `_` escaped as `__`, so `w1:p2` is `w1_p2.json`. If `~/.roostr/state` is not present, roostr falls back to `~/.crew-board/state` for compatibility. Set `ROOSTR_STATE_DIR` (or `CREW_BOARD_STATE_DIR`) to move the state directory. The file is `0600` and written atomically. It keeps the latest report for that pane: `pane`, `at`, `ctx`, `tokens`, `input`, `output`, `cost`, `model`, `effort`, `task`, `taskSource`, `role`, `about`, `session` and any usage limits. A flag with an empty value is ignored, so a missing field never erases an earlier one. Reports older than 12 hours are ignored and dead pane reports are pruned.

`--effort` takes `low medium high xhigh max`, or the short forms `L M H XH MAX`, in any case. `--input` and `--output` carry the split that Gemini estimates need.

`--role` is the stable core job, 1 to 32 characters, for example `board core and CLI`. `--about` is one line, 1 to 120 characters, describing what the agent does in this crew. `--task` is the current work. Missing values are `null`, never a guess.

### Names and roles

Every agent has four values:

- `agentName`: the lowercase Herdr agent name, for example `diego`.
- `displayName`: the capitalized pane label, for example `Diego`.
- `role`: the stable core job, for example `board core and CLI`.
- `about`: one line describing what the agent does in this crew.

The pane label is the display name only. The board row shows the display name and the role, for example `Diego · board core and CLI`. The detail box adds the role and about. The task stays separate and changes with the work.

Worker names are randomly generated from the language the Head Honcho is using with the user. The head draws them once with `roostr name --language <code> --count N --exclude <names>` (or `crew-board name` as a legacy alias) and keeps them. A Spanish conversation draws Spanish names. An English conversation draws English names. The setup language row defaults to `en`, and `es`, `pt` and `fr` are supported.

The secretary is the fixed exception: display name `Secretary - <workspace>`, Herdr name `secretary-<workspace>`, role `secretary`. The board finds the secretary by role first. Press `K` in the board to create one; it picks a shell pane or splits one. Worker names use `~/.roostr/names.json` (override with `ROOSTR_NAMES` or `CREW_BOARD_NAMES`, with fallback to `~/.crew-board/names.json`) so recent names do not repeat.

### Claude Code statusline snippet

Add this block to your statusline script after it reads the input (`input=$(cat)`). It needs `roostr` on `PATH` (`crew-board` remains supported as a legacy alias), runs only inside a Herdr pane, and prints nothing:

```sh
# ---- roostr: paste this block into your own statusline script ----
if [ -n "${HERDR_PANE_ID:-}" ]; then
  if command -v roostr >/dev/null 2>&1; then
    printf '%s' "$input" | roostr report --pane "$HERDR_PANE_ID" --from claude >/dev/null 2>&1 &
  elif command -v crew-board >/dev/null 2>&1; then
    printf '%s' "$input" | crew-board report --pane "$HERDR_PANE_ID" --from claude >/dev/null 2>&1 &
  fi
fi
# ---- end of roostr block ----
```

A complete minimal script is in [examples/claude-statusline.sh](../examples/claude-statusline.sh). Point Claude Code at it:

```json
"statusLine": { "type": "command", "command": "sh /path/to/roostr/examples/claude-statusline.sh" }
```

### Antigravity (agy) statusline

agy hands its statusline JSON on stdin too: the model with its effort, context tokens, and its quotas. Use `--from agy`, or [examples/agy-statusline.sh](../examples/agy-statusline.sh):

```json
"statusLine": { "type": "command", "command": "sh /path/to/roostr/examples/agy-statusline.sh" }
```

agy gives no session title, so its task line comes from the pane label or `roostr report --task` (`crew-board report --task` remains supported).

### Gemini API estimates

agy reports tokens but no dollar cost, so the board estimates the API equivalent for Gemini panes from the input and output counts, at published paid tier rates. An estimate carries a tilde, for example `~$0.11`. An exact `--cost` always wins, and a pane without both counts shows `?` rather than a partial number.

Default rates are built in for Gemini 3.8 Flash and Gemini 4 Argon. Override them in `~/.roostr/prices.json` (or `$ROOSTR_PRICES`, with fallback to `~/.crew-board/prices.json` / `$CREW_BOARD_PRICES`), keyed by model name:

```json
{ "gemini-3.8-flash": { "input": 0.75, "output": 3.75 } }
```

A key matches after lowercasing and dropping spaces, hyphens and underscores. An override merges field by field.

### opencode and kilo plugin

[integrations/opencode/crew-board.mjs](../integrations/opencode/crew-board.mjs) reports the session title as the task line, plus the model, tokens, cost and session id, at most every 2 seconds and only inside a Herdr pane. It does not report context or effort: context still comes from the footer adapter and effort stays `?`. It needs `roostr` on `PATH` (`crew-board` remains supported), or `ROOSTR_BIN` / `CREW_BOARD_BIN=/path/to/bin/roostr`.

```jsonc
// ~/.config/opencode/opencode.json
"plugin": ["/path/to/roostr/integrations/opencode/crew-board.mjs"]
// ~/.config/kilo/kilo.jsonc
"plugin": ["file:///path/to/roostr/integrations/opencode/crew-board.mjs"]
```

A manual `roostr report --task` (`crew-board report --task` remains supported) is never overwritten by the plugin's session title.

## Screen adapters

Without a report the board reads an agent's own footer:

- **claude**: the Claude Code statusline footer.
- **opencode** and **kilo**: the `136.7K (14%)` footer.
- **agy**: the banner and the last lines only, for the model and effort. Never the whole screen.
- **codex**: no statusline. Limits come from the last `rate_limits` entry near the end of the newest session file, and at most 64 KiB of that file is read.

Unknown values stay `?`.

## Usage limits

The board shows usage limits above its footer for one provider at a time, one line per source, a bar per window, green, then amber from 60%, then red from 85%, with the reset time. Press `p` to cycle providers (claude, agy, codex, explabs) and off. Press `P` to cycle sub-views inside a provider. The board remembers both choices.

- **claude**: the rolling 5 hour and weekly windows, from the Claude statusline.
- **agy**: each quota family agy reports, from the agy statusline.
- **codex**: the ChatGPT plan's 5 hour and weekly windows, read once a minute from the newest session file.
- **explabs**: the tier and rate limits of an Experiential Labs key, off until you opt in.

Limits belong to the account, so every pane of one kind reports the same numbers. The newest report wins, and a window drops off once it resets.

**Burn rate and pace.** When a window would fill before it resets, its bar warns, for example `⚡ 2.4× ⚠ out in ~1h12`. The pace is measured from your own usage against the steady pace that lasts to the reset. History lives in `~/.roostr/state/burn.json` (with fallback to `~/.crew-board/state/burn.json`).

## Spend today with tokscale

If [tokscale](https://github.com/junhoyeo/tokscale) by Junho Yeo is on your `PATH`, the footer shows what every agent on the machine spent today. A live board runs it in the background at low priority, at most every 5 minutes. `--once` and `--json` never start it. Press `d` for the today view: spend and tokens per agent and per model, an hour chart, and a projection to midnight. A daily budget can watch the total. Without tokscale nothing changes.

## The crew file

`roostr` finds `.roostr.toml` (or `.crew-board.toml`) above each pane's cwd. The file is code: it runs commands, so the board ignores it until you allow its content hash.

```toml
[board]
name = "example-app"        # shown in the board header
budget = 20                  # default per pane budget
daily_budget = 40            # today's total, needs tokscale
tags = "tokens"              # tokens | label | metadata | off
tag_scope = "here"           # here | all, label and metadata mutations

[checks]
concurrency = 3              # 1..8
timeout_seconds = 2          # 1..10

[secretary]
auto = true                  # overrides the global setup for this project
interval_seconds = 900       # 60..3600
scope = "workspace"          # workspace | all

[providers.explabs]
enabled = false              # opt in with the env key or cookie

[[check]]                    # crew wide badges
name = "tests"
run = "npm test"

[[pane]]                     # per pane extras, matched by the display name in the pane label
name = "Diego"
model = "sonnet"
report = "agents/docs/report.md"
budget = 2
checks = ["GREEN: npm test"]
```

Check strings are `"LABEL: command"`. Command strings are split into an argv array and run with `execFile`, never through a shell, so quotes work and pipes or `$VARS` stay literal. Each run has a timeout and no check restarts faster than every 5 seconds.

## Colour tags

The board assigns a tag per pane and keeps it for the pane's life. A row shows the display name and the role, for example `Diego · board core and CLI`. The palette is 18 high contrast marks: `🟦 🟩 🟨 🟪 🟧 🟥 🔵 🟢 🟡 🟣 🟠 🔴 🔷 🔶 🔸 🔹 🔺 🔻`. Black, white and brown marks from older versions are stripped but never assigned, so an old label still parses and the next edit migrates the pane.

Modes: `--tags tokens|label|metadata|off`, or `[board] tags`. The default is `label`, so the pane name carries the matching emoji.

Example sidebar rows that show the agent name first and the model plus workspace underneath:

```toml
[ui.sidebar.agents]
rows = [
  ["state_icon", "$tag", "$name"],
  ["$model", { token = "workspace", dim = true }],
  [{ token = "$task", dim = true }],
  ["$ctx", "$cost", "$ram"],
]
```

- **label** (default): prefixes the pane label with the mark and re-adds it after a rename. Sidebar tokens are also published.
- **tokens**: publishes `$tag`, `$name`, `$task`, `$model`, `$ctx`, `$cost`, `$ram` to Herdr's sidebar. An existing emoji in the label is kept; an untagged pane is left alone.
- **metadata**: sets Herdr's display only agent text. An existing emoji in the label is kept. Sidebar tokens are also published.
- **off**: no label or display changes. It clears the sidebar tokens.

`--tags-scope here|all` limits label and metadata changes to the board's home workspace. The default is `here`.

## Command line

```sh
roostr --help
roostr [board options]
roostr report --pane <id> [--ctx N] [--tokens N] [--cost N] [--model S] [--effort E] [--role S] [--about S] [--task T]
roostr recommend "<task>" [--kind <kind>] [--effort <eff>] [--model <mod>] [--json]
roostr spawn --pane <id> --task "<task>" [--role worker] [--kind <kind>] [--tier fast|balanced|reasoning] [--effort low|medium|high] [--model <name>] [--crew <file>]
roostr tasks [--file <path>] [--crew <file>] [--json]
roostr outcome --run <runId> --result pass|fail|blocked [--rework N] [--cost N] [--note "<text>"]
roostr summary [--json] [--days 30] [--from <path>] [--no-write]
roostr template <head-honcho|secretary|worker|reviewer> [--name <name>] [--plan <path>] [--package <text>]
roostr name --language <code> [--count N] [--exclude <names>]
roostr sessions [--json]
roostr restore [--workspace <id|label|here|all>] [--yes] [--dry-run]
roostr backups [show|restore <label|id>] [--version N] [--yes]
```

`crew-board` remains supported as a legacy alias for these commands.

Board options:

- `--workspace <id|label>`, `--here`, `--all`.
- `--crew <file>`.
- `--tags tokens|label|metadata|off`, `--tags-scope here|all`.
- `--budget <dollars>`.
- `--view auto|line|wrap`.
- `--provider <name|off>`, `--subview <name|all>`.
- `--interval <seconds>`, `--once`, `--backups`.
- `--json`, `--json-rows`.
- `--no-update-check`.
- `-v, --version`, `-h, --help`.

## JSON

`--json` prints an envelope:

```json
{
  "schema": 1,
  "version": "0.2.0",
  "generatedAt": "2026-11-03T16:30:00.000Z",
  "scope": "all",
  "workspace": null,
  "summary": { "total": 4, "working": 2, "idle": 1, "blocked": 1, "done": 0, "unknown": 0, "totalCost": 4.2 },
  "panes": []
}
```

Every pane keeps `paneId`, `name`, `agentName`, `displayName`, `role`, `about`, `status`, `statusFor`, `task`, `effort`, `advisory`, `ctx`, `tokens`, `cost`, `model` and `budget`. Each value is `{ "v": value, "src": "exact|screen|crew|unknown" }`. `totalCost` is `null` when no cost is known, never `0`.

`--json-rows` prints only the panes array, byte compatible with the older shape. When both flags appear, the later one wins. `--json` never writes tags, tokens or memory.

## Setup config

`~/.roostr/config.json` as primary (override with `ROOSTR_CONFIG`), with fallback to `~/.crew-board/config.json` / `CREW_BOARD_CONFIG`, mode `0600`:

```json
{
  "version": 1,
  "tools": ["claude", "opencode"],
  "customTools": [],
  "defaultTool": "claude",
  "headName": "auto",
  "headLanguage": "en",
  "models": { "fast": "fast-model", "balanced": "balanced-model", "reasoning": "reasoning-model" },
  "disabledModels": [],
  "taskKinds": {
    "docs": { "tool": "", "model": "", "fallbacks": [], "effort": "" },
    "review": { "tool": "", "model": "", "fallbacks": [], "effort": "" },
    "tests": { "tool": "", "model": "", "fallbacks": [], "effort": "" },
    "tooling": { "tool": "", "model": "", "fallbacks": [], "effort": "" },
    "complex": { "tool": "", "model": "", "fallbacks": [], "effort": "" },
    "feature": { "tool": "", "model": "", "fallbacks": [], "effort": "" }
  },
  "roles": {
    "head-honcho": { "tool": "claude", "model": "reasoning-model", "effort": "high", "args": [] },
    "secretary": { "tool": "opencode", "model": "fast-model", "effort": "low", "args": [] },
    "worker": { "tool": "claude", "model": "balanced-model", "effort": "medium", "args": [] },
    "reviewer": { "tool": "claude", "model": "balanced-model", "effort": "medium", "args": [] }
  },
  "secretary": { "auto": true, "intervalSeconds": 900, "scope": "workspace" },
  "grillSkill": { "mode": "recommended", "command": "" }
}
```

The setup screen writes it. `headLanguage` defaults to `en` and accepts `en`, `es`, `pt` and `fr`. `roostr recommend` (or `crew-board recommend`) reads `models` as the tier map unless `ROOSTR_MODELS` or `CREW_BOARD_MODELS` is set. A model in `disabledModels` is never recommended. A task kind may pin `tool`, `model`, `fallbacks` and `effort`; an empty value means auto. The board never silently substitutes a disabled preferred model: it returns the ordered fallbacks and asks for a choice. The secretary is always `Secretary - <workspace>` / `secretary-<workspace>` with the role `secretary`.

The OpenCode TUI on the tested version rejects `--variant`. The role `args` are the escape hatch, and the board never passes `--variant` to OpenCode. The effort is recorded in the report, not claimed as an internal variant.

## Backups

On each refresh the board saves a backup of every workspace that has an agent, in `~/.roostr/backups/<workspace id>/` (with fallback to `~/.crew-board/backups`). A backup holds every tab, each tab's split tree, every pane's directory and label, and for agent panes the kind, name, task, effort, exact model and session id. A layout, directory, agent kind or session change makes a new version, and the last 4 are kept.

Press `R` to review them. `↑` `↓` pick a workspace, `←` `→` a version, `r` then `y` rebuilds it as a new workspace named `<label> *restored`. The old workspace is never touched. A restore needs explicit confirmation before it starts any agent.

## Ledger, attempts and summary

The feedback loop has three stores: the per-pane report, the durable attempt ledger and the aggregate summary. All three are local. None stores prompts, transcripts, pane screens or secrets.

### The attempt ledger

`roostr spawn` (or `crew-board spawn`) writes one attempt to `~/.roostr/orchestration.jsonl` (override with `ROOSTR_LEDGER` or `CREW_BOARD_LEDGER`, with fallback to `~/.crew-board/orchestration.jsonl`). The parent directory is `0700`, the file is `0600`, and every line is one JSON object. The file is append only: an attempt is never rewritten. The store is bounded by automatic rotation when exceeding 5 MB or the retention days setting.

```sh
roostr spawn --pane <id> --task "<task>" [--role worker] [--name <name>] [--kind <kind>] [--tier fast|balanced|reasoning] [--effort low|medium|high] [--model <name>] [--crew <file>]
```

`spawn` calls `roostr recommend` on the task and fills a missing `tier`, `effort` and `model` from the recommendation. It prints the `runId`, tier, effort, model, tool, fallbacks and rationale. It writes the record only. It does not start, rename or prompt an agent. The recommendation merges the project `.roostr.toml` (or `.crew-board.toml`) `[tasks.<kind>]` overrides by finding the file from the current directory.

## Task list

The Head Honcho writes `docs/orchestration/tasks.json` next to the plan and briefs:

```json
{
  "version": 1,
  "plan": "docs/orchestration-plan.md",
  "tasks": [
    {
      "id": "board-settings",
      "title": "Add task settings",
      "kind": "feature",
      "brief": "docs/orchestration/tasks/board-settings.md",
      "report": "docs/orchestration/reports/board-settings.md",
      "owns": ["src/board.js"],
      "depends_on": [],
      "status": "pending",
      "tool": "opencode",
      "effort": "medium",
      "model": "primary-model",
      "fallbacks": ["backup-model"]
    }
  ]
}
```

`crew-board tasks` validates ids, kinds, paths, status, dependency names and optional overrides, then prints the recommended effort, tier, model, confidence and fallbacks per task. `--json` returns the same rows for the secretary. A broken file exits 2 and prints every error.

A spawn entry:

```json
{
  "at": "2026-11-03T16:30:00.000Z",
  "event": "spawn",
  "runId": "815bb0ad-dcd2-464c-8e02-3b00956f080f",
  "paneId": "w1:p2",
  "name": "Diego",
  "role": "worker",
  "kind": "feature",
  "task": "add pagination to the orders endpoint",
  "tier": "balanced",
  "effort": "medium",
  "model": "balanced-model",
  "recommendedTier": "balanced",
  "recommendedEffort": "medium",
  "outcome": null,
  "rework": 0,
  "cost": null,
  "durationMs": null,
  "note": null
}
```

- `runId` joins the outcome to this spawn.
- `kind` is the detected task archetype: `docs`, `review`, `tests`, `tooling`, `complex` or `feature`.
- `tier`, `effort` and `model` are what the run will use. A flag wins over the recommendation.
- `recommendedTier` and `recommendedEffort` keep the recommendation even when a flag overrides it.
- `outcome`, `rework`, `cost`, `durationMs` and `note` stay empty until the outcome.

`roostr outcome` (or `crew-board outcome`) closes one attempt:

```sh
roostr outcome --run <runId> --result pass|fail|blocked [--rework N] [--cost N] [--note "<text>"]
```

It finds the newest spawn with that run id and writes an outcome entry. An unknown run id is an error. A second outcome for the same run is refused. `durationMs` is measured from the spawn time. `rework` defaults to `0` and `cost` stays `null` when omitted.

```json
{
  "at": "2026-11-03T17:00:00.000Z",
  "event": "outcome",
  "runId": "815bb0ad-dcd2-464c-8e02-3b00956f080f",
  "outcome": "pass",
  "rework": 0,
  "cost": 0.42,
  "durationMs": 1800000,
  "note": "tests green first try"
}
```

### The team ledger bridge

`roostr summary --from <path>` (or `crew-board summary`) accepts the existing team ledger JSONL as well as the plugin ledger:

```sh
roostr summary --from ./team-ledger.jsonl
```

The global schema is one JSON object per line with these fields:

- `date`, `project`, `task`
- `model`, `effort`, `kind`
- `outcome`, `rework`, `cost_usd`, `notes`

Both schemas normalize into one row before aggregation. The plugin schema keeps `at`, `event`, `runId`, `paneId`, `name`, `role`, `kind`, `task`, `tier`, `effort`, `model`, `recommendedTier`, `recommendedEffort`, `outcome`, `rework`, `cost`, `durationMs` and `note`. A missing path is an error. A malformed line is skipped with a warning. `ROOSTR_LEDGER` or `CREW_BOARD_LEDGER` may point at the team ledger. The plugin never assumes a private path.

### Data quality

The team ledger is written by people, so the bridge normalizes synonyms and never guesses.

- `accepted` counts as `pass`.
- `abandoned` counts as `fail`.
- `partial` is not a first try pass.
- `blocked` is not a first try pass.
- Any nonempty `rework` makes the run not a first try pass. A rework of `0`, `null` or an empty value keeps the pass eligible.
- `rework` may be a number or free text such as `one retry` or `re-ran the tests twice`. Only a numeric rework feeds `avg_rework`. Text forces the run to not first try and is not parsed into a number.
- `cost_usd` feeds `avg_cost_usd` only when it is a number. A missing or unparsable cost stays `null`, never `0`.
- A spawn with no outcome is excluded from pass rates.
- A malformed line is skipped with a warning. A duplicate outcome is ignored after the first.
- Model names are matched exactly as written. Do not merge a variant into its family or carry a verdict from one model to another.

A first try pass means an accepted run with no rework. A run that needed a rework, was partial or was abandoned is a completed attempt, not a first try pass. The pass rate and the rework count answer different questions, so read both.

Do not describe a model as bad from one aggregate or from a similar name. A real team ledger records `deepseek-v4.1-flash-1017` at 95% first try over 22 tasks. That is not a bad code model. Another model with a similar name or another kind with a small sample can look much worse. Read the exact model name, kind, effort and sample count before drawing a conclusion.

### `roostr summary` (legacy alias: `crew-board summary`)

```sh
roostr summary [--json] [--days 30] [--from <path>] [--no-write]
```

`summary` reads the ledger, joins spawn and outcome by `runId`, and aggregates. A spawn without an outcome is excluded from pass rates. A duplicate outcome is ignored after the first and reported as a warning. The default window is 30 days, which bounds the aggregation, not the file. A ledger that does not exist returns zeros and leaves the advisor on its defaults.

`summary` writes `~/.roostr/summary.json` (with fallback to `~/.crew-board/summary.json`) unless `--no-write` is passed. Override the path with `ROOSTR_SUMMARY` or `CREW_BOARD_SUMMARY`. The file is `0600`.

`~/.roostr/summary.json` (primary):

```json
{
  "generated_at": "2026-11-03T17:05:00.000Z",
  "days": 30,
  "runs": 2,
  "by_kind": {
    "feature": {
      "count": 2,
      "first_try_pass_rate": 50,
      "avg_cost_usd": 0.36,
      "avg_duration_ms": 1800000,
      "avg_rework": 0.5,
      "best_model": "balanced-model",
      "by_effort": {
        "low": { "count": 0, "first_try_pass_rate": null },
        "medium": { "count": 2, "first_try_pass_rate": 50 },
        "high": { "count": 0, "first_try_pass_rate": null }
      },
      "by_tier": {
        "fast": { "count": 0, "first_try_pass_rate": null },
        "balanced": { "count": 2, "first_try_pass_rate": 50 },
        "reasoning": { "count": 0, "first_try_pass_rate": null }
      },
      "by_model": {
        "balanced-model": {
          "count": 2,
          "first_try_pass_rate": 50,
          "avg_cost_usd": 0.36,
          "avg_duration_ms": 1800000,
          "avg_rework": 0.5
        }
      }
    }
  },
  "by_kind_model": {
    "feature": {
      "balanced-model": {
        "count": 2,
        "first_try_pass_rate": 50,
        "avg_cost_usd": 0.36,
        "avg_duration_ms": 1800000,
        "avg_rework": 0.5
      }
    }
  },
  "by_kind_effort": {
    "feature": {
      "low": { "count": 0, "first_try_pass_rate": null },
      "medium": { "count": 2, "first_try_pass_rate": 50 },
      "high": { "count": 0, "first_try_pass_rate": null }
    }
  },
  "by_kind_model_effort": {
    "feature": {
      "balanced-model": {
        "low": { "count": 0, "first_try_pass_rate": null },
        "medium": { "count": 2, "first_try_pass_rate": 50 },
        "high": { "count": 0, "first_try_pass_rate": null }
      }
    }
  }
}
```

- `first_try_pass_rate` is a percent. A first try pass is an accepted run with no rework. A spawn without an outcome is not counted.
- `avg_cost_usd`, `avg_duration_ms` and `avg_rework` are `null` when no finished run supplied that value. Only numeric rework feeds `avg_rework`.
- `best_model` considers only the user's own ledger.
- `by_kind` nests effort, tier and model for each archetype kind.
- `by_kind_model`, `by_kind_effort` and `by_kind_model_effort` are the cross tables.

### Analytics and continuous usage

The analytics engine adds continuous per-pane usage time series, status-transition history, and cost attribution over the orchestration ledger.

Privacy line:
samples store numbers and names, never prompts, transcripts or screens.

#### Stores

1. `~/.roostr/usage.jsonl` (override with `ROOSTR_USAGE` or `CREW_BOARD_USAGE`, with fallback to `~/.crew-board/usage.jsonl`):
   Append-only compact samples `{at, pane, model, effort, tokens, input, output, cost, ctx, src}`. Written on every accepted pane report (`src: "report"`), and during live board ticks for panes without exact reports (`src: "screen"`).
2. `~/.roostr/transitions.jsonl` (override with `ROOSTR_TRANSITIONS` or `CREW_BOARD_TRANSITIONS`, with fallback to `~/.crew-board/transitions.jsonl`, where supported):
   Append-only status transitions `{at, pane, status}` recorded on every `pane.agent_status_changed` lifecycle event.
3. `~/.roostr/orchestration.jsonl` (override with `ROOSTR_LEDGER` or `CREW_BOARD_LEDGER`, with fallback to `~/.crew-board/orchestration.jsonl`):
   The spawn and outcome attempt ledger.

#### Store rotation

All three JSONL stores use a shared atomic rotation helper:
- Files exceeding 5 MB (or older than 30 days, configurable via `[analytics] rotation_days` in the crew file or options) are archived to `<file>.1`.
- Rotation uses atomic rename, guaranteeing zero lost writes across rotation boundaries.
- New appends automatically start in a fresh active file.

#### `roostr analytics` (legacy alias: `crew-board analytics`)

```sh
roostr analytics [--days N] [--by pane|model|kind|batch] [--tasks <path>] [--json]
```

Views:
- `--by model` (default): aggregates token usage, cost, sample counts, and confidence ratings per model. Missing costs are derived via model pricing rates when token splits are available, marked as estimates (`~$`). Missing costs that cannot be priced remain `null` end to end.
- `--by pane`: shows sample counts, token volumes, costs, completed runs, and pass rates per pane.
- `--by kind`: aggregates runs, pass/fail outcomes, average rework, and cost grouped by task archetype kind.
- `--by batch`: constructs a batch timeline correlating tasks in `tasks.json` with spawn events, outcome events, lifecycle status transitions, and usage samples.

Epistemics:
- Pattern confidence follows sample volume: 10 or more samples is high, 3 or more is medium, fewer than 3 is low.
- A missing cost stays `null` (never 0).
- `--json` emits clean machine-readable output for programmatic queries.
- The advisor never uses a global effort average. A global low pass rate can look better because low effort is assigned to easier tasks.

### Two attempts, one pass and one rework

```sh
roostr spawn --pane w1:p2 --task "add pagination to the orders endpoint" --effort medium --model balanced-model
# run 815bb0ad-dcd2-464c-8e02-3b00956f080f
roostr outcome --run 815bb0ad-dcd2-464c-8e02-3b00956f080f --result fail --rework 1 --cost 0.30 --note "tests red, second attempt needed"

roostr spawn --pane w1:p3 --task "add pagination to the orders endpoint" --effort medium --model balanced-model
# run eb7e89c5-25c7-465f-9fec-d68210fe3a1a
roostr outcome --run eb7e89c5-25c7-465f-9fec-d68210fe3a1a --result pass --cost 0.42 --note "tests green first try"
```

The resulting row for the `feature` kind in `~/.roostr/summary.json` (or `~/.crew-board/summary.json` fallback):

```json
{ "count": 2, "first_try_pass_rate": 50, "avg_cost_usd": 0.36, "avg_rework": 0.5 }
```

The two attempts produce four ledger lines: two `spawn` entries and two `outcome` entries. Only finished runs count, so the kind has `count: 2`, one pass and one rework.

### The advisor

`roostr recommend` (or `crew-board recommend`) uses `by_kind_effort` for the task's kind, never the global effort average:

- The archetype tier and effort stay the default until the kind has at least 5 finished runs.
- With 5 or more, it chooses the lowest effort in the kind with a first try pass rate of at least 80%. `low` maps to `fast`, `medium` to `balanced`, `high` to `reasoning`.
- If no effort reaches 80%, it chooses the highest pass rate and marks the recommendation as low confidence.
- If the chosen effort is below 60% with at least 5 runs, it bumps one level.
- It never recommends above `reasoning` or below `fast`.
- It returns `samples`, `confidence` (`low` under 3, `medium` under 10, `high` at 10 or more), `source` (`default` or `ledger`) and `effortStats` for the chosen kind.
- `modelStats` reports the configured model and the best recorded model for the kind, with count, pass rate, average cost and average rework.
- `recommendedModel` still comes from the setup config or the explicit env map. The ledger informs tier, effort and the model note, not the user's model choice.
- A model in `disabledModels` is never recommended. The advisor returns `recommendedModel: null` and `modelWarning: "configure an available model"`. It never silently switches to a model from the ledger.
- The board and `roostr recommend` (or `crew-board recommend`) show `recorded: fast-model 12 runs, 83% first try, $0.12 avg` only when the sample count is at least 3.

Workers report their effort and model at the start with `roostr report --pane "$HERDR_PANE_ID" --effort <effort> --model <model>` (`crew-board report` remains supported). The head reads `roostr summary` before writing the next plan. The secretary records outcomes. The worker does not grade itself.

## Troubleshooting

- **No exact numbers**: wire the statusline or plugin. A pane with no report shows `?`.
- **`roostr` (or `crew-board`) not on PATH**: link the plugin bin as the README shows.
- **Crew file ignored**: press `a` to allow a new or changed file. The file is code.
- **Read only state dir**: the board still renders; it cannot write reports, memory or backups.
- **Update check**: off with `--no-update-check` or `ROOSTR_NO_UPDATE_CHECK=1` (`CREW_BOARD_NO_UPDATE_CHECK=1` remains supported).

## Glossary

- **board**: the live pane that lists every agent pane with its status and task.
- **pane**: one Herdr pane, named by a pane id such as `w1:p3`.
- **task line**: the one line description of what an agent pane is doing now.
- **colour tag**: the coloured mark the board assigns to a pane. In the default `label` mode it is the leading emoji in the pane name.
- **exact report**: a value an agent or its statusline reported with `roostr report` (`crew-board report` remains supported).
- **screen read**: a value read from the pane's own footer when no exact report exists.
- **unknown**: a value the board could not establish, shown as `?` and never guessed.
- **crew file**: the optional `.roostr.toml` (or `.crew-board.toml`) with per pane extras and checks.
- **trust**: the content hash you allowed for a crew file. A changed file runs nothing until you allow it again.
- **backup**: a saved workspace layout under `~/.roostr/backups/` (with fallback to `~/.crew-board/backups/`).
- **restore**: building a new workspace from a backup, named `<label> *restored`.
- **agent name**: the lowercase Herdr name, for example `diego`.
- **display name**: the capitalized pane label, for example `Diego`.
- **head language**: the language the Head Honcho uses with the user. Worker names are drawn from it. Default `en`, with `es`, `pt` and `fr` supported.
- **role**: the stable core job, for example `board core and CLI`.
- **about**: one line describing what the agent does in this crew.
- **head-honcho**: the heavy reasoning role. It owns the plan, draws worker names from the head language and does not implement.
- **secretary**: the fast monitoring role. It is always `Secretary - <workspace>` / `secretary-<workspace>` and runs monitor passes. It does not implement.
- **task kind**: `docs`, `review`, `tests`, `tooling`, `complex` or `feature`. It selects the settings row and the ledger bucket.
- **fallbacks**: the ordered backup models for a task kind or task. The board never uses them silently.
- **task list**: `docs/orchestration/tasks.json`, the machine readable plan. `roostr tasks` (or `crew-board tasks`) validates it and prints a recommendation per task.
- **name history**: `~/.roostr/names.json` (with fallback to `~/.crew-board/names.json`), the recent-name list used to avoid repeats.
- **worker**: one work package in a fresh context. It never changes the plan, its role or its about.
- **flock**: the whole crew of one Head Honcho, one secretary, workers and optional reviewers.
