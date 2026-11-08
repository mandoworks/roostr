# Roostr v0.2.0 Release Notes

**Release Date**: 2026-11-07  
**Artifact**: GitHub Release tag `v0.2.0`  
**Target Channel**: Public GitHub release (`herdr plugin install mandoworks/roostr`) followed by Herdr Marketplace listing.

---

## 1. Supported Scope: Observability Core

Roostr v0.2.0 is an observability board, flight recorder, and safety monitor for AI coding agent swarms running inside [Herdr](https://herdr.dev).

### Core Features
- **Live TUI Observability Board**:
  - Persistent split pane or popup overlay (`q` / `Esc` to dismiss).
  - Single-line compact view or expanded task card view (`v` key).
  - Multi-workspace aggregation (`--all` or `s` key).
  - Quick pane navigation: one click selects, double click jumps to agent pane, click or `y` copies pane ID.
- **Truthful 3-Tier Data Hierarchy**:
  - *Exact*: Pane reports exact usage via `roostr report` (tokens, cost, context percentage, active model).
  - *Tinted*: Passive footer scraping from agent statuslines when no exact report is received. Marked with visual tint.
  - *Unknown (`?`)*: Missing values render strictly as `?`. Never guessed.
- **Attention Degradation & Context Compaction Guardrails**:
  - 4-tier progressive indicators:
    - `< 30%`: Pristine context (dim grey text, quiet).
    - `30% - 49%`: Warming (subtle cyan text, ambient awareness).
    - `50% - 74%`: Attention dilution risk (amber text, amber `COMPACT` row badge, detail box advice).
    - `75% - 84%`: High context alarm (bold amber text, bold amber badge, top alarm banner).
    - `≥ 85%`: Critical threshold (bold red text, bold red badge, urgent top banner).
- **Workspace Resilience & Backups**:
  - Automatic layout archives under `~/.roostr/backups` on every refresh.
  - Interactive backup browser (`R` key or `roostr backups`).
  - Safe restoration (`r` then `y`) creates a fresh `*restored` workspace without touching active panes.
- **Live Options & Status Tab (`o` key)**:
  - Tokscale connectivity, polling frequency, spend today, and active clients.
  - Compaction threshold overview and safe pane status.
  - Board settings toggles (tags `t`, view `v`, scope `s`, metric `$`, daily budget).
  - File storage paths (`config.json`, `ledger.jsonl`, `backups`).
- **Optional Tokscale Spend Integration**:
  - Auto-detects [tokscale](https://github.com/junhoyeo/tokscale) when on PATH for cross-agent spend today. Degrades cleanly when absent.

---

## 2. Gated Features (Not in v0.2.0)

Autonomous multi-agent orchestration (Head Honcho planner, Secretary daemon, monitor pass loops, and task intake) is implemented under an internal gate pending multi-pane live soak testing.

- The default UI hides all orchestration shortcuts (`S/O/K/M/C`).
- CLI subcommands (`spawn`, `outcome`, `tasks`, `template`, `name`, `recommend`, `summary`) are excluded from public `--help`.
- Orchestration features are gated behind `ROOSTR_EXPERIMENTAL=1` or `[orchestration] enabled = true` in config, scheduled for the v0.3.0 release.

---

## 3. Security & Privacy

- **SHA-256 Pinned Crewfiles**: `.roostr.toml` (and legacy `.crew-board.toml`) runs checks as code. A new or edited crewfile is ignored until you press `a` to approve its SHA-256 hash.
- **Safe Command Execution**: Check commands are executed as argv arrays via `execFile`, never passed to a shell.
- **Zero Secret Access**: Reads no `.env` files and no home directory credentials. Third-party keys come strictly from environment variables.
- **Update Check**: Live board checks GitHub for release tags at most once per day via `git ls-remote`. No usage data is transmitted. Disable with `--no-update-check` or `ROOSTR_NO_UPDATE_CHECK=1`.

---

## 4. Installation & Upgrades

### Automatic Install (Recommended)
```sh
curl -fsSL https://raw.githubusercontent.com/mandoworks/roostr/main/scripts/install.sh | bash
```
*Note for Linux / Ubuntu*: If `roostr: command not found` appears in your active shell, run `export PATH="$HOME/.local/bin:$PATH"`. The installer automatically appends this to your shell profile for future sessions.

### Manual Install via Herdr
```sh
herdr plugin install mandoworks/roostr
```

Bind shortcut in `~/.config/herdr/config.toml`:
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

### Rollback / Uninstall
```sh
herdr plugin remove roostr
```

---

## 5. Verification Evidence

- **Platform**: Tested on macOS Darwin 24.3.0 (Apple Silicon) and Linux x86_64.
- **Herdr Version**: Herdr 0.9.1+.
- **Pure Node 22 stdlib**: Zero npm dependencies, no build step, no native addons.
- **Syntax check**: All 42 scripts passed `node --check`.
- **Unit test suite**: 418 unit tests passed via `node:test` (0 failures, 0 skipped).
- **Live smoke**: Verified against 23 active agent panes in live Herdr swarm session.

---

## 6. Known Limits

- **Tokscale requirement for historical totals**: Without tokscale installed on PATH, the `d today` view shows open panes and agent breakdown, but cannot read closed session history across past days.
- **Terminal width**: Best viewed in terminal windows with 80 or more columns. Narrower panes automatically drop lower-priority columns.

---

## 7. Acknowledgements

- [Herdr](https://herdr.dev): The terminal multiplexer platform roostr is built for.
- [tokscale](https://github.com/junhoyeo/tokscale) by Junho Yeo: Powers optional daily spend tracking (`--today`) with clean fallback when absent.
- [grill-with-ui](https://github.com/jasonku09/grill-with-ui) by jasonku09: Inspiration for future orchestration intake; not supported in v0.2.0.
