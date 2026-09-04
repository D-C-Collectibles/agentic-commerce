# Wisdom System Specification

> **Paradigm v1.1** | Team preferences, antipatterns, decisions, expertise

## Overview

The Wisdom system captures the **social and cultural dimension** of development - the accumulated knowledge of what works, what doesn't, who knows what, and why decisions were made. It's the team's collective intelligence, indexed by Paradigm symbols.

## Purpose

- **Preserve institutional knowledge** that would otherwise be lost when team members leave
- **Guide AI agents** with team-specific patterns and preferences
- **Prevent repeated mistakes** by documenting antipatterns with reasons
- **Enable knowledge discovery** - find who knows about specific areas
- **Track architectural decisions** with full context and rationale

## Storage Structure

```
.paradigm/wisdom/
├── preferences.yaml      # What TO do, indexed by symbol
├── antipatterns.yaml     # What NOT to do, with reasons
├── expertise.yaml        # Who knows what symbols/areas
└── decisions/            # ADR-style records
    ├── 001-auth-approach.yaml
    ├── 002-api-versioning.yaml
    └── ...
```

## Schema: preferences.yaml

```yaml
version: "1.0"
updated: "2026-02-02T10:00:00Z"

# Symbol-indexed preferences
by_symbol:
  "#checkout":
    patterns:
      - "Always use optimistic UI for cart updates"
      - "Show skeleton loaders during payment processing"
    testing: "Require e2e for each payment method"
    performance: "Target < 100ms cart update latency"
    ux: "Never block UI during background sync"

  "#search":
    patterns:
      - "Debounce input by 300ms"
      - "Show instant results from local cache"
    testing: "Fuzz test with unicode inputs"

# Global preferences (apply to all code)
global:
  code_style:
    - "Prefer early returns over nested conditionals"
    - "Use named exports only, no default exports"
    - "Destructure function parameters for clarity"
  testing:
    - "Unit tests for pure functions"
    - "E2E tests for critical user flows"
    - "Snapshot tests for UI components"
  error_handling:
    - "Always log context with errors"
    - "Use typed error classes, not generic Error"
  naming:
    - "Use kebab-case for file names"
    - "Use PascalCase for components"
    - "Use camelCase for functions"
```

## Schema: antipatterns.yaml

```yaml
version: "1.0"

antipatterns:
  - id: "api-001"
    symbols: ["#api-client"]
    description: "Do NOT use axios interceptors for auth token refresh"
    reason: "Caused race conditions when multiple requests trigger refresh simultaneously"
    alternative: "Use a token refresh queue with mutex, implemented in AuthService"
    learned_from: "commit:abc123"
    added: "2026-01-15"
    added_by: "alice"

  - id: "state-001"
    symbols: ["#cart-store", "#checkout"]
    description: "Do NOT store cart items in localStorage"
    reason: "Caused sync issues with server state, stale data after login"
    alternative: "Use server as source of truth, localStorage only for guest carts"
    learned_from: "incident:CART-123"

  - id: "ui-001"
    symbols: ["#Button", "#Form"]
    description: "Do NOT use inline onClick handlers with async operations"
    reason: "Leads to double-submit bugs and poor error handling"
    alternative: "Use form submission with controlled state and loading indicators"
```

## Schema: expertise.yaml

```yaml
version: "1.0"

experts:
  - name: "alice"
    symbols: ["#checkout", "#stripe-client", "^payment-required"]
    areas: ["payments", "billing", "subscriptions"]
    contact: "alice@company.com"
    notes: "Built the original payment system"

  - name: "bob"
    symbols: ["#search", "#SearchIndex"]
    areas: ["search", "elasticsearch", "performance"]
    contact: "#team-search on Slack"

  - name: "carol"
    symbols: ["^authenticated", "#login-handler", "#signup-handler"]
    areas: ["auth", "security", "oauth"]
    notes: "Security team lead"
```

## Schema: decisions/*.yaml

```yaml
id: "001"
title: "Use JWT for API Authentication"
status: accepted  # proposed | accepted | deprecated | superseded
date: "2026-01-15"
symbols: ["^authenticated", "#login-handler", "#api-client"]

context: |
  We need to authenticate API requests from web and mobile clients.
  Options considered: session cookies, JWT, OAuth tokens.

decision: |
  Use short-lived JWTs (15 min) with refresh tokens (7 days).
  Store refresh token in httpOnly cookie, access token in memory.

rationale:
  factors:
    - "Stateless - no server-side session storage needed"
    - "Works across web and mobile clients"
    - "Standard format, good library support"
  conclusion: "JWT provides the best balance of security and developer experience"

consequences:
  positive:
    - "Reduced server load - no session lookups"
    - "Easy horizontal scaling"
    - "Client can decode token for user info"
  negative:
    - "Cannot revoke individual tokens before expiry"
    - "Token size larger than session ID"
  mitigations:
    - "Short expiry (15 min) limits damage window"
    - "Implement token blocklist for emergency revocation"

# If superseded
superseded_by: null
```

## MCP Resources

| URI | Description |
|-----|-------------|
| `paradigm://wisdom/preferences` | All preferences (global + by_symbol) |
| `paradigm://wisdom/preferences/{symbol}` | Preferences for a specific symbol |
| `paradigm://wisdom/antipatterns` | All antipatterns |
| `paradigm://wisdom/antipatterns/{symbol}` | Antipatterns for a specific symbol |
| `paradigm://wisdom/decisions` | Decision index (summaries only) |
| `paradigm://wisdom/decision/{id}` | Full decision record |
| `paradigm://wisdom/expertise/{symbol}` | Experts for a symbol |

## MCP Tools

### paradigm_wisdom_context

Get relevant wisdom before implementing changes.

```json
{
  "name": "paradigm_wisdom_context",
  "arguments": {
    "symbols": ["#checkout", "#payment-form"],
    "include_global": true
  }
}
```

**Returns:** Preferences, antipatterns, decisions, and experts for the specified symbols.

### paradigm_wisdom_record

Record new team learning.

```json
{
  "name": "paradigm_wisdom_record",
  "arguments": {
    "type": "antipattern",
    "id": "api-002",
    "symbols": ["#api-client"],
    "description": "Do NOT use...",
    "reason": "Because...",
    "alternative": "Instead..."
  }
}
```

### paradigm_wisdom_expert

Find human experts.

```json
{
  "name": "paradigm_wisdom_expert",
  "arguments": {
    "symbol": "#checkout"
  }
}
```

## CLI Commands

```bash
# Show wisdom overview
paradigm wisdom

# Show wisdom for a symbol
paradigm wisdom show #checkout

# Initialize wisdom directory
paradigm wisdom init

# Add antipattern
paradigm wisdom add-antipattern \
  --id "api-002" \
  --symbols "#api-client" \
  --description "Do NOT..." \
  --reason "Because..." \
  --alternative "Instead..."

# Create decision record
paradigm wisdom decide \
  --id "002" \
  --title "API Versioning Strategy" \
  --symbols "#api-client" \
  --context "We need to version our API..." \
  --decision "Use URL path versioning..."

# Find experts
paradigm wisdom expert #checkout
paradigm wisdom expert --area payments
```

## Agent Workflow

Before modifying code, AI agents should:

1. **Query wisdom context** for the symbols they're modifying
2. **Check for antipatterns** - avoid repeating known mistakes
3. **Review relevant decisions** - understand architectural constraints
4. **Consider consulting experts** for significant changes

Example:

```
Agent: "I need to modify #checkout to add Apple Pay"

1. Call paradigm_wisdom_context(symbols: ["#checkout", "#stripe-client"])
   → Gets: "Use optimistic UI", "Require e2e for payment methods"
   → Antipattern: "Don't use interceptors for auth"
   → Decision: "JWT for API auth"
   → Expert: alice (payments)

2. Implement following team patterns

3. Suggest recording new wisdom if approach is novel
```

## Best Practices

1. **Keep antipatterns actionable** - include specific alternatives
2. **Index by symbol** - enables targeted queries, reduces token cost
3. **Record the "why"** - future developers need context
4. **Update when learning** - wisdom should grow with the team
5. **Link to evidence** - commits, incidents, PRs that proved the point

## Token Cost Optimization

- Query by symbol, not full dump (~150-300 tokens per query)
- Decisions index returns summaries only (~50 tokens)
- Full decision loaded on demand (~200-400 tokens)
