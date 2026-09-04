# Paradigm Symbol System v2

> Paradigm v2.0 - Simplified, Anchor-First Symbols with Tag-Based Classification

The symbol system creates a **shared language** between code, developers, and AI agents. Version 2 reduces cognitive load by using **5 operational symbols** plus a **tag bank** for classification.

**Paradigm is universal.** The symbols mean the same thing whether you're building a web app, training an ML model, writing firmware, or deploying infrastructure.

---

## Why v2?

The original v1 system had 9 symbols (`@`, `#`, `$`, `%`, `^`, `!`, `?`, `~`, `&`). In practice:

1. **AI agents rarely used them** - Choosing between `@feature` vs `#component` vs `&integration` added cognitive load
2. **Classification symbols added noise** - `@feature` and `&integration` are classifications, not operational concepts
3. **Aspects had no enforcement** - Rules like "all payments require audit logging" were documentation without teeth

**Solution**: 5 operational symbols + a tag bank for classification.

---

## Symbol Reference (v2)

| Symbol | Name | Purpose | Example |
|--------|------|---------|---------|
| `#` | Component | Any documented code unit (function, class, module, service) | `#PaymentService`, `#login-handler` |
| `$` | Flow | Multi-step process with defined sequence | `$checkout-flow`, `$onboarding` |
| `^` | Gate | Authorization/validation checkpoint | `^authenticated`, `^admin-only` |
| `!` | Signal | Event emitted for side effects | `!payment-completed`, `!login-failed` |
| `~` | Aspect | Rule/constraint with required code anchor | `~audit-required`, `~rate-limited` |

### What Changed from v1

| Old Symbol | New Approach |
|------------|--------------|
| `@feature` | Tag: `[feature]` on a `#component` |
| `&integration` | Tag: `[integration]` on a `#component` |
| `%state` | Tag: `[state]` on a `#component` |
| `?idea` | Tag: `[idea]` on any symbol |
| `~deprecated` | Tag: `[deprecated]` on any symbol |

---

## Component (`#`)

The universal anchor point for documented code. A component is any code unit worth naming.

### Definition

```yaml
# In .purpose file
#PaymentService:
  description: Handles all payment processing
  tags: [feature, integration, stripe]
  anchors:
    - src/services/payment.ts:1-150
  references:
    - $checkout-flow
    - ^authenticated
  emits:
    - "!payment-completed"
    - "!payment-failed"
```

### What Qualifies as a Component

- Functions with business logic
- Classes/modules
- API endpoints
- React components
- Database models
- Configuration objects
- CLI commands

### Naming Convention

- **PascalCase** for classes/components: `#PaymentService`, `#UserProfile`
- **kebab-case** for functions/endpoints: `#process-payment`, `#get-user`

### In Code (Logging)

```
log.component('#database').debug('Query executed', { table, duration })
log.component('#PaymentService').info('Payment processed', { amount })
```

---

## Flow (`$`)

Multi-step processes with defined sequence. Flows connect components.

### Definition

```yaml
$checkout-flow:
  description: Complete purchase from cart to confirmation
  tags: [critical, revenue]
  steps:
    - "^authenticated"       # Gate: must be logged in
    - "#validate-cart"       # Component: check inventory
    - "#calculate-totals"    # Component: tax, shipping
    - "^payment-authorized"  # Gate: payment method valid
    - "#process-payment"     # Component: charge card
    - "!payment-completed"   # Signal: trigger fulfillment
    - "#send-confirmation"   # Component: email receipt
  on-failure:
    - "!checkout-failed"
    - "#notify-support"
```

### Flow Characteristics

- Has a defined start and end
- Steps execute in sequence (with possible branches)
- Gates can block progression
- Signals trigger side effects
- Failure paths are explicit

### In Code (Logging)

```
log.flow('$checkout-flow').info('Step completed', { step: 'shipping', next: 'payment' })
```

---

## Gate (`^`)

Authorization and validation checkpoints. Gates either pass or block.

### Definition

```yaml
# Inside portal.yaml under `gates:`, the key is bare (no ^ prefix).
# The ^ prefix appears only in references (routes, flow steps, `blocks:`).
payment-authorized:
  description: Verify payment method is valid and has sufficient funds
  tags: [security, payment]
  anchors:
    - src/middleware/payment-auth.ts:25-45
  check: |
    user.paymentMethod != null &&
    user.paymentMethod.verified &&
    cart.total <= user.paymentMethod.limit
  blocks:
    - $checkout-flow
    - "#process-refund"
```

### Gate Patterns

| Pattern | Example | Use Case |
|---------|---------|----------|
| Identity | `^authenticated` | User is logged in |
| Role | `^admin` | User has admin role |
| Ownership | `^resource-owner` | User owns the resource |
| State | `^cart-not-empty` | Precondition met |
| External | `^payment-authorized` | Third-party validation |

### In Code (Logging)

```
log.gate('^authenticated').debug('Checking gate')
log.gate('^authenticated').warn('Access denied', { user_id, resource })
log.gate('^authenticated').debug('Gate passed', { user_id })
```

---

## Signal (`!`)

Events emitted for side effects. Signals decouple producers from consumers.

### Definition

```yaml
!payment-completed:
  description: Emitted when payment successfully processes
  tags: [critical, audit]
  anchors:
    - src/services/payment.ts:89
  payload:
    orderId: string
    amount: number
    currency: string
    timestamp: ISO8601
  triggers:
    - #send-receipt
    - #update-inventory
    - #notify-fulfillment
    - #log-audit-trail
```

### Signal Naming

- **Past tense** for completed actions: `!payment-completed`, `!user-registered`
- **Present tense** for ongoing: `!processing-started`
- **Noun** for state changes: `!low-inventory`, `!rate-limit-exceeded`

### In Code (Logging)

```
log.signal('!login-success').info('User authenticated', { user_id })
log.signal('!payment-failed').error('Payment declined', { reason })
```

---

## Aspect (`~`)

**Rules and constraints with REQUIRED code anchors.** Aspects are the enforcement mechanism for cross-cutting concerns.

### Definition

```yaml
~audit-required:
  description: All financial operations must log to audit trail
  tags: [compliance, security]
  anchors:  # REQUIRED - must point to actual enforcement code
    - src/middleware/audit.ts:15-35
    - src/decorators/auditable.ts:1-20
  applies-to:
    - "#*Service"        # All services
    - "$*-payment-*"     # All payment flows
    - "^payment-*"       # All payment gates
  enforcement: |
    Every component matching applies-to patterns must:
    1. Import the @auditable decorator
    2. Wrap operations in audit context
    3. Log before/after state for mutations
  examples:
    correct: |
      @auditable('payment')
      async processPayment(order: Order) {
        // Implementation
      }
    incorrect: |
      async processPayment(order: Order) {
        // Missing audit decorator!
      }
```

### Anchor Requirement

**Aspects MUST have anchors.** An aspect without code backing it is just documentation that will be ignored.

```yaml
# INVALID - no anchors
~secure-passwords:
  description: Passwords must be hashed with bcrypt
  applies-to: ["#*Auth*"]

# VALID - has enforcement code
~secure-passwords:
  description: Passwords must be hashed with bcrypt
  anchors:
    - src/utils/password.ts:10-25      # The hashing function
    - src/middleware/auth.ts:45-60     # The validation check
  applies-to: ["#*Auth*"]
```

### Anchor Format

Line-based references for precision:

| Format | Example | Description |
|--------|---------|-------------|
| Single line | `file.ts:15` | Specific line |
| Line range | `file.ts:15-20` | Lines 15 through 20 |
| Multiple lines | `file.ts:15,25,30` | Specific lines |
| Glob with range | `src/auth/*.ts:1-50` | All files, lines 1-50 |

### Common Aspect Patterns

| Aspect | Purpose | Typical Anchors |
|--------|---------|-----------------|
| `~audit-required` | Compliance logging | Middleware, decorators |
| `~rate-limited` | API protection | Rate limiter config |
| `~cached` | Performance | Cache wrapper functions |
| `~validated` | Input safety | Validation schemas |
| `~encrypted` | Data protection | Encryption utilities |
| `~idempotent` | Retry safety | Idempotency key handlers |

### In Code (Logging)

```
log.aspect('~audit-required').debug('Audit logged', { operation, user })
log.aspect('~rate-limited').warn('Rate limit exceeded', { ip, endpoint })
```

---

## Tag Bank System

Tags replace classification symbols. They live in `.paradigm/tags.yaml`.

### Structure

```yaml
# .paradigm/tags.yaml
version: "1.0"

# Core tags - universal vocabulary
core:
  feature:
    description: User-facing functionality
    color: "#4CAF50"
    applies-to: ["#"]

  integration:
    description: External service connection
    color: "#2196F3"
    applies-to: ["#"]

  state:
    description: Manages application state
    color: "#9C27B0"
    applies-to: ["#"]

  critical:
    description: Failure causes major business impact
    color: "#F44336"
    applies-to: ["#", "$", "^"]

  deprecated:
    description: Scheduled for removal
    color: "#9E9E9E"
    applies-to: ["#", "$", "^", "!", "~"]

  idea:
    description: Proposed, not yet implemented
    color: "#FF9800"
    applies-to: ["#", "$"]

  security:
    description: Security-sensitive code
    color: "#E91E63"
    applies-to: ["#", "^", "~"]

  compliance:
    description: Regulatory requirement
    color: "#795548"
    applies-to: ["~", "^"]

# Project tags - domain-specific vocabulary
project:
  stripe:
    description: Stripe payment integration
    color: "#635BFF"
    applies-to: ["#"]

# Suggested tags - AI can propose, human approves
suggested: []
```

### Tag Properties

| Property | Required | Description |
|----------|----------|-------------|
| `description` | Yes | What the tag means (for AI context) |
| `color` | No | Hex color for UI display |
| `applies-to` | No | Symbol types this tag is valid for |
| `aliases` | No | Alternative names (for AI matching) |

### Using Tags in .purpose Files

```yaml
# In .purpose file
#checkout:
  description: Shopping cart checkout feature
  tags: [feature, revenue, critical]
  anchors:
    - src/features/checkout/index.ts:1-200

#stripe-integration:
  description: Stripe payment integration
  tags: [integration, stripe]
  anchors:
    - src/services/stripe.ts:1-150
```

---

## Symbol Naming Conventions

1. **Use kebab-case for IDs**: `#user-login` not `#userLogin`
2. **Use PascalCase for classes**: `#PaymentService`, `#UserProfile`
3. **Be specific**: `#checkout-payment` not `#pay`
4. **Use dots for hierarchy in tags only**: Tags can be namespaced like `[payments:stripe]`
5. **Match file structure**: Code in `features/` gets `[feature]` tag, `services/` gets component

---

## Cross-Referencing

Symbols reference each other in documentation:

```yaml
# In .purpose file
#process-order:
  description: Complete order processing
  tags: [feature, critical]
  gates: [^authenticated, ^valid-order]  # Gates required
  flows: [$order-processing]             # Flows triggered
  signals: ["!order-complete", "!order-failed"]
  components: [#validator, #processor]

# These references are automatically indexed by `paradigm status`
# and appear in the constellation graph
```

### Symbol Reference Arrays

| Array | Symbol Type | Example |
|-------|-------------|---------|
| `gates:` | `^` Gate | `[^authenticated, ^premium]` |
| `flows:` | `$` Flow | `[$checkout-flow, $onboarding]` |
| `signals:` | `!` Signal | `["!success", "!failed"]` |
| `components:` | `#` Component | `[#Button, #Modal]` |
| `aspects:` | `~` Aspect | `[~audit-required, ~cached]` |

---

## Migration from v1

### Automatic Conversion

Run `paradigm migrate v2` to automatically convert:

- `@feature` → `#feature` with tag `[feature]`
- `&stripe` → `#stripe` with tag `[integration]`
- `%userState` → `#userState` with tag `[state]`
- `?newIdea` → `#newIdea` with tag `[idea]`

### Manual Review Required

- All `~` symbols flagged for anchor addition
- Sentinel shows "Aspects need anchors" warning until resolved

---

## Discipline-Specific Examples

See `specs/disciplines.md` for how symbols map to:
- Web Development
- Backend Services
- Machine Learning
- Mobile Development
- Game Development
- Embedded/IoT
- Infrastructure/DevOps
