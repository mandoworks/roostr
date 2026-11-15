# pkg-workers: per-host worker snapshot publisher

## Goal

Add `src/workers.js`, which publishes the worker state the /agents drill-down reads. One file per host, merged by the page. This is the OVH and Muse contract from `docs/agents-board-names-design.md`.

## Interface

Export at least:

- `buildSnapshot(model, { host, now })` pure function.
- `writeSnapshot(snapshot, dir)` writing atomically and returning the path.
- `main(argv)` returning an exit code.

CLI shape (orchestrator wires `bin/roostr`, do not edit it):

```
roostr workers [--json] [--out <dir>] [--host <name>]
```

Defaults: out from `--out`, else `ROOSTR_WORKERS_DIR`, else error with a one-line message. Host from `--host`, else `os.hostname()` sanitized to `^[a-z0-9][a-z0-9.-]{0,62}$`.

## Data

Read the live snapshot through `require('./herdr').snapshot()` and per-pane reports through `require('./report').readReport`, the same shape the board uses. Build:

```json
{
  "schema": 1,
  "host": "ovh",
  "generated_epoch": 1794717006,
  "generated_at": "2026-11-15T05:00:00.000Z",
  "workers": [
    {
      "pane_id": "wF:pG",
      "workspace": "sonia-nora",
      "name": "La Guardiana",
      "agent": "opencode",
      "state": "working",
      "task": "FABLE fixes",
      "model": "explabs/deepseek-v4.1-flash-1017",
      "tokens": 171500,
      "cost": 0.12,
      "session": "ses_..."
    }
  ]
}
```

Rules:

- One entry per pane that has an agent. Skip panes with no agent.
- Unknown fields are `null`, never guessed. Use the report first, then the snapshot, matching the board's source order.
- `state` is the Herdr agent status verbatim.
- Sort by workspace then pane id, so the file is stable.
- Write `<out>/workers.<host>.json` through a temp file and rename. Set mode 0644.
- `--json` prints the same document to stdout instead of writing.

## Rules

- Node 22 builtins only. No network. No em dashes in files.
- Do not read the Herdr screen. Report and snapshot only.
- Do not include prompts, paths, or task text longer than 160 characters. Truncate with an ellipsis character, not three dots.
- Tests must inject the snapshot and reports, no Herdr calls.

## Tests

`test/workers.test.js` with `node:test`:

- one entry per agent pane, nulls when unknown.
- stable sort and stable JSON.
- atomic write creates the file and leaves no temp file.
- host sanitizing and an invalid host rejected.
- missing out dir is a clean error.

## Report

Write `docs/orchestration/reports/pkg-workers.md` with changes, exact test command and result, and end with `WORKERS_DONE` or `WORKERS_BLOCKED: <reason>`.
