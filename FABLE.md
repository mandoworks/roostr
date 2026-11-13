# FABLE.md

A review invitation for Fable 5.2.

You offered to check out this repo and tell us what to improve. This file is the brief: what roostr is, how it works, where the skill and the infrastructure are weak, and what a useful review looks like. Correct anything here that the code contradicts.

## What roostr is

Roostr is a zero-dependency Node.js plugin for Herdr, a terminal multiplexer for coding agents. It gives one board of every agent pane in a workspace: status, model, context, tokens, cost, task line, check badges and orchestration state. It also provides the CLI and the workflow for running a crew of agents: one Head Honcho plans and routes, worker panes execute isolated work packages, and a deterministic daemon supervises them without spending tokens.

The repo is public: https://github.com/mandoworks/roostr

## How it works

- `bin/roostr` is the entry point. It dispatches to `src/` modules and starts the board TUI.
- `src/board.js` is the board. It reads the Herdr snapshot, agent screens, exact per-pane reports and tokscale data, then renders rows, drawers, the orchestrate hub, backups, sessions and the log.
- tokscale (https://github.com/junhoyeo/tokscale) is how roostr gets real spend and session token totals. It is optional in code: without it the board falls back to scraping agent footers, which is lossy when panes are narrow or a side panel is open. Treat it as required for a usable install, and review that expectation.
- Data sources are ordered and labelled. Exact reports win over screen scraping, and screen data wins over a guess. Unknown values stay `?`, never a fabricated number.
- `src/daemon.js` is the deterministic supervisor. It tracks lifecycle events, classifies prompts, walks a nudge, recycle, escalate ladder, enforces a daily wake cap and writes an escalation queue. It uses zero LLM tokens.
- `src/advisor.js`, `src/tasks.js`, `src/ledger.js` and `src/summary.js` implement empirical routing: task kind, historical first-try pass rate, effort, tier, model and fallbacks.
- `src/backup.js`, `src/sessions.js`, `src/session-log.js` and `src/respawn.js` snapshot a workspace, rebuild it with its saved layout, resume each agent session and reopen the board.
- `src/adapters/` scrape usage footers from Claude Code, OpenCode, Kilo, agy and Codex. They are best effort and must never invent a value.
- `skills/roostr/` is the canonical operator runbook. `skills/crew-board/` is the legacy alias.
- `herdr-plugin.toml` declares the board, popup, actions and status event.
- `verify.sh --public` is the gate: syntax, tests, manifest, zero dependency audit, public repo hygiene and a live smoke check when running inside Herdr.

The board is read-only by default. It never stops an agent on its own. Actions that change state are explicit: recover a blocked pane, restart a workspace, restore a backup, trust a crew file.

## What changed recently

- The board now has a four-tab orchestrate hub: `1 tasks · advisor`, `2 analytics · summary`, `3 daemon · plan`, `4 setup`.
- The secretary pane and role were removed. The daemon already owned lifecycle tracking, the ladder, the wake cap and the escalation queue, so a separate LLM loop had no job left. The template was deleted too.
- `X` respawns the board's own workspace through a detached child, then reopens the board in the rebuilt workspace.
- Adapters now accept clipped OpenCode and Kilo footers such as `97.8K (38% ctrl+p` without losing the token count.

If the skill still describes a Secretary pane, that is drift, not a feature. Call it out.

## Review request 1: the skill

Read `skills/roostr/SKILL.md` and `skills/roostr/references/schemas-and-config.md` against the code. We want:

- Every command, key, tab number, config field and file path in the skill verified against `src/` and `bin/`.
- Stale workflow removed, especially anything that still starts or prompts a Secretary.
- A clearer split between what the human does and what the board does.
- Prerequisites and failure modes that a new operator will hit: Herdr environment, missing agent CLI, missing tokscale, a pane with no session, a disabled model, a changed crew file.
- Examples that work on both macOS and Linux, with no machine-specific paths.
- The smallest set of changes that makes the skill trustworthy to hand to a new operator.

Deliver findings as a list with `file:line`, the problem, and the exact patch you propose.

## Review request 2: the infrastructure

Look at the plugin boundary, state handling and test strategy. We want:

- Failure modes in the board when Herdr is missing, the snapshot is partial, an agent screen is unreadable, or a state file is corrupt.
- State files under `~/.roostr/` and `~/.crew-board/`: ownership, migration, locking, atomic writes, permissions, and what happens on two boards running at once.
- The daemon: event loss, restart reconciliation, clock changes, duplicate escalations, wake cap accounting and circuit breaker behavior.
- The adapter layer: which footers across agent versions are likely to break next, and how to test that without a live agent.
- tokscale as a hard dependency versus an optional one: install detection, a clear warning when missing, and whether the footer fallback should remain as best effort only.
- The verify pipeline: what it misses, what is slow, and which checks should be blocking versus advisory.
- Zero-dependency and portability constraints: Node builtins only, no package manager, no hidden shells, no machine paths in shipped files.
- The upgrade and release path for a Herdr checkout: when a local checkout is ahead of origin, what an operator should expect.

Rank findings by user impact. Prefer a small number of concrete fixes over a rewrite.

## Ground rules

- Do not commit secrets, tokens, `.env` files or private paths.
- Do not push to `main`. Open a branch or send a patch, or leave findings in this file.
- Keep the public repo free of client names and machine-specific paths.
- Keep roostr zero-dependency unless you can show the dependency buys something the platform cannot.
- A review is useful when it points at a line of code, states the failure it causes, and shows the smallest fix.

## What good output looks like

1. A short verdict: what is solid, what is risky, what is missing.
2. Skill findings, each with `file:line`, impact and patch.
3. Infrastructure findings, ranked, each with the failure scenario and the smallest fix.
4. A list of things you would deliberately not change, and why.
5. Any question you need answered before the review is complete.

## Open questions for the human

- Should tokscale be a documented hard requirement with a startup warning, or stay a recommended install?
- Is the target audience a single operator on one machine, or a small team sharing a tailnet?
- Should orchestration be enabled by default, or stay opt-in behind config and environment flags?
- Which agents are in scope for adapter support: Claude Code, OpenCode, Kilo, agy, Codex, or all of them?
- Is the public repo allowed to grow a small optional test harness, or must it stay runnable with Node builtins only?
