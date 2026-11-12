# Changelog

All notable changes to **roostr** are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] (v0.3.0 Preview)

### Added
- **Consolidated 3-Tab `[O orchestrate]` TUI Hub (`O` or `T` key)**:
  - **Tab 1 (`1 tasks · advisor`)**: Assign or spawn the workspace Orchestrator (`o`), bind the active plan repository (`p`), start or trigger the Secretary monitor (`k` / `m`), inspect every task in `docs/orchestration/tasks.json` alongside empirical advisor recommendations, override `tool`, `effort`, `model`, and `fallbacks` in place, or press `c` to copy the ready-to-run `roostr spawn` command.
  - **Tab 2 (`2 analytics · summary`)**: Live interactive breakdown of spend, tokens, first-try pass rates, rework rates, and **Delegation Efficiency Share (`>=80%` worker target bar)** across `model`, `pane`, `kind`, and `batch` over `1d`, `7d`, and `30d` windows (`b`, `d`, `s`).
  - **Tab 3 (`3 setup`)**: Interactive configuration for coding tools (`claude`, `opencode`, `kilo`, `agy`, `codex`, `gemini`), speed tiers (`fast`, `balanced`, `reasoning`), role defaults, and per-kind routing rules.
- **4-Zone Top Status Bar & Automatic `🐓ROOSTR🐓` Pane Naming**:
  - Automatically renames the Herdr board pane to `🐓ROOSTR🐓` via `herdr pane rename` on launch and toggle.
  - Dedicates Line 0 of the board to four live, clickable zones: Workspace/Crew title, Live Crew Pulse (`● working · ○ idle · ◼ blocked`), Orchestration & Today Spend + `⚡` burn pace bolt, and Clock + CPU load.
- **Interactive Click Tooltips Across All Badges & Bars**:
  - Click `⚡` (burn pace multiplier), `⚠` (projected quota run-out ETA), quota usage bars, `▲ 2×` (peak-hour quota surge), `COMPACT` / `ctx%` (context dilution status), `load` (CPU load averages), or crew check pills (`●` / `○` / `?`) for instant explanations in the top notice bar.
- **Full Mouse Navigation Inside Drawers**:
  - Click tab pills (`[1]`, `[2]`, `[3]`, `[esc close]`), task rows, inline `effort`/`model` cells, and analytics filter pills directly with the mouse.
  - Active top-bar drawer pill highlights (`[▾ O orchestrate]`, `[▾ d today]`, `[▾ R backups]`, `[▾ o options]`) and toggles closed when clicked again.
- **Canonical `roostr` Agent Skill (`skills/roostr/SKILL.md`)**:
  - Automatically installed to `~/.herdr/skills/roostr`, `~/.claude/skills/roostr`, and `~/.config/opencode/skills/roostr` via `scripts/postinstall.js`.
  - Encodes the **Event-Woken Planner Rule** (`<20%` orchestrator token share, `<30%` orchestrator context ceiling, single-agent threshold for `<30-line` fixes) and the **Warm-Pane Subagent Context Reset Protocol** (`/clear` or `/new` before assigning a new task to an idle worker pane below `30%` context).
  - Includes [`skills/roostr/references/schemas-and-config.md`](skills/roostr/references/schemas-and-config.md) documenting `tasks.json`, `.roostr.toml`, `~/.roostr/config.json`, `summary.json`, and worker report schemas.
- **Session Log & Workspace Respawn**:
  - `L log` (or `roostr log`) lists recent opencode and kilo conversations from their own stores; `enter` reopens one in the current workspace, so a closed tab keeps its conversation.
  - `roostr respawn --workspace <id|label> --yes` snapshots, closes and rebuilds a workspace with its saved layout, resuming every agent session. It refuses while an agent is working or when a resume capable pane has no session; `--force` overrides both.
  - Press `X` in the board to respawn its own workspace: a detached child rebuilds it, reopens the board there and leaves the key press free to finish.
  - Session ids are now read from Herdr's `agent_session.value`, so backups, restores and respawns no longer lose a conversation Herdr already knew.
- **Smart Spawner Execution & Daemon Escalation Triggers**:
  - `roostr spawn --execute` automates worktree pane splitting, agent initialization, pane labeling, board reporting, and ledger tracking.
  - `src/daemon.js` evaluates five deterministic procedural escalation triggers (`loop-3x`, `stalled-180s`, `blocked`, `context-ceiling` at `85%`, and `test-regression-2x`) at zero LLM token cost.
- **Roostr Arena (`roostr arena`, `roostr analytics --share`) & Community Cold-Start Priors**:
  - `src/arena.js` aggregates anonymized outcome telemetry (`first_try_pass_rate`, `avg_rework`, `avg_cost_per_pass_usd`) by `(kind, tool, model, effort)` with zero private paths, prompts, or repo names.
  - `roostr arena --share` and `roostr analytics --share` render a copy-pasteable ASCII + Markdown leaderboard card of your 30-day model pass rates and $/pass.
  - `src/advisor.js` falls back to `~/.roostr/global-summary.json` (`confidence: 'community'`) when a `(kind, model)` pair has fewer than 5 local runs.
- **One-Command Onboarding (`roostr init`)**:
  - `src/init.js` creates and pre-trusts a starter `.roostr.toml` in the current project and seeds `~/.roostr/config.json` with coding agent CLIs detected on `PATH`.
- **Symlink Path Guards & `.bak` State Recovery**:
  - `fs.realpathSync` boundary verification in `src/crewfile.js` and `src/report.js` plus automatic `.bak` fallback in `src/state.js`.
- **Device Build Label & `scripts/update.sh`**:
  - Line 0's right corner now shows the exact build (`v0.2.0` for a release, `v0.2.0@3f9a2c1` for a git checkout, amber `⬆` when a newer release exists), so two devices can confirm they run the same code. `--json` gains a `commit` field.
  - `scripts/update.sh` pulls the plugin from a branch or the latest release and, when given `--skills-repo`, pulls and syncs the agent skills; `~/.roostr/update.conf` keeps those flags per device.

---

## [0.2.0] - 2026-11-07

**Artifact**: GitHub Release tag `v0.2.0`  
**Target Channel**: Public GitHub release (`herdr plugin install mandoworks/roostr`) followed by Herdr Marketplace listing.

### Added
- **Live TUI Observability Board**:
  - Persistent split pane or popup overlay (`q` / `Esc` to dismiss).
  - Multiple responsive layouts (`v` key: `auto`, `columns`, `cards`, `table`, `compact`, `line`; `w` key for `cards`).
  - Multi-workspace aggregation (`--all` or `s` key).
  - Quick pane navigation: one click selects, double click jumps to agent pane, click or `y` copies pane ID.
- **Truthful 3-Tier Data Hierarchy**:
  - *Exact*: Pane reports exact usage via `roostr report` (tokens, cost, context percentage, active model).
  - *Tinted*: Passive footer scraping from agent statuslines when no exact report is received. Marked with visual tint.
  - *Unknown (`?`)*: Missing values render strictly as `?`. Never guessed.
- **Attention Degradation & Context Compaction Guardrails**:
  - 4-tier progressive indicators:
    - `< 30%`: Pristine context (dim grey text, quiet).
    - `30% to 49%`: Warming (subtle cyan text, ambient awareness).
    - `50% to 74%`: Attention dilution risk (amber text, amber `COMPACT` row badge, detail box advice).
    - `75% to 84%`: High context alarm (bold amber text, bold amber badge, top alarm banner).
    - `>= 85%`: Critical threshold (bold red text, bold red badge, urgent top banner).
- **Workspace Resilience & Backups**:
  - Automatic layout archives under `~/.roostr/backups` on every refresh.
  - Interactive backup browser (`R` key or `roostr backups`).
  - Safe restoration (`r` then `y`) creates a fresh `*restored` workspace without touching active panes.
- **Live Options & Status Tab (`o` key)**:
  - Tokscale connectivity/status, latest poll age, spend today, and active clients.
  - Compaction threshold overview and safe pane status.
  - Board settings toggles (tags `t`, view `v`, scope `s`, metric `$`, daily budget).
  - File storage paths (`config.json`, `orchestration.jsonl`, `backups`).
- **Optional Tokscale Spend Integration**:
  - Auto-detects [tokscale](https://github.com/junhoyeo/tokscale) when on PATH for cross-agent spend today. Degrades cleanly when absent.

### Security & Privacy
- **SHA-256 Pinned Crewfiles**: `.roostr.toml` (and legacy `.crew-board.toml`) runs checks as code. A new or edited crewfile is ignored until you press `a` to approve its SHA-256 hash.
- **Safe Command Execution**: Check commands are executed as argv arrays via `execFile`, never passed to a shell.
- **Zero Secret Access**: Reads no `.env` files and no home directory credentials. Third-party keys come strictly from environment variables.
- **Update Check**: Live board checks GitHub for release tags at most once per day via `git ls-remote`. No pane data, usage data, or reports are transmitted. Disable with `--no-update-check`, `ROOSTR_NO_UPDATE_CHECK=1`, or `CREW_BOARD_NO_UPDATE_CHECK=1`.

---

## [0.1.0] - 2026-10-22

### Added
- Initial open-source release of the Herdr agent observability board (`herdr-plugin.toml`), screen-footer adapters (`claude`, `opencode`, `kilo`, `agy`, `codex`, `gemini`), TOML `.roostr.toml` crewfile parser, and `roostr report` CLI.
