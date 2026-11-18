# Orchestration Plan: Roostr Standalone P2 (Unified `roostrd`, Web Approvals, Board Split & Herdr Decoupling)

Five coordinated work packages in `$WORKSPACE/roostr` implementing the locked P2 architecture from `docs/roostr-standalone.md` and `docs/spawn-policy.md`.

## Locked Architecture Decisions

1. **Unified `roostrd` Control Plane (`src/roostrd.js`)**:
   - Single writer for `~/.roostr` (`registry.json`, `approvals.json`, `decisions.jsonl`, `closed-sessions.jsonl`) listening on `~/.roostr/roostrd.sock` (`0600`).
   - Owns the 10s RSS/Swapy sampler, dead-PID reconciliation, 30m idle reaper, and 60s approval TTL sweep.
   - `dashboard/src/app.js` mounts and proxies to `roostrd` behind the WebAuthn passkey gate, while CLI/TUI commands retain lock-guarded file fallback when `roostrd` is offline.
2. **Optional Herdr Viewer Adapter (`src/viewers/herdr.js`)**:
   - Move `src/herdr.js` implementation into `src/viewers/herdr.js` (`src/herdr.js` remains a non-throwing compatibility re-export).
   - Remove all hard `HERDR_ENV=1` and `herdr` binary requirements so `roostr` runs 100% standalone.
3. **P2 Web Approvals (`src/approvals.js` + `dashboard/src/approvals-bridge.js`)**:
   - Hybrid wait: 60s long-poll (`GET /agents/api/approvals/:id/wait?timeout=60`) for fast `routine` checks, then clean exit `0` (`state: "waiting-approval", hibernated: true, rssKb: 0`) with automatic session resume (`runner.resumeAfterApproval`) when decided.
   - Governance: `routine` approvable by human passkey or by `Hermita` token on `host === "ovh"` only (Mac `routine` requires passkey). `big-decision` requires human passkey only (`403` on token auth), triggers Web Push / Pushover + Roman PioRelay notification, and supports 1-click escalation into a Chicken-Grill spec session (`POST /agents/api/approvals/:id/grill`).
4. **Modular `src/board/*` Split & Standalone Worker TUI**:
   - Split `src/board.js` into `src/board/{index,state,model,collect,render,views,viewer}.js` with `src/board.js` re-exporting all public symbols.
   - Built-in collapsible split log-tail pane (`Enter` / `l`), native CLI interactive TTY attach (`i`), `[A approvals]` tab, and `[S spawn]` drawer wired to `src/advisor.js` (`recommend`).

## Waves & Done Check

- **Wave 1 (Parallel)**:
  1. `pkg-p2-state-lock-and-hygiene`
  2. `pkg-p2-approvals-engine-and-web`
  3. `pkg-p2-board-split-and-tui-viewer`
- **Wave 2 (After Wave 1)**:
  4. `pkg-p2-spawn-drawer-and-advisor`
  5. `pkg-p2-herdr-demotion-and-orchestrator`
- **Done Check**:
  - `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh --public` both pass with 0 failures and 0 warnings.
