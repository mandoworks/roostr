# Task pkg-skill-sync

- Owner: Joaquin (`joaquin`), `gemini-4-hydrogen-low`, branch `crew/joaquin`
- Report: `docs/orchestration/reports/pkg-skill-sync.md` ending with `JOAQUIN_DONE` or `JOAQUIN_BLOCKED`

## Scope (touch ONLY `skills/roostr/SKILL.md`, `skills/roostr/references/schemas-and-config.md`, your report in repo, plus syncing `/home/ubuntu/workspace/skills-repo/roostr/`)

1. Update `skills/roostr/SKILL.md`:
   - Clarify `roostr` supersedes `crew-board` (`~/.roostr/` is the canonical state directory for board/ledger/sessions/backups).
   - Document `agy` Hydrogen workflow cleanly:
     - When starting `agy` in a fresh `.worktrees/<name>`, confirm the folder trust dialog (`herdr agent send-keys <name> enter`) and wait until `idle` before prompting.
     - Instruct `agy` workers never to background long verification commands (`./verify.sh`) and end turn early; wait for exit 0 synchronously before writing final reports.
     - Note keeping `~/.roostr/config.json` explicit for `agy` tiers if Hydrogen is the primary worker pool.
   - Ensure every CLI example (`roostr report`, `roostr tasks`, `roostr --json`, `roostr --all`, `roostr onboard`, `roostr workers`, `roostr handoff`, `roostr backups`) stays accurate against `bin/roostr` and `test/skill.test.js`.
2. Update `/home/ubuntu/workspace/skills-repo/roostr/SKILL.md` and `/home/ubuntu/workspace/skills-repo/roostr/references/schemas-and-config.md` to match repo `skills/roostr/` (do NOT touch `/home/ubuntu/workspace/skills-repo/secrets-management/SKILL.md`), verify `/home/ubuntu/workspace/skills-repo/crew-board -> roostr` symlink, and run `python3 /home/ubuntu/workspace/skills-repo/skills_manager.py sync`.
3. No em dashes (`—`) anywhere. Wait synchronously for `node --test test/skill.test.js` and `env -u HERDR_ENV ./verify.sh` to exit 0 BEFORE writing your report. Do not commit or push.

## Verification
```bash
node --test test/skill.test.js
env -u HERDR_ENV ./verify.sh
```
