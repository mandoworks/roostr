# Changelog

All notable changes to `roostr` are documented in this file.

## [Unreleased] - Roostr Standalone P1 & Workflow Upgrade

### Architecture Shift: Standalone & Headless by Default
- **Execution decoupled from Herdr panes (`docs/roostr-standalone.md`, `docs/spawn-policy.md`)**: Subagents and workers now default to detached headless background execution instead of holding full interactive terminal panes in RAM. Herdr becomes an optional viewer adapter.
- **Registry & Heartbeat (`src/registry.js`, `roostr registry`)**: Persistent worker registry at `~/.roostr/registry.json` (`working`, `waiting-approval`, `idle`, `done`, `failed`), SHA-256 `X-Roostr-Token` auth in `~/.roostr/tokens.json`, and closed-session audit log in `~/.roostr/closed-sessions.jsonl`.
- **Detached Headless Runner (`src/runner.js`, `roostr run`)**: Launches `opencode`, `kilo`, `claude`, `agy`, or `custom` workers detached (`< /dev/null`, `unref()`) with stdout/stderr captured to `~/.roostr/logs/<id>.log`, samples `VmRSS` / process-tree RSS, enforces OVH-by-default placement (`mac` requires explicit `--mac-reason`), and provides `roostr run logs` and `roostr run refresh`.
- **Resource Governor & Idle Reaper (`src/governor.js`, `roostr governor`)**: Enforces per-host pane budgets (Mac default `maxLivePanes: 3`), swap-pressure thresholds, and 30-minute idle pane reaping (only after verifying a resumable session ID is persisted), logging every reap/kill to `~/.roostr/closed-sessions.jsonl` with Swapy PID + command matching.
- **Section 6 Monitor Board (`src/board.js`)**: Joins `herdr` panes + `~/.roostr/registry.json` headless workers + host memory truth (`/proc/meminfo` + `~/.roostr/swapy-census.json`) into one unified monitor row per worker (`owner`, `task`, `host`, `state`, `heartbeat`, `session`, sortable `RAM RSS`) and works even when `herdr` is stopped (`herdrOnline: false`).

### Multi-Tab, Session Recovery & State Consolidation
- **Canonical State Directory (`src/state-dir.js`)**: Consolidated all runtime state (`sessions.json`, `registry.json`, `daemon-state.json`, `escalations.json`, `names.json`, `orchestration.jsonl`, `backups/`, `logs/`) under `~/.roostr/` with idempotent legacy migration from `~/.crew-board/`.
- **Multi-Tab Board & `opencode.db` v2 (`src/board.js`, `src/herdr.js`, `src/sessions.js`)**: Synthesizes agent rows across all tabs (`t1`, `t2`, `t3`, etc.) with `[tN]` / `[tN:label]` badges, falls back to `herdr pane focus` on jump, restores multi-tab sessions into separate tabs, and queries `opencode.db` (`session_v2` and `session`) alongside `agy` (`~/.gemini/antigravity-cli/brain/`) and `claude` (`~/.claude/projects/`).
- **TUI `[L log]` & `[B backups]` Upgrades (`src/board.js`)**: Multi-agent kind filter (`k`: `all > opencode > claude > agy > kilo`) and backup recovery readiness badges (`[resumable]`, `[handoff]`, `[fresh]`).

### Web Control Dashboard (`/agents/control/` & `/agents/names.html`)
- **Standalone Registry & RAM Monitor (`dashboard/src/registry-bridge.js`, `dashboard/src/app.js`)**: Added `/agents/api/register` and `/agents/api/status` (`X-Roostr-Token` or passkey), `GET /agents/api/registry`, `GET /agents/api/registry/:id/log`, `POST /agents/api/registry/:id/reap` (Swapy PID+command verified), and a sortable RAM monitor table + host `PhysMem free / Swap used` header in `/agents/control/`.
- **1-Click Session & Backup Recovery (`dashboard/src/sessions-bridge.js`)**: Added `/agents/api/sessions`, `/agents/api/backups/capture`, `/agents/api/sessions/restore`, and `/agents/api/pane/:id/split` with model/effort/session resume controls.
- **Muse Agents & Two-Way PioRelay Inbox (`dashboard/src/muse.js`)**: Unified Muse desks (`Roman`, `Engy`, `El Vigia`, `La Critica`, `Buildy 1/2`, `Romy-Car/Ril`, `Archy`, `Historia`, `Fabu`, `Repy`) into `/agents/control/` with inline canonical name/orchestrator controls, collapsible docs (`SOUL.md`, `AGENT.md`, `STATE.md`), and two-way PioRelay messaging (`/agents/api/muse/messages`, `/agents/api/muse/message`).
