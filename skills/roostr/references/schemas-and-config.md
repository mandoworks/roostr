# Roostr Schemas, Configuration & Templates Reference

Complete reference for `.roostr.toml` (or `.crew-board.toml`), `docs/orchestration/tasks.json`, CLI flags, and worker brief/report templates.

---

## 1. `.roostr.toml` Configuration Schema

Validated by `src/crewfile.js`. A crew file must be owned by the current user and not writable by group or others (`chmod 0644 .roostr.toml`). Only the tables below are accepted:

```toml
name = "my-project"

[board]
tags = "label"          # "tokens" | "label" | "metadata" | "off"
tag_scope = "here"      # "here" | "all"
budget = 5.00           # default per-pane cost warning threshold (USD)
daily_budget = 40.00    # daily spend threshold (USD, via tokscale)

[checks]
concurrency = 3         # 1..10
timeout_seconds = 2     # 0.5..30

[secretary]
auto = false            # true to enable automatic timed secretary monitor passes
interval_seconds = 900  # minimum 60
scope = "workspace"     # "workspace" | "all"

[grill]
mode = "recommended"    # "recommended" (grill-with-ui) | "none" | "custom"
# command = "my-custom-grill" # required only when mode = "custom"

[daemon]
enabled = true
auto_approve = true     # auto-send Return on safe permission prompts classified by recover.js
max_reTRIES = 2
stall_seconds = 900     # 30..86400

[daemon.ladder]
step_1 = "retry"        # "retry" | "upgrade-effort" | "swap-fallback" | "recycle-pane" | "human"
step_2 = "swap-fallback"
step_3 = "human"

[tiers.fast]
tool = "kilo"
model = "xiaomi/mimo-v2-pro"
effort = "low"
fallbacks = ["deepseek/deepseek-chat"]

[tiers.balanced]
tool = "opencode"
model = "xiaomi/mimo-v2-pro"
effort = "medium"
fallbacks = ["anthropic/claude-sonnet-4-6"]

[tiers.reasoning]
tool = "claude"
model = "claude-opus-4-7"
effort = "high"
fallbacks = ["openai/gpt-5.4"]

# Task-kind overrides (kinds: architecture, complex-impl, surgical-code,
# refactor, ui, docs, review, test-gen, research)
[tasks.surgical-code]
tool = "opencode"
model = "xiaomi/mimo-v2-pro"
effort = "medium"
fallbacks = ["deepseek/deepseek-chat"]

[tasks.review]
tool = "kilo"
model = "nvidia/nemotron-3-super-120b-a12b:free"
effort = "low"

[[check]]
name = "TESTS"
run = "./verify.sh"

[[pane]]
name = "Diego"
model = "xiaomi/mimo-v2-pro"
budget = 2.50
report = "docs/orchestration/reports/pkg-a.md"
checks = ["LINT: npm run lint"]
```

---

## 2. `docs/orchestration/tasks.json` Schema

Validated and enriched by `roostr tasks` (`src/tasks.js`). Acts as the single machine-readable contract between the Head Honcho plan, the board TUI (`[O orchestrate]`), the Secretary/Daemon monitor, and the advisor.

```json
{
  "version": 1,
  "plan": "docs/orchestration-plan.md",
  "tasks": [
    {
      "id": "pkg-a",
      "title": "Add rate-limit parser for OpenCode adapter",
      "kind": "surgical-code",
      "brief": "docs/orchestration/tasks/pkg-a.md",
      "report": "docs/orchestration/reports/pkg-a.md",
      "status": "pending",
      "tool": "opencode",
      "effort": "medium",
      "model": "",
      "fallbacks": ["deepseek/deepseek-chat"],
      "owns": ["src/adapters/opencode.js", "test/adapters.test.js"],
      "depends_on": []
    },
    {
      "id": "pkg-b",
      "title": "Audit adapter regex edge cases and test coverage",
      "kind": "review",
      "brief": "docs/orchestration/tasks/pkg-b.md",
      "report": "docs/orchestration/reports/pkg-b.md",
      "status": "pending",
      "owns": ["docs/orchestration/reports/pkg-b.md"],
      "depends_on": ["pkg-a"]
    }
  ]
}
```

### Valid Task Kinds (`config.TASK_KINDS`)
| Kind | Default Effort | Default Tier | Typical Scope |
| :--- | :--- | :--- | :--- |
| `architecture` | `high` | `reasoning` | System design, schema migrations, orchestration |
| `complex-impl` | `high` | `reasoning` | Multi-file features, state machines, concurrency |
| `surgical-code` | `medium` | `balanced` | Scoped bugfixes, single-module features |
| `refactor` | `medium` | `balanced` | Behavior-preserving restructuring |
| `ui` | `medium` | `balanced` | Components, TUI views, CSS/layout |
| `test-gen` | `medium` | `balanced` | Unit and integration test suites |
| `docs` | `low` | `fast` | READMEs, runbooks, comments |
| `review` | `low` | `fast` | Diff audits, regression checks |
| `research` | `low` | `fast` | Codebase exploration, dependency comparison |

---

## 3. Worker Brief & Report Templates

### Brief (`docs/orchestration/tasks/<id>.md`)
```markdown
# Work Package: <id> · <title>

## Scope & Owned Files
- Worktree: `.worktrees/<agent-name>` (branch `crew/<agent-name>`)
- Owned files (touch ONLY these):
  - `path/to/file.js`
- Off-limits: all other files.

## Objective
<1-3 sentences stating the exact change required and why.>

## Acceptance & Verification
1. Run `<exact test command>` and confirm 0 failures.
2. Write your completion report to `docs/orchestration/reports/<id>.md` ending with `<UPPERCASE_NAME>_DONE` (or `<UPPERCASE_NAME>_BLOCKED` if blocked after 3 attempts).
```

### Completion Report (`docs/orchestration/reports/<id>.md`)
```markdown
# Report: <id>

- **Worker**: <Name> (`<pane-id>`)
- **Commit / Branch**: `crew/<agent-name>` (`<sha>`)
- **Files Changed**: `path/to/file.js`
- **Verification Output**: `<test command>` -> PASS (N tests)
- **Notes / Risks**: None

DIEGO_DONE
```

---

## 4. Complete `roostr` CLI Cheat Sheet

```bash
# Live TUI board (press O or T for the Orchestrate / Tasks / Advisor / Analytics / Setup drawer)
roostr [--here | --all] [--view auto|line|wrap|cards] [--orchestration]

# Machine-readable board snapshot for agents
roostr --json [--here | --all]

# Empirical advisor & task validation
roostr summary [--from <external-ledger.jsonl>] [--json]
roostr recommend "<task description>" [--kind <kind>] [--effort <effort>] [--model <model>] [--json]
roostr tasks [--file docs/orchestration/tasks.json] [--crew .roostr.toml] [--json]

# Worker naming, reporting & ledger lifecycle
roostr name [--language en|es|pt|fr|de|it|ja] [--count N] [--title] [--json]
roostr report --pane "$PANE_ID" --role worker --about "<scope>" --task "<task>" --effort medium --model "<model>" [--ctx N] [--tokens N] [--cost N]
roostr spawn --pane "$PANE_ID" --task "<task>" [--kind <kind>] [--effort <effort>] [--model <model>] [--json]
roostr outcome --run "$RUN_ID" --result pass|fail|blocked [--rework N] [--cost N] [--notes "<text>"] [--json]

# Analytics & crash recovery
roostr analytics [--days N | --today] [--by model|pane|kind|batch] [--json]
roostr backups [show | restore <label|id>] [--version N] [--layout even|saved|columns|rows] [--yes]
roostr sessions [--json]
```
