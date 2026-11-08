# Roostr Feature Matrix: Current Release vs Roadmap

Live status of features in Roostr: what ships now in v0.2.0, what is gated for v0.3.0, and what is planned for v0.4.0+.

---

## 1. Shipped in v0.2.0 (Core Observability & Safety Guardrails)

The core observability board is fully implemented, verified with 418 tests, and ready for public use.

### Live TUI Observability Board
* **Split and Popup Views**: Runs as a persistent split pane (`roostr`) or an on-demand popup overlay (`roostr --popup`, closed with `q` or `Esc`).
* **Multi-Workspace Aggregation**: Scopes to the active workspace by default, or aggregates every workspace across the session (`--all` flag, or `a` key toggle).
* **3-Tier Truthful Data Hierarchy**:
  1. *Exact Tier*: Pane reports exact usage via `roostr report` (tokens, cost, context percentage, active model).
  2. *Tinted Screen Scrape Tier*: Passive footer scraping from agent TUI statuslines when no exact report is received. Marked with visual tint.
  3. *Unknown Tier*: Unknown values render strictly as `?` without speculative estimates.
* **Compact and Expanded Layouts**: Toggle between a dense single-line summary and an expanded card layout via the `v` key.
* **Live Sorting and Filtering**: Sort panes by status, cost, token burn rate, or elapsed time.

### Financial and Token Guardrails
* **Real-Time Burn and Pace Forecasting**: Computes token burn rates per minute and forecasts total cost pace for long-running batches.
* **DeepSeek and API Surge Warnings**: Detects sudden rate limit warnings, surge pricing, or abnormal token acceleration (`src/surge.js`), showing warning badges directly on the board.
* **Offline Pricing Catalog**: Includes local token pricing maps for Claude, OpenAI, Gemini, DeepSeek, and local models (`src/pricing.js`).

### Workspace Resilience & Recovery
* **Automated Layout Snapshots**: Automatically archives workspace layouts (panes, working directories, active models, split ratios) under `~/.roostr/backups`.
* **Safe Workspace Restore**: Interactive popup (`roostr backups`) to inspect and rebuild past sessions into fresh workspaces without touching active panes.
* **PID and RAM Monitoring**: Tracks memory consumption per pane to detect memory leaks and orphaned dev processes.

### Developer Experience & Zero Dependencies
* **Zero npm Dependencies**: Pure Node 22 native implementation using standard library modules only.
* **Agent Statusline Integrations**: Drop-in statusline snippets for Claude Code, Agy, OpenCode, and Kilo (`integrations/`).
* **SHA-256 Pinned Crewfiles**: Validates workspace-level `.roostr.toml` configuration files against SHA-256 checksums to prevent unauthorized prompt or model overrides.

---

## 2. Roadmap

* **Cross-Host Herdr Federation**: Observe and manage agent panes across multiple machines connected via Tailscale.
* **Adaptive Model Routing**: Dynamically route subtasks to the cheapest capable model based on real-time token spend and failure history.
* **Automated Code Reviewer Dispatch**: Automatically spawn ephemeral worker panes with fresh contexts to review diffs before batch merges.
* **Web Dashboard View**: Optional lightweight local web UI companion to the terminal TUI board.
