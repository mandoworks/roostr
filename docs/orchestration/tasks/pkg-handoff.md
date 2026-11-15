# pkg-handoff: orchestrator handoff writer

## Goal

Add `src/handoff.js`, a self-contained writer for the orchestrator handoff brief described in `docs/agents-board-names-design.md`. The successor may be a different tool or model with no session resume, so the brief must stand alone.

## Interface

Export at least:

- `buildBrief(input)` pure function returning the markdown string.
- `writeHandoff(opts)` writing the files and returning `{ file, latest, slug, at }`.
- `main(argv)` for the CLI, returning an exit code.

CLI shape (the orchestrator wires it into `bin/roostr`, do not edit `bin/roostr`):

```
roostr handoff [--pane <id>] [--slug <slug>] [--dir <project root>] [--why <text>] [--json] [--dry-run]
```

Defaults: pane from `HERDR_PANE_ID`, slug from the pane name or report name lowercased, dir from the pane cwd or `process.cwd()`.

## Inputs

Read, with `fs` only and no network:

- the pane report through `require('./report').readReport(paneId)` (use the same call shape as `src/board.js`).
- `docs/orchestration/tasks.json` under dir when present, for id, title, status, depends_on.
- `docs/orchestration-plan.md` under dir when present, for the plan pointer.
- report files named in tasks.json, when present, to record their paths and the last non-empty line.

Do not call `herdr`. Callers pass what they have. Use an injectable input object so tests need no filesystem beyond temp dirs.

## Output

Write `docs/orchestration/handoffs/<slug>-<YYYYMMDD-HHMMSS>.md` and refresh `docs/orchestration/handoffs/latest-<slug>.md`.

Brief sections, in order:

1. Title with slug and timestamp.
2. Role and why the handoff happened (`--why`, default `manual`).
3. Plan pointer and task table (id, title, status).
4. Blocked-on, taken from report fields when present, otherwise `unknown`.
5. Last actions, from report `task`, `about`, `session`.
6. File pointers: plan, tasks, reports.
7. Session export pointer. Record the session id when valid; do not copy transcript content.

Keep output deterministic for tests: accept an injected `now`.

## Rules

- Node 22 builtins only. No em dashes anywhere in the files you write.
- Never write outside the project `docs/orchestration/handoffs` folder.
- Reject a slug that is not `^[a-z0-9][a-z0-9-]{0,31}$`.
- `--dry-run` prints the path and the brief, writes nothing.
- `--json` prints `{ file, latest, slug, at }` on one line.

## Tests

`test/handoff.test.js` with `node:test`:

- brief includes every section and the task ids from a fixture tasks.json.
- timestamp and slug validation.
- dry run writes nothing.
- latest pointer is refreshed and contains or links the new file.
- missing tasks.json still produces a valid brief with `no task list`.

## Report

Write `docs/orchestration/reports/pkg-handoff.md` with what changed, the exact test command and result, and end with `HANDOFF_DONE` or `HANDOFF_BLOCKED: <reason>`.
