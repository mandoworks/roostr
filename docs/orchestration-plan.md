# Orchestration plan: handoff, backup timer, worker snapshot

Implementation slice for `docs/agents-board-names-design.md`, limited to things that belong in this repo. Three independent packages, one Kilo/Baidu worker each, disjoint file ownership. The OVH-side names endpoint, editor page and orchestrator list are not in this batch; Roosty builds them directly.

## Goal

- `roostr handoff` writes an orchestrator brief plus a pointer to the raw session.
- `roostr backups capture` plus a user timer keeps versions current while no board is open, and records handoff pointers and stale session refs.
- `roostr workers` publishes a per-host worker snapshot for the /agents drill-down.

## Non-goals

- No change to the /agents SPA, the names endpoint, or PioRelay.
- No automatic handoff trigger yet; the daemon hook is a follow-up. This batch ships the manual command and the reusable writer.
- No slug renames and no relay writes.

## Done check

- Each package passes its own `node --test test/<pkg>.test.js`.
- `./verify.sh` passes on the merged tree.
- No new dependencies, Node 22 only, no em dashes in shipped files.
- `bin/roostr` is wired by the orchestrator at merge time, not by workers.

## Parallelism

Three worktrees, three panes, no dependencies between them.

## Verification

Tier 1: file ownership check against `owns`. Tier 2: package tests. Tier 3: manual smoke of each command against a temp state dir.
