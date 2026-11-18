# PLAN: Community leaderboards and arena read path

Implements `docs/leaderboards-design.md` (grill-shaped MVP). Goal: help community members choose `agent/tool + model + effort` by task kind using sanitized Roostr arena outcome data.

## Scope (locked)

- `roostr-web` (`/Users/puntopio/Git Repos/roostr-web`): static `/leaderboards` page, same-origin JSON read path, SEO/nav updates.
- `mandoworks/roostr` (this repo): lightweight board entry point only (discoverability/copyable explicit import workflow). No full leaderboard tab.
- No live submission ingestion, no durable aggregation, no placeholder upload endpoint, no automatic fetch/import, no required CLI behavior changes for MVP.

## Data contract

- **Canonical source:** `arena/summary.json` in `roostr-web`, sanitized arena payload (`schema: 1`) with aggregate buckets keyed by `kind, tool, model, effort` and counts: `runs`, `firstTryPasses`, `passRate`, `reworkSum/avgRework`, `costUsdSum/avgCostPerPassUsd`, `avgDurationSec` (and allowed metadata such as `generatedAt`, `days`, `anonId`, provenance label).
- **Derived artifact:** `arena/global-summary.json` (or `by_kind_model` shape accepted by `roostr` `summaryFromPayload()`), generated from the canonical seed by a small Node script (Node builtins only). Document the derivation command.
- **Privacy:** never include repo names, file paths, task titles, pane names, prompts, transcripts, screens, or env vars. Client-side shape check validates sanitized shape only and posts nothing.
- **Provenance:** label bootstrap/curated data clearly; show `generatedAt`, data window, and “not live community aggregation”.

## Phase 0: Decisions and fixtures

1. Confirm published paths in `roostr-web`:
   - buckets: `/arena/summary.json` (UI source of truth)
   - global summary: `/arena/global-summary.json` (import/read-path compatible)
2. Create a curated bootstrap seed fixture with representative, sanitized buckets covering multiple `kind`/`tool`/`model`/normalized `effort` values (including at least one `max` case and one low-sample case) and explicit provenance metadata.
3. Add `scripts/derive-arena-global-summary.mjs` (or similar) in `roostr-web`:
   - input: canonical `arena/summary.json`
   - output: derived `arena/global-summary.json`
   - reuse/align with Roostr `summaryFromPayload` normalization rules where practical; no npm deps.

**Acceptance:** canonical seed is human-reviewable/sanitized; derived file regenerates deterministically from canonical seed.

## Phase 1: `roostr-web` leaderboard page

Target files (in `/Users/puntopio/Git Repos/roostr-web`):
- `leaderboards.html`
- `leaderboards.js`
- `arena/summary.json` (canonical)
- `arena/global-summary.json` (derived)
- `index.html` (nav/footer link)
- `sitemap.xml` (add `/leaderboards`)
- `README.md` or `docs/` note for data refresh/derivation (optional, small)

### UI sections
1. **Hero/stats:** what is measured (first-try pass = pass with `rework == 0`, rework, $/pass, duration), `generatedAt`, data window, provenance, tuple count/runs/models/tools summary, and an explicit “explicit import, not automatic” note.
2. **Task/priority recommender (primary):** controls for `kind` and priority (`Balanced value`, `Max first-try pass`, `Lowest $/pass`, `Fastest`). Default ranking requires minimum run count (target `>= 5` for recommendation confidence, configurable constant in JS) and pushes low-sample tuples below with warning. Output: top tool/model/effort, rationale, sample count/confidence, metrics, and copyable guidance (no auto-execution).
3. **Effort sweet-spot view:** compare normalized efforts (`low|medium|high|max`) for selected kind and selected/filtered tool+model; map `xhigh`→`max`, keep `unknown` visible but excluded from recommendations/sweet-spot picks. Show pass rate, $/pass, avg rework, duration, deltas, and badges (`Sweet spot`, `Overkill risk`, `Low sample`) where data supports them.
4. **Sortable/filterable table:** rank, kind, tool, model, effort, runs, first-try pass, avg rework, $/pass, avg duration. Filters: kind, tool, effort. Sort: pass rate, $/pass, rework, runs, duration. Low-sample rows remain visible with warning.
5. **Use in Roostr (read path):** exact explicit steps:
   - download/save published global summary (`/arena/global-summary.json`)
   - run `roostr arena import --from <file>`
   - state that import is user-initiated and writes local Roostr advisor/global summary state
6. **Contribution guidance (read-only):** explain `roostr arena export --json` and privacy boundary; provide client-side JSON shape check only (no upload, no network POST, no submit endpoint). Link to GitHub/repo docs as needed.

### Behavior/quality
- Fetch same-origin `arena/summary.json` at runtime; visible loading/error state on failure (no silent fallback that hides staleness).
- Responsive at 360px+; match existing Roostr dark terminal aesthetic and CSS tokens.
- No em dashes or hyphens dividing clauses in prose/copy; sentence case headings.
- Vanilla HTML/CSS/JS, zero npm deps/build step.

**Acceptance:** page loads from local static server and from Vercel deploy; recommender/table/sweet-spot compute from buckets; low-sample handling visible; import instructions accurate; shape checker validates locally without network calls.

## Phase 2: `mandoworks/roostr` lightweight board entry point

Target areas (investigate before editing; keep minimal):
- `src/board.js` help/menu/footer or a small command/keybind affordance
- `src/arena.js` help text only if it improves discoverability (optional)
- `docs/reference.md` (and README if needed) to document the explicit read path

### Implementation
1. Add a lightweight entry point (not a full tab) that surfaces:
   - public page: `https://roostr.mando.works/leaderboards`
   - global summary URL/path: `https://roostr.mando.works/arena/global-summary.json`
   - explicit import command: `roostr arena import --from <file>`
   - note: explicit, not automatic; user downloads/saves file and chooses when to import.
2. Keep it low-risk: no network fetch/import in board code, no background tasks, no new persistent state beyond existing behavior.
3. If a keybind/command is added, update help text and tests that assert help/command output.

**Acceptance:** users can discover the read path from the board/help flow; no automatic data pull/import; existing board behavior unchanged otherwise.

## Phase 3: Verification

### `roostr-web`
- `node --check leaderboards.js` and `node --check scripts/derive-arena-global-summary.mjs` (if added).
- Run derivation script and confirm `arena/global-summary.json` updates from canonical seed.
- `python3 -m http.server 8080` (or equivalent) smoke test: `/leaderboards` loads, JSON fetch works, filters/sorts/recommender/sweet-spot/shape-check work, no console errors.
- Confirm `index.html` nav/footer links and `sitemap.xml` include `/leaderboards`.
- Confirm no secrets/private paths and no em dashes/hyphens dividing clauses in new prose.

### `mandoworks/roostr`
- `./verify.sh` (all checks pass).
- If help/CLI text changed, run targeted tests and confirm snapshots/expectations as needed.

## Phase 4: Release workflow (only after explicit confirmation)

1. `roostr-web`: review diff, commit with Conventional Commit (e.g. `feat(leaderboards): add arena leaderboard read path`), push only if requested, deploy:
   ```sh
   cd /Users/puntopio/Git\ Repos/roostr-web
   vercel deploy --prod --yes
   ```
2. `mandoworks/roostr`: if board entry point/docs changed, follow normal repo workflow (branch/commit/PR or direct main only if explicitly requested), run `./verify.sh`, release/version bump only as requested.
3. Post-deploy checks: `https://roostr.mando.works/leaderboards`, `/arena/summary.json`, `/arena/global-summary.json`, nav link, sitemap entry.

## Deferred (do not implement in MVP)

- Full Roostr board leaderboard tab or guided in-TUI fetch/import UI.
- `roostr arena pull --url` or URL-capable import.
- Review-only contribution workflow (issue/PR/copy flow).
- Live upload/submit endpoint, durable storage, merge/aggregation, moderation/rate limits, consent/abuse controls.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Sparse data misleads users | Minimum-run default ranking (target 5), low-sample warnings, visible counts/confidence, provenance labels. |
| Bootstrap seed mistaken for live community data | Prominent “curated/bootstrap seed, not live aggregation” labels and `generatedAt`/window. |
| UI/global-summary contract drift | One canonical buckets file; derived global summary generated from it. |
| Effort normalization distorts sweet spots | Explicit `low/medium/high/max`, map `xhigh`→`max`, exclude `unknown` from recommendations/picks. |
| Privacy regression in future ingestion | MVP read-only/client-side checks only; no upload endpoint; future ingestion must allowlist schema 1 bucket fields. |
| Automatic import erodes trust | No background fetch/import; board/web copy states explicit user action and local state impact. |
