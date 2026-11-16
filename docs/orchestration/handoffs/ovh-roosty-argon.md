# OVH Lead Handoff: roosty-argon

You are `roosty-argon` running directly on `ovh` (`/home/ubuntu/workspace/roostr`), continuing from the Mac `roosty-argon` session so Armando can reboot his laptop safely.

## Active worker crew in this workspace

1. `santiago` (`crew/santiago`, `.worktrees/santiago`, `gemini-4-hydrogen-high`): `pkg-cli-consolidate`
2. `pablo` (`crew/pablo`, `.worktrees/pablo`, `gemini-4-hydrogen-medium`): `pkg-ui-audit-fixes`
3. `joaquin` (`crew/joaquin`, `.worktrees/joaquin`, `gemini-4-hydrogen-low`): `pkg-skill-sync`

## Your duties until done

1. Monitor `santiago`, `pablo`, and `joaquin` via `herdr agent wait` / `herdr agent get` / `herdr agent read`.
   - Remember: `agy` may enter `done` while a >10s command like `./verify.sh` is still running in its footer (`running`) without writing its report; check `docs/orchestration/reports/<id>.md` inside each worktree and nudge once if needed.
   - If a worker hits a safe workspace prompt inside its worktree, inspect with `herdr agent read <name> --source detection --lines 25` first.
2. When all 3 finish (`SANTIAGO_DONE`, `PABLO_DONE`, `JOAQUIN_DONE`):
   - Review `git -C .worktrees/<name> diff` against each brief `owns` list.
   - Commit each worker branch cleanly and merge all 3 into `main` in `/home/ubuntu/workspace/roostr`.
   - Update `docs/orchestration/tasks.json` statuses to `done` and commit.
   - Run `(cd dashboard && npm test)` and `env -u HERDR_ENV ./verify.sh` on merged `main` (only report passing if run after final edit with 0 failures).
3. Deploy & sync on OVH:
   - `rsync -av --delete --exclude node_modules --exclude package-lock.json --exclude .git /home/ubuntu/workspace/roostr/dashboard/ /home/ubuntu/roostr-dashboard/` and `systemctl --user restart roostr-dashboard.service` (verify `/agents/` and `/agents/names.html` return 302).
   - Verify `/home/ubuntu/workspace/skills-repo/roostr/` matches `skills/roostr/` and `python3 /home/ubuntu/workspace/skills-repo/skills_manager.py sync` succeeded.
   - Verify `~/.crew-board/` -> `~/.roostr/` migration state cleanly without breaking `roostr-publish.timer`.
   - Record outcomes in `~/.roostr/orchestration.jsonl` via `roostr outcome` / `src/ledger.js` and run `roostr summary`.
   - Retain key architecture/consolidation decisions in MuseSight bank `coding-agent::roostr` (`http://127.0.0.1:8888`, tags `project:roostr,host:ovh,agent:roosty-argon`) and record `Memory: ... facts before->after`.
   - Close worker panes, remove `.worktrees/{santiago,pablo,joaquin}` and merged `crew/*` branches.
4. Report final completion to `roman` on PioRelay (`http://100.123.63.122:3016/api/v1/agent-messages`, `from: "roosty"`, `kind: "report"`, `project: "roostr"`) and let Armando know local Mac `main` can pull or `main` can push to GitHub when he confirms.
5. Never print secrets or use em dashes (`—`) in prose.
