# Request for Architecture & Workflow Review (for Argon)

Hi Argon! We are at an inflection point with `roostr` and want your honest architectural review and recommendations on where we stand, what to simplify, and how to structure the next phase.

## 1. Where We Stand Today

`roostr` started as a zero-dependency Node.js CLI and TUI plugin (`crew-board`) inside **Herdr** (a terminal multiplexer for coding agents). Over the last few batches, it has grown into a much larger system:

- **Canonical State & Session Recovery (`src/state-dir.js`, `src/sessions.js`, `src/session-log.js`, `src/backup.js`, `src/restore.js`)**:
  - Consolidated runtime state into `~/.roostr/` (`registry.json`, `sessions.json`, `orchestration.jsonl`, `closed-sessions.jsonl`, `backups/`, `logs/`).
  - Auto-detects and persists session IDs and models across `opencode` (including `opencode.db` `session_v2`), `claude`, `agy`, and `kilo`.
- **Roostr Standalone P1 (`docs/roostr-standalone.md`, `docs/spawn-policy.md`, `CHANGELOG.md`)**:
  - **Registry & Heartbeat (`src/registry.js`)**: Persistent worker registry (`working`, `waiting-approval`, `idle`, `done`, `failed`), SHA-256 `X-Roostr-Token` auth, and `closed-sessions.jsonl`.
  - **Detached Headless Runner (`src/runner.js`, `roostr run`)**: Spawns `opencode`, `claude`, `kilo`, `agy`, or `custom` workers detached (`< /dev/null`, `unref()`) with stdout/stderr captured to `~/.roostr/logs/<id>.log`, sampling `VmRSS` / process-tree RSS.
  - **Resource Governor & Idle Reaper (`src/governor.js`, `roostr governor`)**: Enforces per-host pane budgets (default `3` on macOS), swap-pressure checks, and 30-minute idle reaping with Swapy PID+command verification.
  - **Section 6 Monitor Board (`src/board.js`)**: Joins live panes, headless registry workers, and host memory truth (`/proc/meminfo` + optional Swapy census) into one row per worker (`owner`, `task`, `host`, `state`, `heartbeat`, `session`, sortable `RAM RSS`), and continues working when `herdr` is stopped.
- **Web Control Dashboard (`dashboard/`)**:
  - Passkey-gated (`@simplewebauthn/server`) web UI with `/agents/api/register`, `/agents/api/status` (`X-Roostr-Token` or passkey), `/agents/api/registry`, log tail, PID+command-verified reap, session/backup restore, and a collapsible sidebar.
- **Verification**: `(cd dashboard && npm test)` passes `34/34` tests across 11 suites, and `env -u HERDR_ENV ./verify.sh` passes all syntax, unit test, zero-dependency, and shell-execution checks.

## 2. The Core Architectural Shift We Want to Make

Running dozens of agents inside Herdr panes consumes massive RAM (multiple GBs of idle TUI runtimes on a 16 GB laptop). We want to **move away from depending on Herdr at all**:

1. **TUI + Web GUI Orchestrating Board (Standalone App)**: `roostr` is a self-contained TUI and Web GUI orchestrating board (no `herdr-plugin.toml` / `HERDR_ENV=1` requirement).
2. **Pick Model & Effort Without Heavy Resource Overhead**: Let the operator pick (or accept empirical recommendations for) each spawned worker's **tool, model, and effort** directly from the TUI or Web GUI, and launch them **headless** (`roostr run`) so they log to disk and report state + RSS without holding gigabytes of idle terminal/TUI RAM.
3. **Our Own Lightweight Worker-Focused TUI**: Keep the `roostr` TUI board, borrowing the best parts of a clean split/collapsible viewer UX (worker list, live log tailing, interactive attach/resume only when needed), centered on **workers** rather than terminal panes.
4. **Web Approvals (P2)**: Move approval prompts out of terminal panes into first-class approval objects (`routine` vs `big-decision`) on the passkey-gated web dashboard so agents never sit parked on an invisible terminal prompt.

## 3. Questions & Recommendations Needed from Argon

1. **Removing the Herdr Dependency**:
   - Should we keep `src/herdr.js` purely as an optional adapter (`roostr --attach` / `open in herdr` if installed) or strip it out completely and build a minimal Node PTY/log-tailer for interactive steering when a human wants eyes on a worker?
   - What is the cleanest architecture for a standalone `roostr` TUI that shows workers, live log tails, and host RAM/swap without becoming bloated?
2. **Headless Runner & Approvals (P2) Design**:
   - For headless workers (`opencode run`, `claude -p`, etc.), what is the cleanest way for a worker to request an approval (`POST /api/approvals`), wait/poll without burning tokens or holding a heavy process, and resume?
   - Should `roostr` run a single lightweight local daemon (`roostrd`) that owns the registry, RSS sampler, governor loop, and web dashboard, or keep them as separate CLI + web processes?
3. **Codebase & Repo Hygiene**:
   - `src/board.js` has grown to ~4,700 lines. How would you split it cleanly (e.g., `board/model.js`, `board/render.js`, `board/keys.js`, `board/drawers.js`) without breaking the zero-dependency rule?
   - `verify.sh --public` currently flags internal host/project references in `docs/` and `dashboard/src/config.js` defaults (`WARN` in default mode, `FAIL` in `--public` mode). What should we clean up or parameterize so the public repo stays crisp and portable?
4. **Orchestration Workflow**:
   - We currently use `docs/orchestration-plan.md`, `docs/orchestration/tasks.json`, per-package briefs, and empirical routing (`roostr tasks` / `roostr summary`). Any recommendations to tighten this loop once workers are 100% headless?
