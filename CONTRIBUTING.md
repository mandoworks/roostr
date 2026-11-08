# Contributing to Roostr

Roostr is a zero-dependency terminal sentry pane for [Herdr](https://herdr.dev). Small, auditable changes are preferred.

## Rules

- Node 22 built-ins only. **No npm packages**, no `package.json`, no build step.
- Use `child_process.execFile` with explicit `argv` arrays only. Never `exec`, never `shell: true`.
- Keep prose clear and direct; avoid em dashes in documentation/copy.
- Run `./verify.sh` before opening a PR and make sure it ends with `ALL CHECKS PASSED`.
- Do not commit secrets, tokens, machine-specific private paths, or unrelated cleanup.

## Add a screen-footer adapter

1. Create `src/adapters/<agent>.js` with a focused parser for that agent’s terminal/footer output.
2. Export a small, testable API and keep parsing defensive (unknown/missing values must not become fake numbers).
3. Register coverage in `test/adapters.test.js` with representative fixture output.
4. If the adapter affects board behavior, add/adjust targeted tests in `test/board.test.js` or the relevant module tests.

## Exact metrics from any agent

Agents can report exact values directly instead of relying on screen scraping:

```bash
roostr report --pane "$HERDR_PANE_ID"
```

Use this path when an integration can emit trustworthy usage/status data. Scraped fallback values must remain visually distinct from exact reports in the TUI.

## Checks

```bash
./verify.sh
./verify.sh --public
HOME=$(mktemp -d) node --test test/*.test.js
```
