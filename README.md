# roostr

A [Herdr](https://herdr.dev) plugin that opens a live **board** of every agent pane in the session. One row per agent: its colour tag, name, model and reasoning effort, status and how long it has been in that status, context, tokens and cost, its **task line**, check badges such as `REPORT READY`, and workspace backups.

```
🐓ROOSTR🐓  example crew                                                  14:30  load 1.50 1.25 1.00
[tags: label] [view: auto] [scope: all] [edit task] [R backups] [d today] [? keys]
● tests
◼ 1 BLOCKED: copy 30s
────────────────────────────────────────────────────────────────────────────────────────────────────
   name                     id    model    state          ctx tokens  cost  ram task line
▾ ━━━━━━ example-app ━━━━━━  4 panes
🟦 Diego · board core    w1:p1 opus M   ○ idle 4m      17%    34K $2.03 1.5G write the API guide
🟩 Valeria · api and tests w1:p2 sonnet H ● working 27m  18% 208.4K $2.17 640M fix the login timeout bug
🟨 Ines · test triage    w1:p3 gpt-6    ● working ≥41m 34% 340.9K     ?    ? flaky suite triage
🟪 Tomas                 w1:p4 kilo     ✓ done 1h05      ?      ?     ?    ? ?
5 panes  ● 2 working  ○ 1 idle  ◼ 1 blocked  ✓ 1 done  ? unknown
```

Node 22 or newer, zero npm dependencies, no build step. Linux and macOS. Needs Herdr 0.9.1 or newer.

## Quickstart

### 1-Line Install (Automatic)

Installs the Herdr plugin, symlinks `roostr` onto your PATH, and configures the `prefix + b` keybinding automatically:

```sh
curl -fsSL https://raw.githubusercontent.com/mandoworks/roostr/main/scripts/install.sh | bash
```

### Manual Install

If you prefer installing directly with Herdr:

```sh
herdr plugin install mandoworks/roostr
```

Bind a shortcut in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "roostr.toggle-board"
description = "roostr: toggle live board"
```

Reload Herdr config:
```sh
herdr server reload-config
```

## Opening the Board

Once installed, open the board in any of three ways:
* **Keybinding**: Press `prefix + b` to toggle the board beside your current work.
* **Terminal**: Type `roostr` in any Herdr shell.
* **Command Palette**: Press `Cmd+K` / `Ctrl+P`, type `roostr: toggle board`, and hit Enter.

## What you see

- **`?`** means unknown. The board never guesses a number.
- **tinted** values were read from the pane's screen, not reported exactly.
- **≥** marks a status start the board did not watch, so the time is a lower bound.
- **colour tag**: assigned by the board, never typed by you. The default `label` mode puts the matching emoji in the pane name, for example `🟦 Diego · board core`.
- **click**: one click selects a row. Double click the same row to jump to its pane. Clicking a pane id copies it.
- **`◼` blocked** rows sort first in their workspace, and the banner shows the blocked and over budget panes.

The visual prototype is in [docs/crew-board-visual.html](docs/crew-board-visual.html). Press `?` in the board for the key list.

## Backups and Workspace Recovery

Roostr saves workspace layouts (panes, working directories, active models, split ratios) under `~/.roostr/backups`.

* **From the board**: Press `R` or click `[R backups]` in the menu bar to open the interactive backups view.
* **Inspect and preview**: Use arrow keys to cycle through saved workspaces and versions.
* **Restore safely**: Press `r` to restore the selected snapshot. Roostr builds a fresh workspace (`*restored`) without altering or touching your active panes.
* **CLI usage**:
  ```sh
  roostr backups
  roostr backups show <label|id>
  roostr backups restore <label|id> --yes
  ```

## Where each value comes from

| Column | Source, best first |
| --- | --- |
| colour tag | assigned by the board, stable for the pane's life |
| name | the capitalized display name from the pane label, then the Herdr agent name |
| role, about | an exact `--role` and `--about` report; the role is stable and the about is one line |
| id | the Herdr pane id (`w1:p3`); click or press `y` to copy it |
| task line | an exact `--task` report, then the terminal title |
| model | an exact report, then the crew file, then the screen footer |
| eff | an exact report, then the screen footer |
| state, time | Herdr's status; the board times each change itself |
| ctx, tokens, cost | an exact report, then the agent's footer; Gemini costs are API estimates until a report gives the exact number |
| ram | resident memory of the pane's process tree, one `ps` call every 10 seconds |
| badges | the crew file |
| usage limits | the Claude Code, agy and Codex reports; Experiential Labs when opted in |
| today's spend | [tokscale](https://github.com/junhoyeo/tokscale) by Junho Yeo, when installed |

Full detail, including the JSON envelope and every flag, is in [docs/reference.md](docs/reference.md).

## The crew file

`roostr` finds `.roostr.toml` (or legacy `.crew-board.toml`) above each pane's cwd. It is code: it runs checks, so the board ignores it until you allow its content hash.

```toml
[board]
name = "example-app"
budget = 20
tags = "tokens"
tag_scope = "here"

[[check]]
name = "tests"
run = "npm test"

[[pane]]
name = "Diego"         # the display name, matched against the pane label
model = "sonnet"
report = "agents/docs/report.md"
checks = ["GREEN: npm test"]
```

The full schema, including `[checks]` and `[providers.explabs]`, is in [docs/reference.md](docs/reference.md#the-crew-file).

## Security

- The crew file is code. Anyone who can edit it can run commands as you, so a new or changed file runs nothing until you press `a` to allow its content hash.
- Check commands are split into an argv array and run with `execFile`, never through a shell.
- Unknown values show `?`. The board never invents a number.
- No secrets. The board reads no `.env` file and no home directory key file. Third party keys come from the environment only.

## Privacy

The board shows task lines, project names and costs. A screenshot shared in public shows them too.

- **Update check.** A live board asks GitHub for release tags at most once a day with `git ls-remote`. No pane data, usage data or reports are sent. `--no-update-check`, `ROOSTR_NO_UPDATE_CHECK=1` or `CREW_BOARD_NO_UPDATE_CHECK=1` turns it off. `--once` and `--json` never start it.
- **Experiential Labs is opt in.** It is off until you set `EXPLABS_ENABLED=1` with `EXPLABS_API_KEY` or `EXPLABS_COOKIE`, or enable `[providers.explabs]` in a trusted crew file. The key and cookie come from the environment only, with no home directory file discovery. No pane data leaves the machine.
- **Codex.** Codex has no statusline, so the board reads only the last `rate_limits` entry near the end of its newest session file, at most 64 KiB of it, and nothing else.

## Troubleshooting

- **A field shows `?`.** Wire the statusline or plugin for that agent, or press `r` to refresh.
- **`roostr` not found.** Link the plugin bin onto your `PATH`, as in the quickstart.
- **The crew file is ignored.** Press `a` to allow a new or changed file.
- **A read only state dir.** The board still renders. It cannot write reports, memory or backups.
- **The board changed a label.** Tag mutations are limited to the home workspace by default. Use `--tags-scope all` only when you mean it.

## Development

```sh
./verify.sh       # syntax check, tests, manifest, dependency and hygiene audit
node --test test/*.test.js
```

Tests use node:test with sample footers for every adapter, TOML reader cases, and a render snapshot (`UPDATE_SNAPSHOTS=1` rewrites it). Every Herdr CLI call lives in `src/herdr.js`.

## Acknowledgements

* [Herdr](https://herdr.dev): The modern terminal multiplexer and runtime platform roostr is built for.
* [tokscale](https://github.com/junhoyeo/tokscale) by Junho Yeo: Powers optional daily spend tracking (`--today`) with clean fallback when absent.
* [grill-with-ui](https://github.com/jasonku09/grill-with-ui) by jasonku09: Inspiration for future orchestration intake; not supported in v0.2.0.

## Licence

MIT. A community contribution by Mando Works.
