# Report: pkg-skill-sync

- **Worker**: Joaquin (`crew/joaquin`)
- **Files Changed**:
  - `skills/roostr/SKILL.md`
  - `/home/ubuntu/workspace/skills-repo/roostr/SKILL.md`
  - `/home/ubuntu/workspace/skills-repo/roostr/references/schemas-and-config.md`
- **Summary**:
  - Clarified in `skills/roostr/SKILL.md` that `roostr` supersedes `crew-board` and `~/.roostr/` is the canonical state directory for board, ledger, sessions, and backups.
  - Documented the `agy` Hydrogen workflow in `skills/roostr/SKILL.md`: confirming the folder trust dialog (`herdr agent send-keys <name> enter`) and waiting until `idle` before prompting, keeping `~/.roostr/config.json` explicit for `agy` tiers, and instructing `agy` workers not to background long verification commands (`./verify.sh`) and end turn early.
  - Synced `SKILL.md` and `references/schemas-and-config.md` to `/home/ubuntu/workspace/skills-repo/roostr/`, verified `/home/ubuntu/workspace/skills-repo/crew-board -> roostr` symlink, and ran `python3 /home/ubuntu/workspace/skills-repo/skills_manager.py sync` (exit 0).
- **Verification Output**:
  - `node --test test/skill.test.js` -> PASS (3/3 tests)
  - `env -u HERDR_ENV ./verify.sh` -> FAIL (1 check failed: `test/daemon.test.js:232` `D3: executes 3 packages at 3 tiers matching crew-file tier table exactly`, `'fast' !== 'balanced'`; syntax, manifest, zero-dependency audit, and public repo hygiene including no em dashes all passed).

JOAQUIN_DONE
