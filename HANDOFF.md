# Roostr Handoff Document

Updated: 2026-11-07
Current state: release ready (observability core v0.2.0), `./verify.sh --public` passes with 418 tests.

---

## 1. Project Overview & Scope

- **Package**: `roostr` (renamed from `crew-board`).
- **Core value (v0.2.0)**: Terminal multiplexer observability core for coding agent swarms inside Herdr. Real-time token usage, pane health, context tracking, live backups, and session recovery.
- **Gated for v0.3.0**: Autonomous multi-agent orchestration (Head Honcho shell launcher, Secretary daemon loop, monitor prompt injection). Fully functional behind `ROOSTR_EXPERIMENTAL=1` or `orchestration = true` in config.
- **Constraints**: Pure Node 22 stdlib, zero dependencies, no em dashes in prose, non-destructive defaults.

---

## 2. Completed Work

### 2.1 Renaming (`crew-board` -> `roostr`)
- CLI command: `roostr` (symlinked/aliased with fallback to `crew-board`).
- Herdr RPC calls: `--source roostr` (with fallback `--plugin roostr`).
- State directories: `~/.roostr` with seamless fallback to `~/.crew-board`.
- Environment variables: `ROOSTR_*` with fallback to `CREW_BOARD_*`.
- OpenCode integration: added `integrations/opencode/roostr.mjs` symlink.

### 2.2 Visibility & Backups Access
- Main board menu bar includes `[R backups]`, directly accessible with key `R` or click.
- Backups view previews workspace layouts, pane shapes, and agent assignments with instant dry-run preview and one-key restore (`r` then `y`).

### 2.3 Options Tab (`o` key)
- Added dedicated Options tab (`o` key or click `[o options]`).
- Displays:
  - **Tokscale Connection**: installation path, polling cycle (5m / hourly 30m), today's total spend, detected agent clients.
  - **Context Compaction**: 4-stage tier thresholds, advice, high-context pane counts.
  - **Board Settings**: tag mode (`t`), layout view (`v`), scope (`s`), metric (`$`), daily budget.
  - **Paths & Storage**: config path, ledger path, backups directory, orchestration status.

### 2.4 Context Compaction Progressive Model
- `< 30%`: Nominal / pristine (dim grey text, zero alerts).
- `30% - 49%`: Warming (subtle cyan text, awareness without badges or alarm fatigue).
- `50% - 74%`: Attention dilution risk (amber text, amber `COMPACT` row badge, detail box `/compact recommended`).
- `75% - 84%`: High context alarm (bold amber text, bold amber `COMPACT` badge, top alarm banner).
- `>= 85%`: Critical context threshold (bold red text, bold red `COMPACT` badge, urgent top alarm banner).

### 2.5 Data Gathering on Agent Success
- **Without orchestration (continuous telemetry)**: gathers pane activity, tokens (in/out/cache), costs, memory footprint, and status transitions (`working`, `idle`, `blocked`, `done`).
- **With orchestration ledger (`roostr outcome <runId> pass|fail|blocked`)**: records explicit task outcomes, first-try pass rates, and rework counts.

### 2.6 Pruned Orchestration References from Public Interface
- **CLI `--help`**: Pruned experimental subcommands (`spawn`, `outcome`, `template`, `name`, `recommend`, `summary`) from public help. Now only lists supported observability commands (`roostr [board]`, `report`, `backups`, `analytics`, `sessions`, `restore`).
- **Documentation**: Removed experimental v0.3.0 orchestration roadmap sections from `README.md` and `FEATURE-LIST.md`. The repo presents as a focused observability and flight recorder tool.
- **Options view**: Removed the `orchestration` row from the Options tab (`o` key).
- **Code preservation**: The underlying code (`src/daemon.js`, `src/orchestrator.js`, `src/grill.js`) and tests remain intact and inert behind the gate for v0.3.0.

---

## 3. Key Repositories & Deployments

- Core repo: `mandoworks/roostr`
- Marketing site repo: `mandoworks/roostr-web` (built by worker pane `w23:p2`, deployed to Vercel at `roostr.mando.works`).
- Jury report: `docs/jury-dashboard.html`.
- Readiness design: `docs/launch-readiness-design.md`.

---

## 4. Verification & Testing

Run full verification:
```bash
./verify.sh --public
```

All 6 acceptance gates:
1. Syntax check every script (42 files)
2. Unit test suite (418 tests pass via `node:test`)
3. Manifest validity (`herdr-plugin.toml`)
4. Zero dependency audit (no `package.json`, no `node_modules`)
5. Public repo hygiene (no em dashes, no private paths or secrets)
6. Live smoke inside Herdr (snapshot 23 live panes)
