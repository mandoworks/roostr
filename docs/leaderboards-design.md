# Roostr community leaderboards and agent/effort advisor

Design for `https://roostr.mando.works/leaderboards` (public read path) and a lightweight Roostr board entry point that makes the read path discoverable without automatic imports. The feature turns sanitized Roostr arena outcome data into guidance for choosing `agent/tool + model + effort` by task kind.

## Summary

MVP ships a static leaderboard page on `roostr-web` with a curated, clearly labeled bootstrap seed (sanitized arena buckets as the canonical source, plus a derived advisor-compatible global summary). The page fetches committed same-origin JSON, ranks tool/model/effort tuples for a selected task kind and priority, shows an effort sweet-spot view, provides a sortable/filterable table, and explains how to use the data in local Roostr with an explicit download/save plus `roostr arena import --from <file>` flow. No live submission ingestion, no durable aggregation, no automatic pull/import, and no placeholder upload endpoint in MVP. The Roostr board gets a lightweight entry point (not a full leaderboard tab) that surfaces the same explicit import workflow. Live community ingestion (upload, validation service, durable storage, merge, abuse controls) is follow-up work.

## Terms

- **arena payload**: Sanitized Roostr export (schema 1): aggregate buckets keyed by kind, tool, model, effort with run/pass/rework/cost/duration counts plus a truncated host hash. Avoid: raw ledger, telemetry dump.
- **first-try pass**: An outcome counted as successful on the first attempt (pass with zero rework), the primary quality signal in Roostr arena/summary data. Avoid: pass rate (ambiguous without the first-try/rework definition in copy).
- **global summary**: Advisor/import-compatible aggregation derived from arena buckets (`by_kind_model` style accepted by `summaryFromPayload()`), used by `roostr arena import --from <file>`. Avoid: UI summary.

## Why

Roostr already collects local empirical outcome telemetry (first-try pass, rework, cost, duration) by task kind, tool, model, and effort. Unlike raw token-spend leaderboards, this data can help community members decide which agent CLI, model, and effort level to use for a specific kind of task, and where higher effort has diminishing returns. The data is useful only if it is presented with clear provenance, sample-size honesty, and privacy boundaries, and if local Roostr can consume a compatible prior explicitly.

## Locked decisions

### q1 (durable): MVP scope for `/leaderboards`
**Decision:** B, static page plus a published advisor-compatible JSON file that users can fetch and import into local Roostr (read path, no submissions).

**Why chosen:** It delivers immediate community value (compare agent/model/effort and pull priors into local Roostr) while staying within `roostr-web`'s static/low-risk model.

**Rejected:**
- A (static page with curated seed only, no import file): misses the path that makes the data actionable in the CLI.
- C (read JSON plus `roostr arena pull` CLI command): adds CLI work before the web contract is proven.
- D (full flow with submission endpoint and durable aggregation): introduces durable storage, moderation, and privacy/abuse risk that must be scoped separately.

### q2 (durable): Primary decision the page should optimize for
**Decision:** B, "Which agent/tool + model + effort is best for this task kind?" (tool is first-class).

**Why chosen:** Roostr users run multiple agent CLIs in Herdr, so tool choice is part of the real decision. The page can still answer model/effort and expose value metrics.

**Rejected:**
- A (model and effort only, tool as context): hides a key variable.
- C (personal comparison first): requires a user export flow and is less useful cold.
- D (cost/performance tradeoff first): useful but narrower than the main orchestration question.

### q3 (durable): Default ranking when samples are limited
**Decision:** B, show all tuples; default ranking requires a minimum run count (configurable, default target 5 where aligned with arena/advisor behavior) and pushes low-sample rows below with a warning.

**Why chosen:** It preserves transparency while preventing tiny samples from winning the default recommendation. It matches existing arena/advisor minimum-sample intuition.

**Rejected:**
- A (show all, rank normally): too easy to misread.
- C (hide below minimum from recommendations/top ranks): hides potentially useful early signals.
- D (confidence-adjusted score): harder to explain and audit in a static v1.

### q4 (durable): Published JSON contract for the read path
**Decision:** D, publish one canonical sanitized arena buckets payload and also emit a derived global summary in-repo (one canonical source plus derived artifact).

**Why chosen:** One canonical sanitized seed avoids drift between the UI and the CLI import file. Buckets carry the richest safe data for the leaderboard (including effort). The derived global summary preserves `roostr arena import --from <file>` compatibility through `summaryFromPayload()`.

**Rejected:**
- A (buckets only): makes CLI import awkward.
- B (`by_kind_model` global summary only): loses per-effort buckets needed by the UI.
- C (both, but not explicitly one canonical source): acceptable only if generation enforces a single source of truth; D states that constraint.

### q5 (durable): Leaderboard data source and freshness behavior
**Decision:** A, fetch a committed JSON file from the same origin at runtime (for example `/arena/summary.json`) with a clear generated-at/data-window label; fail with a visible offline/error state.

**Why chosen:** Same-origin committed JSON keeps the static deployment model, supports normal file refreshes, and enables a stable public URL for future CLI compatibility. The UI can show `generatedAt`/`days`/seed provenance honestly.

**Rejected:**
- B (inline seed data in JS/HTML): simpler but harder to update and less import-friendly.
- C (fetch with inlined fallback): can hide staleness/fetch problems.
- D (configurable remote URL): adds configuration surface before there is a trusted remote source.

### q6 (durable): Effort taxonomy normalization in the UI
**Decision:** B, canonicalize to `low|medium|high|max`; map `xhigh` to `max`; keep `unknown` visible but excluded from recommendations/sweet-spot picks.

**Why chosen:** It preserves the useful distinction between `high` and `max` for diminishing-returns analysis while normalizing `xhigh` and isolating `unknown`.

**Rejected:**
- A (collapse to `low|medium|high`): loses a meaningful tier.
- C (show raw values): makes comparisons noisy.
- D (canonical ranking plus raw label in details): useful later, but adds complexity now.

### q7 (durable): How users get published data into local Roostr
**Decision:** A, MVP instructions use download of the published global summary file plus `roostr arena import --from <file>`; no CLI changes.

**Why chosen:** It matches the locked MVP and uses an already-working CLI command. The flow is explicit, which is best practice for fetching community data that writes local Roostr state (`global-summary.json` path used by arena/advisor).

**Rejected:**
- B (`roostr arena pull --url`, defaulting to roostr.mando.works): useful later, but adds cross-repo CLI work and testing before the contract is proven.
- C (extend `arena import --from` to accept `https://` URLs): smaller than B, still CLI/release/testing surface outside MVP.
- D (web-only copy/download steps, vague): less concrete than A.

### q10 (durable): Roostr board (TUI) UI for leaderboards/arena priors
**Decision:** C, add a lightweight board entry point only (keybind/command/help affordance that points to the published URL/file workflow and/or copies the import command), not a full leaderboard tab.

**Why chosen:** It respects the Roostr UI-first workflow and makes the read path discoverable without a full cross-repo TUI leaderboard implementation before the contract is validated. The web page remains the public static source of truth.

**Rejected:**
- A (web only, capture board tab as follow-up): ignores the UX feedback that the board should help.
- B (full board tab/view with guided import/apply): better end state, but larger and riskier for MVP.
- D (board primary, web secondary): conflicts with the locked web read path.

### q12 (durable): Resolve contribution scope vs locked MVP
**Decision:** A, confirm MVP as q10=C lightweight board entry point plus q11=A read-only contribution guidance with client-side shape check; live upload/ingestion is follow-up work (q1 unchanged).

**Why chosen:** It preserves locked decisions, delivers the core value, and avoids server-side ingestion complexity before storage and abuse controls exist.

**Rejected:**
- B (review-only contribution UX): reasonable compromise later, but adds workflow/process decisions.
- C (reopen q1 for real submission flow): right for real ingestion, but a separate design/infra project (endpoint, durable storage, validation, rate limits, consent).
- D (disabled “coming later” form/copy only): no backend, but can still confuse users and implies missing capability.

## Routine choices

- **q8 (A):** Full MVP page sections: hero/stats, task+priority recommender, effort sweet-spot view, sortable/filterable full table, and a read-path "use in Roostr" section.
- **q9 (A):** Commit a clearly labeled curated bootstrap seed (representative sanitized buckets) plus a small Node script/dev docs to regenerate the derived global summary from the canonical seed.
- **q11 (resolved to A):** Read-only contribution guidance. Explain `roostr arena export --json`, privacy boundaries, and import contract; provide a client-side JSON shape check only (no upload, no network post, no submit endpoint).

## Verified facts

- `roostr-web` is a static site (no build step; `index.html`, `styles.css`, `script.js`, assets, `robots.txt`, `sitemap.xml`, `vercel.json` with `cleanUrls`/`trailingSlash` settings) deployed on Vercel; canonical domain is `https://roostr.mando.works/`.
- `roostr` arena/ledger code already sanitizes exports and carries only aggregate outcome data for arena payloads (schema 1 buckets with kind/tool/model/effort and outcome/count/cost/duration aggregates plus truncated host hash). It explicitly avoids repo names, file paths, task titles, pane names, prompts, transcripts, and screens in the sanitized payload design.
- `roostr arena` CLI currently supports share/export/import-from-file; `import --from <file>` accepts payloads handled by `summaryFromPayload()` (buckets or `by_kind_model` style summary). There is no current `arena pull --url` or live submit command.
- `roostr` advisor can use a global arena summary as a community prior when local data is sparse (minimum-sample/community fallback behavior exists in arena/advisor code paths).
- Core effort constants in ledger/arena are `low|medium|high`; advisor/other flows may encounter `max/xhigh`-like values, so UI normalization must be explicit (locked: `low|medium|high|max`, map `xhigh` to `max`, `unknown` visible but excluded from recommendations/sweet-spot picks).
- A static read path is compatible with Vercel static hosting; live submission ingestion/durable aggregation is not solved by static hosting alone and requires approved storage, validation, rate limits, and abuse controls.

## Risks

- **Misleading recommendations from sparse data:** mitigated by minimum-run default ranking, low-sample warnings, and showing sample counts/confidence cues.
- **Seed provenance confusion:** bootstrap/curated data can be mistaken for live community aggregation; mitigate with prominent labels (`generatedAt`, data window, bootstrap/curated provenance, no live ingestion).
- **Contract drift:** UI buckets and importable global summary can diverge; mitigate with one canonical seed file and a committed derivation script/process.
- **Effort normalization errors:** collapsing or mislabeling `max/xhigh/unknown` can distort sweet-spot analysis; mitigate with explicit normalization rules and tests/fixtures when implemented.
- **Privacy regression in future contribution flows:** live ingestion can accidentally accept sensitive fields; mitigate by keeping MVP read-only, and requiring strict server-side allowlists/validation and no raw ledger uploads if/when ingestion is designed.
- **Scope creep into automatic imports:** fetching/writing local advisor priors without explicit user action reduces trust and debuggability; keep import explicit (download/save + `arena import --from <file>` or later explicit pull command).

## Deferred

- **Full Roostr board leaderboard tab / guided in-TUI fetch-and-import UI (q10 follow-up):** implement after the web/JSON contract is validated. Would build on the same global summary contract and must remain explicit (no background auto-import).
- **`roostr arena pull --url` or URL-capable import (q7 follow-up):** CLI ergonomics improvement for the read path. Defer until contract and default URL/provenance are stable; require explicit user invocation and clear overwrite/source messaging.
- **Review-only contribution workflow (q11 option B):** export preview/copy or GitHub issue/PR submission path without automated ingestion. Revisit if maintainers want a stronger CTA without building backend ingestion.
- **Live community submission/aggregation (q11 option C / q1 option D):** requires approved durable storage, schema allowlist validation (arena buckets only), payload size/rate limits, abuse controls, consent/privacy copy, merge/curation logic, and observability. Vercel static/serverless filesystem alone is not sufficient for durable aggregation.

## Open threads

- **Exact file paths in `roostr-web`:** plan assumes canonical buckets at `/arena/summary.json` and derived global summary at `/arena/global-summary.json` (or equivalent stable paths). Confirm final paths during implementation to match nav/sitemap/import instructions.
- **Derivation script location:** q9 locks "small Node script in-repo/dev docs" for deriving global summary from canonical buckets. Place in `roostr-web` (static site repo) as a maintenance script using Node builtins only, and document its usage; keep no npm deps/build step.
- **Seed realism vs bootstrap labeling:** the bootstrap seed must be representative enough to exercise recommender/sweet-spot/table logic but labeled clearly as curated/bootstrap until replaced by real sanitized aggregates.
- **Board entry point form:** q10 locks a lightweight entry point, not a full tab. During implementation choose the least disruptive Roostr TUI affordance (help line, command/keybind, or small panel text) that shows the URL/global summary path and copyable explicit import command.
