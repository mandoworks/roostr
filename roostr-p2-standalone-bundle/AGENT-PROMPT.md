# Master Orchestrator Prompt: Roostr Standalone P2

Copy and paste the prompt block below into your active orchestrator or coding agent inside the `roostr` repository after extracting `roostr-p2-standalone-bundle.zip` at the repository root:

```text
Unzip roostr-p2-standalone-bundle.zip into the repository root (`unzip -o roostr-p2-standalone-bundle.zip -d .`), delete `roostr-p2-standalone-bundle.zip` and `HELP-ARGON.md` (and `AGENT-PROMPT.md` before final commit), and execute the Roostr Standalone P2 plan in `docs/orchestration-plan.md` and `docs/orchestration/tasks.json`.

Locked Architectural Decisions (Non-Negotiable):
1. Unified `roostrd` Control-Plane Daemon: `src/roostrd.js` owns `~/.roostr` state (`registry.json`, `approvals.json`, `decisions.jsonl`, `closed-sessions.jsonl`), the 10s RSS/Swapy sampler, the 30m idle reaper, and approval TTL sweeps, listening on `~/.roostr/roostrd.sock` (0600). `dashboard/src/app.js` mounts/proxies to `roostrd` behind the WebAuthn passkey gate. Keep read-only file fallback when `roostrd` is not running.
2. Herdr Demoted to Optional Viewer Adapter: Move `src/herdr.js` logic into `src/viewers/herdr.js` (`src/herdr.js` re-exports as a soft non-throwing shim when `herdr` is absent). Remove all hard `HERDR_ENV=1` or `herdr` binary requirements so `roostr` TUI, CLI, and `verify.sh` run 100% standalone when `herdr` is stopped or uninstalled.
3. Headless Approval Wait & Zero-RAM Hibernation: When a worker requests an approval (`POST /agents/api/approvals` or `roostr approval request`), `roostr approval wait` long-polls up to 60 seconds for fast `routine` checks. If still pending at 60s (or immediately for `big-decision`), it exits 0 so the heavy agent runtime frees 100% of its RAM while preserving `sessionId` in `registry.json` (`state: "waiting-approval"`, `hibernated: true`). When decided on the Web GUI or TUI, `roostrd` auto-resumes the worker headless via its `sessionId` with the decision injected.
4. Approval Governance & Chicken-Grill Escalation:
   - `routine`: Approvable by the primary human operator (passkey) or by the resident operator token (`Hermita`) on `host === "ovh"` ONLY. Mac `routine` approvals require human passkey session.
   - `big-decision`: Human passkey session ONLY (never token self-approved). Triggers Web Push / Pushover alerts + PioRelay notification to the lead orchestrator (`roman`), and includes an "Escalate to Chicken-Grill" action (`POST /agents/api/approvals/:id/grill`) that opens a Chicken-Grill spec session (`http://127.0.0.1:7433/api/v1/sessions`) and attaches the cooked spec back to the resumed worker.
5. Split `src/board.js` & Standalone Worker TUI: Refactor `src/board.js` into `src/board/{index,state,model,collect,render,views,viewer}.js` (keeping `src/board.js` as a barrel re-export so existing tests pass), add the collapsible split log-tail pane (`Enter` / `l`), interactive TTY attach (`i` -> `<tool> --session/--resume <id>`), `[A approvals]` tab, and `[S spawn]` drawer wired to `src/advisor.js` (`recommend`).

Execution Loop:
- Run Wave 1 packages in parallel (`pkg-p2-state-lock-and-hygiene`, `pkg-p2-approvals-engine-and-web`, `pkg-p2-board-split-and-tui-viewer`), then Wave 2 (`pkg-p2-spawn-drawer-and-advisor`, `pkg-p2-herdr-demotion-and-orchestrator`).
- Use the reference implementations in `docs/orchestration/reference-code/` as starting blueprints, remove `docs/orchestration/reference-code/` and `AGENT-PROMPT.md` once integrated, and verify that both `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh --public` pass with 0 failures.
```
