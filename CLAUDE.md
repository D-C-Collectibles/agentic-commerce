# agentic-commerce - Claude Context

> **Paradigm v2.0** | For Claude Code, Claude API, and Claude-native interfaces
>
> **Author:** Matt Canoy ([@ascend42](https://github.com/ascend42)) | **Repo:** [github.com/ascend42/a-paradigm](https://github.com/ascend42/a-paradigm) | **npm:** [@a-company/paradigm](https://www.npmjs.com/package/@a-company/paradigm) | **Plugin:** `paradigm` via Claude Code marketplace

## Project Overview

This project uses Paradigm for structured AI-assisted development.
All context, symbols, and specifications live in the .paradigm/ directory.

## Coding Conventions

See [CONVENTIONS.md](./CONVENTIONS.md) for naming, comments, DRY, maintainability, and review
rules. Follow it for all code in this repo.

## Backend

`server/` is a plain Express + TypeScript API server (`npm install && npm run dev` inside
`server/`). It connects to the Neon Postgres project `agentic-commerce` via `DATABASE_URL` (see
`server/.env.example`).

## Hackathon prompt logging

Every prompt a developer sends to an AI assistant in this repo must be logged to `prompts.jsonl`
at the repo root (JSON Lines: `{timestamp, author, prompt}`). Author is taken automatically from
`git config user.name`/`user.email`.

This happens automatically in Claude Code via a `UserPromptSubmit` hook
(`.claude/hooks/log-prompt.sh`, registered in `.claude/settings.json`) — no manual step needed
for Claude Code sessions started after this hook was installed. For other tools/manual logging:

```
npm run log-prompt -- "the prompt text"
```

**Rule: before opening a PR, confirm every prompt used for that branch's work has a matching
entry in `prompts.jsonl`.** Treat this as a checklist item alongside tests/lint — do not open the
PR until it's checked off.


## Quick Orientation

```
.paradigm/config.yaml  → Project configuration
.paradigm/specs/       → Detailed specifications
.paradigm/docs/        → Commands, patterns, troubleshooting
.cursorrules           → IDE instructions (if using Cursor)
portal.yaml            → Security/auth definitions
.paradigm/lore/        → Project timeline and history
```

## Symbol System

Use these prefixes in documentation and commits:

| Symbol | Meaning | Example |
|--------|---------|---------|
| `#` | Component | `#checkout` |
| `$` | Flow | `$checkout-flow` |
| `^` | Gate | `^authenticated` |
| `!` | Signal | `!login-success` |
| `~` | Aspect | `~audit-required` |

## Conventions

- Use kebab-case for all symbol IDs (feature-name, not featureName)
- Document flows when logic spans 3+ components
- Reference related items using symbol prefixes (# $ ^ ! ~)
- Add descriptions to all components and gates
- Update .purpose files when changing feature behavior
- Keep gates minimal - one responsibility per gate
- Use signals for side effects, not direct state mutations
- ALWAYS use Paradigm logger, NEVER raw console.log/print

## Commit Messages

Use v2 symbols in commits for history tracking:

### Format
```
type(#primary-symbol): short description

- Detail with #component references
- Gate changes: ^gate-name
- Signals emitted: !signal-name

Symbols: #symbol-a, #symbol-b, !signal-c
```

### Convention
- **Subject**: `type(#symbol): description` — primary symbol in parens
- **Body**: Reference affected symbols with prefixes (# $ ^ ! ~)
- **Trailer**: `Symbols: #a, #b, !c` — machine-readable list of ALL affected symbols
- The `Symbols:` trailer is parsed by the post-commit hook for automatic history capture

### Examples
```
feat(#payment-form): add Apple Pay support

- Add #apple-pay-button component
- Update $checkout-flow with new payment step
- Emit !payment-method-added signal
- Gate: ^authenticated required

Symbols: #payment-form, #apple-pay-button, $checkout-flow, !payment-method-added
```

## Agent Onboarding

**First session:** Call `paradigm_status` → read `.paradigm/config.yaml` → check `portal.yaml`

**Before each task:** `paradigm_ripple` for impact, `paradigm_gates_for_route` for new endpoints

**Resuming:** Call `paradigm_session_recover`

## Before Implementing

0. Call `paradigm_protocol_search` — if a protocol matches, follow it
1. Complex task (3+ files)? → `paradigm_orchestrate_inline` mode="plan"
2. Affects symbols? → `paradigm_ripple`
3. Adds endpoints? → `paradigm_gates_for_route`

## Automatic Enforcement (Hooks)

The stop hook **BLOCKS** if source files were modified without .purpose updates.

| Hook | Behavior |
|------|----------|
| **Stop** | Blocks on: missing .purpose, missing portal.yaml gates, aspect drift, stale purposes |
| **Pre-commit** | Auto-rebuilds index — never blocks |
| **Post-write** | Advisory reminder for .purpose coverage |

**If blocked:** Update .purpose files → update portal.yaml if needed → `paradigm_reindex` → finish

## Maintaining Paradigm Files

**You MUST update Paradigm files when making code changes:**

- Add feature → create `.purpose` in directory
- Add protected route → update `portal.yaml` with gates
- Add signal/event → add to `.purpose`
- Add multi-step flow → document as `$flow`
- Rename/delete symbol → update all references
- Record lore via `paradigm_lore_record` for sessions modifying 3+ files
- Use Paradigm logger (`log.component()`, `log.gate()`, etc.) — never raw console.log

**Auth requires portal.yaml** if your code has JWT, role checks, ownership checks, or protected endpoints.

## On-Demand Guidance

Detailed guidance is available via MCP resources — load only what you need:

| Topic | Resource |
|-------|----------|
| Logging rules & directory mapping | `paradigm://guidance/logging` |
| Portal protocol & gate patterns | `paradigm://guidance/portal` |
| MCP workflow & token budgets | `paradigm://guidance/mcp-workflow` |
| Flow-first development | `paradigm://guidance/flows` |
| Multi-agent orchestration | `paradigm://guidance/orchestration` |
| Workspaces (multi-project) | `paradigm://guidance/workspaces` |
| University (knowledge base) | `paradigm://guidance/university` |
| Confidence calibration | `paradigm://guidance/calibration` |
| Session checkpoints | `paradigm://guidance/checkpoints` |
| Navigation & task recipes | `paradigm://guidance/navigation` |
| Component types & hierarchy | `paradigm://guidance/component-types` |
| Troubleshooting | `paradigm://guidance/troubleshooting` |

## Directory Structure

`.purpose` files exist in:
- `src/services/*`
- `src/routes/*`
- `src/api/*`

---

*See `.paradigm/specs/` for specifications. Run `paradigm sync` to regenerate.*