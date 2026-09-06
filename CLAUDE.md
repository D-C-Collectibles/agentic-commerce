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

## Package manager

This repo uses **pnpm**, not npm — `pnpm install`, `pnpm run <script>` (or `pnpm <script>`), never
`npm install`/`npm run`. Only `pnpm-lock.yaml` is committed; do not generate or commit a
`package-lock.json`.

## Backend

`server/` is a plain Express + TypeScript API server (`pnpm install && pnpm dev` inside
`server/`). It connects to the Neon Postgres project `agentic-commerce` via `DATABASE_URL` (see
`server/.env.example`).

Public endpoints: `GET /products` (#products-route) and `POST /auth/signup` + `POST /auth/login`
(#auth-route). Auth is email + bcrypt password → a signed JWT (`JWT_SECRET` env, `sub` = user id,
`aud` = "user"/"agent") that satisfies `^authenticated` on `/checkout`. The Circle client inits
lazily, so the server boots to serve products/auth even without `CIRCLE_API_KEY`.

Two checkout legs share primitives via #orders-service and settle through #payment-service
(`PAYMENTS_MODE=mock` — the default — settles instantly with no Circle creds; `PAYMENTS_MODE=circle`
does a real Arc-testnet USDC transfer):
- **Human** (in-browser): `POST /checkout` — a user-audience JWT (^authenticated) + spend caps and a
  428 confirm above the auto-approve threshold (^checkout-authorized), then an immediate charge.
- **Agent**: `POST /agent/grant` (mints an agent grant), `POST /agent/checkout` (initiates but does
  NOT charge — returns a `verification_required` handoff), `GET /agent/purchase/:orderId` (poll).
  An agent-initiated purchase is gated by ^personhood-verified: a World ID Selfie Check the human
  completes at `GET /verify/:sessionId` (#verify-route, currently mocked in #verification-service)
  before any money moves. The user/agent split is enforced by the JWT audience, so an agent can't
  take the ungated human path.

## Frontend

`client/` is a React + Vite + TypeScript SPA — the storefront (#storefront): product grid plus
email/password account creation and JWT-gated checkout. `pnpm install && pnpm dev` inside `client/`
(Vite on :5173). It calls the API at `VITE_API_URL` (default `http://localhost:3000`, see
`client/.env.example`); the JWT is kept in `localStorage` and sent as `Authorization: Bearer`. When
signed in, an **Agent access** panel (#storefront-agent-access) mints an agent grant to paste into
the merchant MCP.

## Merchant MCP

`mcp/` is a stdio MCP server (`@agentic-commerce/merchant-mcp`, #merchant-mcp) that lets an AI agent
on the user's machine shop the storefront on the user's behalf: `list_products`, `initiate_purchase`,
`check_purchase_status`. It holds an agent grant (`AGENT_GRANT` env) and points at `STORE_API_URL`.
Every purchase it starts still requires the human's World ID selfie check — the MCP surfaces the
verification URL and polls. `pnpm install && pnpm build` inside `mcp/`; see `mcp/README.md` for
Claude Code registration. Scoped to one store for now; "any compliant storefront" is a follow-up.

## Hackathon prompt logging

Every prompt a developer sends to an AI assistant in this repo must be logged. **Each contributor
writes to their OWN personal log** at `prompts/<name>.jsonl` (e.g. `prompts/matt.jsonl`,
`prompts/darren.jsonl`) — never a shared file. Because each person only ever appends to their own
file, two people logging in parallel can never produce a merge conflict. The `<name>` slug is
derived automatically: known contributors map to a friendly first name (see `AUTHOR_SLUGS` in
`scripts/log-prompt.mjs`), everyone else falls back to a slugified `git config user.name`.

The top-level `prompts.jsonl` is a **frozen historical archive** from before the split — nothing
writes to it anymore; leave it as-is.

Each entry is JSON Lines with a `type` field:

- `{timestamp, author, type: "prompt", prompt}` — a developer prompt (the default).
- `{timestamp, author, type: "merge", note}` — a merge / conflict-resolution note.

Author is taken automatically from `git config user.name`/`user.email`.

**Prompts** are logged automatically in Claude Code via a `UserPromptSubmit` hook
(`.claude/hooks/log-prompt.sh`, registered in `.claude/settings.json`) — no manual step needed
for Claude Code sessions started after this hook was installed.

**Merges** are logged automatically by version-controlled git hooks in `.githooks/` (activated by
`git config core.hooksPath .githooks`, which the `prepare` script wires up on `pnpm install` — so
just run `pnpm install` once per clone):

- `.githooks/post-merge` notes every clean `git merge` / `git pull` (auto-merge or fast-forward).
- `.githooks/post-commit` notes a conflict-resolved merge (which stops the merge, so `post-merge`
  never fires) when you commit the resolution. Between them, each merge is noted exactly once.

The auto-note records the commit range and subjects; **edit it to add what you actually kept** if a
conflict resolution was non-trivial. For other tools, manual logging, or enriching a note:

```
pnpm log-prompt -- "the prompt text"
pnpm log-prompt -- --type merge "resolved conflict in X, took theirs"
```

**Rule: before opening a PR, confirm every prompt used for that branch's work has a matching
entry in your `prompts/<name>.jsonl`.** Treat this as a checklist item alongside tests/lint — do
not open the PR until it's checked off.


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

## Launching Paradigm Agents (architect/builder/reviewer/security/tester)

`paradigm_orchestrate_inline` mode="execute" always returns `subagentType: "general-purpose"`
in its stage output — this is for portability across IDEs without Task-tool support and does
**not** mean the real agents aren't available. Do not follow that field literally.

The real agents are registered Claude Code subagent definitions at
`~/.claude/plugins/marketplaces/a-paradigm/plugins/paradigm/agents/{name}.md`, each with the
correct tool restrictions for its role (e.g. `architect`/`reviewer`/`security` are
Read/Grep/Glob-only and cannot Edit/Write/Bash; `builder`/`tester` can). When launching a stage
from an orchestration plan, pass the plan's `agent` field (e.g. `security`, `builder`) directly
as `subagent_type` — do not fall back to `general-purpose` with an injected prompt.

These subagent types are only registered when the `paradigm@a-paradigm` plugin is loaded at
session startup. If a plugin was just enabled/updated mid-session, or the agent type isn't in
your available agent types, tell the user a session restart is required rather than silently
using `general-purpose` as a substitute.

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