# History System Specification

> **Paradigm v1.1** | Implementation log, validation, fragility tracking

## Overview

The History system captures the **temporal and empirical dimension** of development - what was implemented, what worked, what was rolled back, and how stable different areas are over time. It's the project's memory, indexed by Paradigm symbols.

## Purpose

- **Track what changed** - append-only log of implementations, validations, rollbacks
- **Identify fragile areas** - symbols with frequent failures or rollbacks need extra care
- **Detect co-change patterns** - symbols that often change together
- **Guide AI agents** - check stability before modifying risky areas
- **Enable post-mortems** - full history for any symbol

## Storage Structure

```
.paradigm/history/
├── log.jsonl           # Append-only implementation log
├── index.yaml          # Pre-computed symbol index (regenerated)
└── validation.yaml     # Validation config + summary
```

## Schema: log.jsonl

Append-only, one JSON object per line. Never edit - only append.

```jsonl
{"id":"h0001","ts":"2026-02-02T10:00:00Z","type":"implement","symbols":["#checkout"],"author":{"type":"agent","id":"builder"},"commit":"abc123","intent":"feature","files":["src/checkout/page.tsx"],"description":"Added Apple Pay support"}
{"id":"h0002","ts":"2026-02-02T10:30:00Z","type":"validate","ref":"h0001","symbols":[],"author":{"type":"agent","id":"tester"},"result":"pass","tests":{"passed":15,"failed":0}}
{"id":"h0003","ts":"2026-02-03T09:00:00Z","type":"rollback","ref":"h0001","symbols":["#checkout"],"author":{"type":"human","id":"alice"},"reason":"Performance regression on mobile"}
```

### Entry Types

| Type | Description |
|------|-------------|
| `implement` | New feature, bug fix, or change |
| `validate` | Test results for an implementation |
| `rollback` | Reverting a previous change |
| `refactor` | Code restructuring without behavior change |

### Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique ID (h0001, h0002, ...) |
| `ts` | string | ISO timestamp |
| `type` | string | Entry type (implement/validate/rollback/refactor) |
| `symbols` | string[] | Affected Paradigm symbols |
| `author` | object | `{type: "human"|"agent", id: string}` |
| `commit` | string? | Git commit hash |
| `intent` | string? | feature/fix/refactor/experimental/confirmed |
| `files` | string[]? | Affected files |
| `description` | string? | What was done |
| `ref` | string? | Reference to related entry (for validate/rollback) |
| `result` | string? | pass/fail/partial (for validate) |
| `tests` | object? | `{passed, failed, skipped}` (for validate) |
| `reason` | string? | Reason for rollback |

## Schema: index.yaml

Pre-computed from log.jsonl. Regenerate with `paradigm history reindex`.

```yaml
version: "1.0"
generated: "2026-02-02T12:00:00Z"

by_symbol:
  "#checkout":
    symbol: "#checkout"
    total_changes: 45
    last_modified: "2026-02-02T10:00:00Z"
    stability_score: 0.87    # 0.0-1.0, higher is better
    fragility: low           # low | medium | high | critical
    recent:
      - id: h0045
        type: implement
        description: "Added Apple Pay"
        ts: "2026-02-02T10:00:00Z"
      # ... last 5 entries
    contributors:
      human: ["alice", "bob"]
      agent: ["builder", "fixer"]

  "#search":
    symbol: "#search"
    total_changes: 23
    last_modified: "2026-01-28T15:00:00Z"
    stability_score: 0.62
    fragility: high
    recent: [...]
    contributors:
      human: ["carol"]
      agent: ["builder"]

co_changes:
  - symbols: ["#checkout", "#payment-form"]
    frequency: 15        # Changed together 15 times
    correlation: 0.89    # 89% of #checkout changes include #payment-form

  - symbols: ["#search", "#search-index"]
    frequency: 12
    correlation: 0.78

fragile_symbols:
  - symbol: "#search"
    fragility: high
    reason: "3 rollbacks in last 10 changes"

  - symbol: "#legacy-api"
    fragility: critical
    reason: "Stability score 0.41, 5 failures in last month"
```

## Schema: validation.yaml

```yaml
version: "1.0"
last_run: "2026-02-02T11:00:00Z"
total_validations: 156
pass_rate: 0.92

by_symbol:
  "#checkout":
    symbol: "#checkout"
    last_validated: "2026-02-02T10:30:00Z"
    last_result: pass
    pass_count: 45
    fail_count: 3
    coverage: 0.87

  "#search":
    symbol: "#search"
    last_validated: "2026-01-28T16:00:00Z"
    last_result: fail
    pass_count: 18
    fail_count: 5
    coverage: 0.72
```

## Fragility Scoring

Stability score is calculated from:

```
base = 1.0
penalty_per_rollback = 0.20
penalty_per_failure = 0.10
normalized_changes = total_changes / 10

stability = max(0, base - (rollbacks * 0.20 + failures * 0.10) / max(1, normalized_changes))
```

Fragility levels:

| Score | Level | Meaning |
|-------|-------|---------|
| 0.85+ | low | Safe to modify |
| 0.70-0.85 | medium | Moderate care needed |
| 0.50-0.70 | high | Extra testing recommended |
| <0.50 | critical | Consider deferring or extensive review |

## MCP Resources

| URI | Description |
|-----|-------------|
| `paradigm://history/symbol/{symbol}` | Full history for a symbol |
| `paradigm://history/symbol/{symbol}/recent` | Last 5 changes only |
| `paradigm://history/fragile` | List of fragile symbols |
| `paradigm://history/cochanges/{symbol}` | Co-change patterns |
| `paradigm://history/validation/summary` | Validation statistics |

## MCP Tools

### paradigm_history_context

Get history before modifying symbols.

```json
{
  "name": "paradigm_history_context",
  "arguments": {
    "symbols": ["#checkout", "#payment-form"]
  }
}
```

**Returns:** Summary, recent changes, contributors, co-change patterns for each symbol.

### paradigm_history_record

Record an implementation event.

```json
{
  "name": "paradigm_history_record",
  "arguments": {
    "type": "implement",
    "symbols": ["#checkout"],
    "intent": "feature",
    "description": "Added Apple Pay support",
    "commit": "abc123",
    "files": ["src/checkout/page.tsx"]
  }
}
```

### paradigm_history_validate

Record test results.

```json
{
  "name": "paradigm_history_validate",
  "arguments": {
    "implementation_id": "h0045",
    "result": "pass",
    "tests": {"passed": 15, "failed": 0}
  }
}
```

### paradigm_history_fragility

Check fragility before modifying.

```json
{
  "name": "paradigm_history_fragility",
  "arguments": {
    "symbols": ["#search", "#checkout"]
  }
}
```

**Returns:** Fragility levels, warnings, recommendations.

## CLI Commands

```bash
# Show history overview
paradigm history

# Show history for a symbol
paradigm history show #checkout

# Initialize history directory
paradigm history init

# Show fragile symbols
paradigm history fragile

# Regenerate index from log
paradigm history reindex

# Record an implementation
paradigm history record \
  --type implement \
  --symbols "#checkout" \
  --description "Added Apple Pay" \
  --intent feature

# Record validation result
paradigm history validate \
  --result pass \
  --ref h0045 \
  --passed 15 \
  --failed 0
```

## Git Hooks

Automatic history capture via git hooks.

```bash
# Install hooks
paradigm hooks install

# Hooks installed:
# - post-commit: Records implementation entries from commits
# - pre-push: Reindexes history
```

Post-commit hook extracts:
- Symbols from .purpose files in changed directories
- Intent from commit message prefix (feat/fix/refactor)
- Files changed
- Commit hash and author

## Agent Workflow

Before modifying code, AI agents should:

1. **Check fragility** for symbols they're modifying
2. **Review recent history** - what changed, what broke
3. **Note co-change patterns** - related symbols may need updates
4. **After implementing**, record the change

Example:

```
Agent: "I need to modify #search to add filters"

1. Call paradigm_history_fragility(symbols: ["#search"])
   → fragility: "high"
   → reason: "3 rollbacks in last 10 changes"
   → recommendation: "Add extra test coverage"

2. Call paradigm_history_context(symbols: ["#search"])
   → Recent: 2 rollbacks, 1 performance issue
   → Co-changes: often changes with #search-index
   → Contributors: carol (human), builder (agent)

3. Implement with extra care, add comprehensive tests

4. After commit, call paradigm_history_record(...)

5. After tests pass, call paradigm_history_validate(...)
```

## Best Practices

1. **Always record** - even failed attempts provide learning
2. **Check fragility first** - before modifying unknown areas
3. **Respect co-change patterns** - if A often changes with B, check B
4. **Reindex periodically** - after batch operations
5. **Review fragile symbols** - in sprint planning

## Token Cost Optimization

- Fragility check: ~50-80 tokens
- Symbol history (recent only): ~100-150 tokens
- Full history: ~200-400 tokens
- Co-change patterns: ~50-100 tokens

Pre-computed index.yaml avoids scanning full log.
