---
id: purpose
title: Purpose File Schema
version: 1.0.0
updated: 2026-02-02
tags: [purpose, schema, context, yaml]
canonical_for: [purpose-files, directory-context]
related:
  - ./symbols.md (symbol reference)
  - ./context.md (documentation indexing)
---

# Purpose File Schema

Purpose files (`.purpose`) define contextual metadata for directories. They tell AI agents what a directory contains, what features it implements, and how components relate to each other.

---

## File Location

Purpose files can be named:
- `.purpose` - Directory-level context (recommended)
- `*.purpose` - Named purpose file for specific context

Place `.purpose` files in:
- Feature directories (`src/features/auth/.purpose`)
- Component directories (`src/components/.purpose`)
- Any directory that benefits from AI context

---

## Basic Schema

```yaml
# Optional: description of the directory
description: What this directory contains and its role in the project

# Components (# symbol) - All code units
components:
  component-name:
    description: What this component does
    tags: [feature, keyword]          # Classification via tags
    gates: [^gate1, ^gate2]           # Required gates
    flows: [$flow-name]               # Multi-step processes
    signals: ["!signal1", "!signal2"]   # Events emitted
    components: [#Component1]         # Components used
    aspects: [~aspect-name]           # Cross-cutting rules

# Gates (^ symbol) - Authorization checkpoints
gates:
  gate-name:
    description: What access this controls
    locks: [lock-description]         # Requirements
    tags: [auth, admin, etc]

# Signals (! symbol) - Events and side effects
signals:
  signal-name:
    description: What triggers this event
    emitted-by: [#component]          # Source
    category: [auth, analytics, etc]

# Flows ($ symbol) - Multi-step processes
flows:
  flow-name:
    description: What this process accomplishes
    steps: [step1, step2, step3]
    gates: [^required-gate]

# Aspects (~ symbol) - Cross-cutting rules with anchors
aspects:
  aspect-name:
    description: What this aspect enforces
    anchors: [file.ts:15-30]          # REQUIRED code anchors
    applies-to: ["#*Service"]         # Matching patterns
```

---

## Record vs Array Format

Both formats are valid for defining items:

### Record Format (Recommended)

```yaml
components:
  login-handler:
    description: User authentication
    tags: [feature]
    gates: [^authenticated]

  checkout:
    description: Purchase flow
    tags: [feature, critical]
    gates: [^authenticated, ^has-cart]
```

### Array Format

```yaml
components:
  - id: login-handler
    description: User authentication
    tags: [feature]
    gates: [^authenticated]

  - id: checkout
    description: Purchase flow
    tags: [feature, critical]
    gates: [^authenticated, ^has-cart]
```

---

## Symbol References

Reference other symbols using their prefixes:

| Symbol | Meaning | Example |
|--------|---------|---------|
| `#` | Component | `#Button`, `#login-handler` |
| `^` | Gate | `^authenticated`, `^admin` |
| `!` | Signal | `!login-success`, `!error` |
| `$` | Flow | `$onboarding`, `$checkout-flow` |
| `~` | Aspect | `~audit-required`, `~rate-limited` |

---

## Minimal Example

```yaml
# src/features/auth/.purpose
description: Authentication and user session management

components:
  login-handler:
    description: Email/password authentication
    tags: [feature]
    gates: [^public]
    signals: ["!login-success", "!login-failed"]

  logout-handler:
    description: End user session
    tags: [feature]
    gates: [^authenticated]
    signals: ["!logout"]

  LoginForm:
    description: Login UI with validation
    tags: [ui]
    components: [#login-handler]
```

---

## Complete Example

```yaml
# src/features/checkout/.purpose
description: E-commerce checkout and payment processing

components:
  add-to-cart:
    description: Add product to shopping cart
    tags: [feature]
    gates: [^authenticated]
    signals: ["!cart-updated"]
    components: [#CartButton, #ProductCard]

  checkout:
    description: Complete purchase flow
    tags: [feature, critical]
    gates: [^authenticated, ^has-cart]
    flows: [$checkout-flow]
    signals: ["!checkout-started", "!checkout-completed", "!payment-failed"]

  CartButton:
    description: Add to cart button with quantity selector
    tags: [ui, interactive]
    components: [#add-to-cart]

  CheckoutForm:
    description: Payment and shipping form
    tags: [ui]
    components: [#AddressForm, #PaymentForm]

flows:
  checkout-flow:
    description: Multi-step checkout process
    steps:
      - Review cart
      - Enter shipping
      - Enter payment
      - Confirm order
    gates: [^authenticated, ^has-cart]

signals:
  cart-updated:
    description: Cart contents changed
    emitted-by: [#add-to-cart]
    category: cart

  checkout-completed:
    description: Order successfully placed
    emitted-by: [#checkout]
    category: purchase
```

---

## Validation

Validate purpose files with:

```bash
paradigm purpose validate
paradigm purpose validate ./src/features
```

Common validation errors:
- Missing description
- Invalid symbol references
- Circular dependencies
- Unknown symbol types

---

## Best Practices

1. **Keep descriptions concise** - One sentence explaining purpose
2. **Use consistent naming** - kebab-case for IDs (`feature-name` not `featureName`)
3. **Reference related symbols** - Link features to gates, signals, components
4. **Add tags for searchability** - Help AI find relevant code
5. **Update when code changes** - Keep purpose files in sync with implementation
6. **Place at appropriate level** - Directory-level for shared context, feature-level for specifics

---

## CLI Commands

```bash
# Validate all purpose files
paradigm purpose validate

# Show aggregated context
paradigm purpose remember

# Lint with auto-fix
paradigm lint --fix

# Generate scan index from purpose files
paradigm index
```

---

## AI Agent Usage

AI agents should:
1. Read `.purpose` file before modifying a directory
2. Update `.purpose` when adding features or components
3. Follow symbol references to understand relationships
4. Use gates information for authorization requirements
5. Check signals when implementing event handling
