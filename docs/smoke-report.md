# Roostr v0.2.0 Manual Herdr Smoke Report

Date: 2026-11-07  
Platform: macOS Darwin 24.3.0 (arm64, Apple Silicon)  
Herdr Version: Herdr 0.9.1+  
Environment: `HERDR_ENV=1`, live multi-agent swarm across 7 workspaces, 23 panes  
Tester: Antigravity (lead agent)  
Result: ALL CHECKS PASSED  

---

## 1. Test Matrix & Results

| Check | Item | Observed Result | Pass/Fail |
| --- | --- | --- | --- |
| 1 | Board split and toggle | Split pane toggles cleanly via `roostr`, displays multi-workspace agent rows, load averages, usage bars, and footer counts. | PASS |
| 2 | Popup board | Overlay popup launches via action `roostr.popup-board`, dismisses cleanly on `q` or `Esc`. | PASS |
| 3 | Report truthfulness | Exact reports (`w23:p2`, `w23:p3`) display exact tokens, costs, models; uninspected panes render `?` without guessing numbers; screen-scraped values show visual tint. | PASS |
| 4 | Crewfile SHA-256 allow | `.roostr.toml` with custom checks is marked unallowed until user presses `a` to approve content hash. Command execution runs through `execFile` without shell invocation. | PASS |
| 5 | Backups and restore safety | Workspace layouts saved under `~/.roostr/backups` across 7 active workspaces (14 snapshots); restore path creates a new `*restored` workspace without mutating existing panes. | PASS |
| 6 | Privacy and update checks | `--no-update-check` and `ROOSTR_NO_UPDATE_CHECK=1` prevent network calls; tokscale absent degrades cleanly; no `.env` or home credentials read. | PASS |
| 7 | Context compaction indicators | Panes under 30% render dim text; panes between 30% and 49% show warm cyan text; detail box offers `/compact` advice on panes reaching 50%+. | PASS |
| 8 | Options view | Key `o` opens options view showing Tokscale connectivity (`~/.local/bin/tokscale`), compaction thresholds, board toggles, and storage paths. | PASS |

---

## 2. Live Session Evidence

```
Total workspaces active: 7 multi-agent workspaces
Total agent panes: 23 (1 working, 22 idle, 0 blocked, 0 done)
Total cost recorded: $5.75
Usage limits: agy other, agy gemini (57%), agy gemini-argon-wtu
Backups saved: 14 snapshots verified in ~/.roostr/backups
Memory tracking: ps RSS tree sums verified per pane (78M to 329M)
```

---

## 3. Conclusion

The observability core is fully operational and adheres to truthful data guarantees inside Herdr >= 0.9.1.
