# roostr v0.2.0 launch readiness

## Summary

Release roostr v0.2.0 as a public GitHub release/tag installable via Herdr, followed by a Herdr marketplace submission as a separate checklist-driven step. The supported release promise is the **observability core** only: live board (split/popup), exact/tinted/unknown reporting, crewfile checks with SHA-256 allow, pricing/guardrails, backups/restore, statusline integrations, and truthful optional tokscale spend/today data. Autonomous orchestration (daemon, Head Honcho/Secretary, grill intake, S/O/K/M/C crew controls) remains **gated orchestration** and is not part of the v0.2.0 promise; it is credited/planned for a later release when orchestration is ready. Release readiness requires a strict go/no-go gate: clean release commit/tag, green CI verify on Linux/macOS, local `./verify.sh` + `node --test test/*.test.js`, and manual Herdr 0.9.1+ smoke for the observability core. Release artifacts are a `v0.2.0` GitHub tag plus GitHub Release notes (scope, gated features, known limits, security/privacy, install/rollback, verification evidence, acknowledgements); no separate changelog file is required now.

## Terms

| Term | Definition | Avoid |
| --- | --- | --- |
| release | The specific artifact and channel announced as ready for others to install and use. | launch, ship it |
| v0.2.0 | Current plugin version declared in `herdr-plugin.toml`; release target for this plan. | MVP, beta |
| go/no-go gate | A concrete condition that must be true before announcing the release. | vibes, feels ready |
| observability core | Supported v0.2.0 surface: live board (split/popup), reporting, crewfile checks with hash allow, pricing/guardrails, backups/restore, statusline integrations; no autonomous orchestration promise. | full plugin, everything in README |
| gated orchestration | Daemon/Head Honcho/Secretary/grill automation code that exists but is not part of the v0.2.0 release promise; must be clearly marked experimental/disabled where surfaced. | supported crew automation |
| acknowledgement | A factual credit in README/release notes/marketplace copy naming a project or tool roostr builds on or is inspired by, with scope stated when relevant. | partnership, integration (for non-shipped items) |

## Why

The maintainer asked for a 10-person jury analysis of roostr's readiness to release this Herdr plugin. Evidence gathered from the repo:

- `herdr-plugin.toml` declares `id = "roostr"`, `version = "0.2.0"`, `min_herdr_version = "0.9.1"`, Linux/macOS, board split/popup panes, `pane.agent_status_changed` event hook, and `toggle-board`/`popup-board`/`restore-workspace` actions.
- `README.md` and `FEATURE-LIST.md` describe a shipped observability core (zero npm deps, Node 22, 408 tests claimed, split/popup board, 3-tier truthful data, guardrails, backups, statusline integrations) and list autonomous orchestration as gated for v0.3.0 pending live soak testing.
- README also prominently documents crew/orchestration workflows (Head Honcho, secretary, `roostr name/spawn/tasks/outcome`, setup keys `S/O/K/M/C`, grill intake). `src/board.js` and `src/grill.js` contain orchestration/grill UI/setup references.
- GitHub workflows exist: `.github/workflows/verify.yml` and `.github/workflows/release.yml`. No `CHANGELOG*` or release-notes files found.
- Working tree at analysis time had untracked `web/*` files (`index.html`, `script.js`, `styles.css`, `assets/`, `PLAN.md`, `plugin.json`, agent docs; ~3k lines for main web files), which conflicts with a clean release-commit gate unless intentionally handled.
- Attribution evidence: README already credits [tokscale](https://github.com/junhoyeo/tokscale) by Junho Yeo and `src/board.js`/today view show "via tokscale"/"data from tokscale by Junho Yeo"; `src/tokscale.js` provides the optional integration. `src/grill.js` references `grill-with-ui` (jasonku09/grill-with-ui) as a recommended runner, but no explicit README acknowledgement link was found. The maintainer requested shout-outs for tokscale and grill-with-ui, UI cleanup so only working things show, tokscale/grilling settings set appropriately, and noted grilling is for a later release when orchestration ships. Credit for Herdr was also specified.
- **A, GitHub release only, no marketplace submission:** Rejected because the maintainer explicitly wants marketplace submission included in the release target.

The jury's job is to turn these facts into explicit, auditable release decisions.

## Locked decisions

### q1. Release target (durable)
**Decision:** Public GitHub release/tag (`v0.2.0`) installable via `herdr plugin install mandoworks/roostr`, **plus** Herdr plugin marketplace/listing submission.

**Why:** The repo already targets public GitHub installation and has verify/release workflows. Marketplace submission increases discoverability for a Herdr plugin, but the process/requirements are not fully encoded in this repo; q5 resolves sequencing.

**Rejected options and why:**
- **A, GitHub release only, no marketplace submission:** Rejected because the maintainer explicitly wants marketplace submission included in the release target.
- **C, Limited/internal release first:** Rejected because the target is a public release; it would delay public availability and marketplace work without matching the chosen path.
- **D, Soft launch with no formal release process:** Rejected because it provides no auditable artifact, no clear rollback point, and weak support/expectation management.

### q2. Supported scope (durable)
**Decision:** **Observability-only release.** Supported: board, reports, backups, pricing/guardrails, crewfile hash-allow checks, statusline integrations, and truthful optional integrations that already work (tokscale). Orchestration commands/docs/controls are explicitly experimental/gated and **not** part of the v0.2.0 release promise.

**Why:** `FEATURE-LIST.md` already states orchestration is implemented/tested against mocks but gated pending multi-pane live soak testing. Shipping observability-only matches verified core behavior and avoids trust loss from users attempting unsupported automation. README/FEATURE-LIST/UI must be aligned to this promise before release.

**Rejected options and why:**
- **B, Observability + limited orchestration subset:** Rejected because even a "small supported subset" creates a support/QA surface that has not passed the same strict gate and live soak confidence as the observability core.
- **C, Full v0.2.0 as README currently documents:** Rejected because current README prominence for crew/orchestration workflows over-promises relative to gated/soak-pending status and would create scope mismatch.

### q3. Quality and verification gate (durable)
**Decision:** **Strict gate.** Required before tagging/announcing:
1. **Clean release commit/tag**: no unintended files; release state is deliberate.
2. **CI verify green** on Linux/macOS (`.github/workflows/verify.yml`).
3. **Local verification green**: `./verify.sh` and `node --test test/*.test.js`.
4. **Manual smoke in Herdr >= 0.9.1** for observability core only:
   - board split and popup open/close/toggle correctly;
   - agent/report ingestion shows truthful exact/tinted/`?` values (no invented numbers);
   - crewfile (`.roostr.toml`/legacy) is ignored until hash allowed, then checks run as expected;
   - backups view/restore path behaves safely (restore creates new workspace, does not touch old);
   - privacy/ops controls: `--no-update-check`/env disables update check; tokscale absent path degrades cleanly; no secrets read from env files/keys.
5. **Known issues documented** in GitHub Release notes.

**Why:** roostr executes crewfile commands after user hash allow and displays task/cost/project data. Safety, correctness, and trust require predictable behavior on supported platforms. The gate is strict but scoped to the observability core chosen in q2.

**Rejected options and why:**
- **B, CI-first gate with minimal local/manual smoke:** Rejected because Herdr UI behavior (split/popup, key handling, pane/report interactions, crewfile allow flow) is not fully proven by CI alone.
- **C, Best-effort/reactive fixes:** Rejected because public release + marketplace submission (q1) raises user expectations and makes avoidable regressions costly.

### q4. Packaging, `web/*`, and scope alignment (durable)
**Decision:** **Clean release.** Exclude untracked `web/*` from the v0.2.0 release commit (remove, ignore, or keep only in a separate branch/worktree; do not accidentally tag it). Edit README/FEATURE-LIST/docs to foreground the **observability core** and move orchestration to an explicit **Experimental / gated, not supported in v0.2.0** section with `enabled=false` caveats and future-release framing.

**Why:** q3 requires a clean release commit/tag. q2 makes observability the only supported promise, and q1/B means marketplace reviewers/users will read release claims. Excluding unfinished `web/*` avoids accidental scope creep; docs must match the actual support contract.

**Rejected options and why:**
- **B, Include `web/*` as release landing/docs site:** Rejected for this release unless separately verified as intentional, complete, tracker/secret-free, and in-scope; current state is untracked and not part of the strict gate.
- **C, Keep README mostly as-is and handle `web/*` later:** Rejected because it preserves over-promising and risks shipping/taging with ambiguous working-tree state.

### q5. Marketplace sequencing (durable)
**Decision:** **GitHub release first, marketplace second.** Tag `v0.2.0` after the strict gate passes, publish GitHub Release notes, then submit to the Herdr marketplace as a follow-up with an explicit checklist. Announce marketplace availability only after submission/listing is complete.

**Why:** It delivers a concrete GitHub artifact and rollback point while acknowledging marketplace requirements/assets may not be fully encoded in the repo. It preserves q1's intent without blocking the release on unknown process details.

**Rejected options and why:**
- **A, Block GitHub release on marketplace readiness:** Rejected because marketplace requirements are not yet confirmed in-repo; blocking could delay a ready GitHub artifact unnecessarily.
- **C, Treat marketplace as optional/unknown with no checklist:** Rejected because q1 explicitly includes marketplace submission; omitting a checklist makes the commitment vague.

### q8. UI and settings cleanup (durable)
**Decision:** **Observability-first UI.** Default/released UI shows only working, supported observability surfaces. Hide orchestration keys/menu entries (`S/O/K/M/C`) and grill setup rows in the released observability mode. Keep orchestration code gated for future release. Keep **tokscale** as an optional auto-detected integration with truthful fallback behavior and existing attribution; never show fake spend/today data.

**Why:** UI is part of the release contract. Hiding unsupported automation matches q2/A better than disclaimers alone (q1/B marketplace visibility). tokscale is already optional and has truthful degradation.

**Rejected options and why:**
- **B, Show all controls but mark experimental/disabled:** Rejected because visible controls still invite exploration/support burden and weaken the observability-only signal.
- **C, Keep current UI and rely on docs:** Rejected because users interact with the UI first; docs-only caveats do not prevent over-promising.

## Routine choices

### q7. Attribution placement and wording
**Decision:** Add a README **Acknowledgements** section and include the same credits in GitHub Release notes and Herdr marketplace submission copy. Keep existing in-UI tokscale attribution where it appears.

**Required credits:**
- **[Herdr](https://herdr.dev)**: runtime platform roostr is built for/runs on (factual dependency credit).
- **[tokscale](https://github.com/junhoyeo/tokscale)** by **Junho Yeo**: optional spend/today data integration shipped/usable in v0.2.0; credit existing behavior, no fake data when absent.
- **[grill-with-ui](https://github.com/jasonku09/grill-with-ui)** by **jasonku09**: inspiration/reference for future orchestration intake; **not a supported v0.2.0 feature** (grilling deferred to later orchestration release).

**Wording guardrails:** keep credits factual. Do not imply endorsement, partnership, or that grill-with-ui/orchestration is supported in v0.2.0. Do not describe tokscale as required.

## Verified facts

- roostr is a Herdr plugin (Node 22, zero npm dependencies, no build step) targeting Linux/macOS, `min_herdr_version = "0.9.1"`.
- Plugin actions/panes include split board, popup board, backups/restore workspace popup, and toggle actions; status event hook records agent status changes.
- `verify.sh`, `node --test test/*.test.js`, and GitHub `verify.yml`/`release.yml` workflows exist.
- `FEATURE-LIST.md` claims 408 tests and describes orchestration as gated behind `[orchestration] enabled = false` pending live soak testing.
- README already credits tokscale and links it; `src/board.js`/`src/tokscale.js` contain tokscale integration/attribution behavior. `src/grill.js` and board setup code reference `grill-with-ui`/grill controls.
- Untracked `web/*` files were present during analysis and must be handled before a clean release tag.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| README/UI still imply supported orchestration | Users try gated workflows, hit rough edges, file support issues | Apply q4/q8 before release: observability-first docs and hidden orchestration controls; explicit "Experimental / gated, not supported in v0.2.0" copy where code/docs remain |
| `web/*` accidentally included or release tagged from dirty tree | Confusing artifact contents, unfinished site shipped, non-auditable release | Apply q3/q4: decide exclude/ignore/separate branch; require clean release commit/tag; verify `git status` before tag |
| Marketplace requirements differ from assumptions | Submission blocked or listing copy rejected | Apply q5: GitHub first, marketplace checklist second; align copy/assets to observability-only scope and required disclosures |
| Herdr/manual smoke gaps on one platform | Install/UI regressions after public release | Run strict manual smoke on Herdr >= 0.9.1 for split/popup/report/crewfile allow/backups; document tested versions in release notes |
| Crewfile command execution misunderstood | Security concern from reviewers/users | Keep SHA-256 allow-before-run behavior; document crewfile-as-code risk clearly in README and Release notes |
| Attribution wording overstates grill-with-ui | Scope confusion | Use q7 wording: inspiration/future orchestration intake, not supported in v0.2.0; credit Herdr/tokscale factually |

## Deferred

- **Herdr marketplace submission execution (q5 follow-up):** deferred until after GitHub `v0.2.0` release passes the strict gate. Reopen when the GitHub tag/release notes are published; create a submission checklist covering marketplace metadata, icons/screenshots/assets if required, support/contact, security/privacy copy, observability-only scope, and acknowledgements (Herdr, tokscale, grill-with-ui as future credit).
- **Autonomous orchestration support (daemon, Head Honcho/Secretary, grill intake UI):** deferred to a later release. Reopen after multi-pane live soak testing, UI re-exposure plan, docs/support plan, and verification gates for orchestration are defined. Grilling settings/UI remain hidden/gated for v0.2.0.
- **`web/*` landing/site decision:** deferred as a separate packaging decision from the plugin release. Reopen only if/when the site is intentionally reviewed (no secrets/trackers), scoped, and released through an explicit path.

## Open threads

- **Exact Herdr marketplace requirements/assets:** not verified from repo contents during this session. The marketplace follow-up checklist must confirm required metadata fields, icon/screenshot/GIF formats, categories/tags, support contact, and privacy/security disclosures.
- **Test-count claim:** `FEATURE-LIST.md` states "408 tests". The strict gate should use actual passing results from `./verify.sh` / `node --test test/*.test.js` / CI as evidence; release notes may report the verified count rather than carrying a stale claim.
- **Version string consistency for CLI/help surfaces:** `herdr-plugin.toml` declares `0.2.0`. A final release pass should confirm any user-visible version/help output matches the tagged release.
