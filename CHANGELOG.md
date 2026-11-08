# Changelog

All notable changes to Roostr are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-11-07

### Added
* **Live TUI Observability Board**: Persistent split pane and popup overlay for tracking agent swarms inside Herdr.
* **Progressive Context Compaction**: 4-tier indicators starting at 30% warm cyan, 50% attention dilution badge, 75% alarm, and 85% critical alert.
* **Interactive Options View (`o` key)**: Real-time settings for Tokscale connectivity, compaction status, tag scopes, and storage paths.
* **Workspace Backups & Recovery (`R` key)**: Automated workspace layout snapshots with safe restoration into fresh workspaces without touching active panes.
* **1-Line Installer (`scripts/install.sh`)**: Automated setup that configures plugin, CLI symlinks, and Herdr keybindings.
* **Truthful 3-Tier Veracity**: Exact reports, tinted passive scraping, and unverified values marked strictly as unknown (`?`).
* **Optional Tokscale Spend Integration**: Shipped integration with Junho Yeo's tokscale for daily cross-agent token and spend tracking.

### Changed
* **Product Scope**: Public documentation, CLI `--help`, and default UI focused strictly on Observability Core.
* **Gated Orchestration**: Multi-agent orchestration workflows (Head Honcho, Secretary daemon, task intake) gated behind feature flag pending live soak testing for v0.3.0.
* **Acknowledgements**: Added attribution for Herdr runtime, tokscale by Junho Yeo, and grill-with-ui by jasonku09 as future inspiration.

### Fixed
* **Installer Standalone Fallback**: Updated `scripts/install.sh` to download release assets directly into `~/.local/share/roostr` when Herdr is absent or plugin root is not found.
* **Ubuntu / Linux CLI PATH Discovery**: Updated `scripts/install.sh` to write `~/.local/bin` to `~/.bashrc` and `~/.profile` when missing, and output an immediate session export command.
* **Release Workflow Idempotency**: Fixed `.github/workflows/release.yml` to support re-runs by uploading assets with clobber when a release tag already exists.
* **Attribution Scope**: Clarified that grill-with-ui is intake inspiration and not an active feature in v0.2.0.
