# Orchestration plan: Roostr Standalone P1 (Execution Decoupling + Section 6 Monitor Board)

Four parallel Hydrogen (`agy`) workers supervised by `roosty-argon` in `/home/ubuntu/workspace/roostr`.
Spec: `docs/roostr-standalone.md` + `docs/spawn-policy.md` (`8c9ce8c`). Keep repo off public remotes.

## Goal and done check

1. **Registry, Token Auth & Resource Governor (`pkg-p1-registry-governor`)**:
   - `src/registry.js` (`~/.roostr/registry.json`, `tokens.json`, `closed-sessions.jsonl`), `src/governor.js` (Mac `maxLivePanes=3`, swap threshold, OVH-by-default placement, 30m idle reaper, Swapy PID+command reap), and `bin/roostr` (`registry`, `governor`, `run`).
2. **Detached Headless Runner (`pkg-p1-headless-runner`)**:
   - `src/runner.js` (`roostr run`): detached execution (`< /dev/null`, `unref()`), log capture (`~/.roostr/logs/<id>.log`), PID/command/session capture, OVH `VmRSS` sampling, and health refresh.
3. **Section 6 Monitor Board (`pkg-p1-monitor-board`)**:
   - `src/board.js`: join `herdr` panes + `~/.roostr/registry.json` headless workers + RAM/swap census (`PhysMem free`, `swap used`), graceful `herdr`-stopped mode, and RAM sorting (`--sort ram` / `M`).
4. **Web Registry, RAM Monitor & Reap API/UI (`pkg-p1-web-registry-api`)**:
   - `dashboard/src/registry-bridge.js`, `dashboard/src/app.js`, and `dashboard/public/control/`: `/agents/api/register`, `/agents/api/status` (`X-Roostr-Token` or passkey), `/agents/api/registry`, `/agents/api/registry/:id/log`, `/agents/api/registry/:id/reap`, and sortable RAM monitor table in `/agents/control/`.
5. **Done check**:
   - All 4 branches pass `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` with 0 failures, merge into `main`, deploy to `/home/ubuntu/roostr-dashboard/`, and pass the P1 standalone verification (`herdr` stopped test + evidence report to `roman`).
