# Paradigm Logger Specification (v2)

The Paradigm Logger creates a **shared language between code, developers, and AI agents** using Paradigm's symbol system v2. It replaces raw `console.log`/`print` statements with structured, filterable, symbol-typed logs.

---

## Core Principle

**NEVER use raw logging. ALWAYS use the Paradigm logger.**

```
// BAD - Raw logging
console.log('User logged in', userId);
print(f"Query took {duration}ms")

// GOOD - Paradigm logger (v2)
log.component('#login-handler').info('User logged in', { userId });
log.component('#database').debug('Query executed', { duration });
```

---

## API Design (v2 - Language-Agnostic)

### Logger Object

```
log.component('#symbol')  → SymbolLogger   // For #components (universal code units)
log.gate('^symbol')       → SymbolLogger   // For ^gates (authorization)
log.signal('!symbol')     → SymbolLogger   // For !signals (events)
log.flow('$symbol')       → SymbolLogger   // For $flows (multi-step processes)
log.aspect('~symbol')     → SymbolLogger   // For ~aspects (cross-cutting rules)
log.raw('symbol')         → SymbolLogger   // For any symbol without prefix validation
```

### SymbolLogger Methods

```
.debug(message, data?)    // Verbose debugging info
.info(message, data?)     // General information
.warn(message, data?)     // Warning conditions
.error(message, data?)    // Error conditions
.start(message, data?)    → DurationTracker  // Start timed operation
```

### DurationTracker Methods

```
.success(message, data?)  // Operation succeeded (logs duration)
.error(message, data?)    // Operation failed (logs duration)
.end(level, message, data?)  // Custom level completion
```

---

## Log Levels

| Level | Priority | When to Use |
|-------|----------|-------------|
| `debug` | 0 | Internal state, cache hits, queries — verbose dev info |
| `info` | 1 | Component entry/exit, successful operations |
| `warn` | 2 | Denied access, retries, recoverable issues |
| `error` | 3 | Exceptions, unrecoverable failures |

**Default:** `debug` in development, `info` in production.

---

## Symbol Usage by Location (v2)

In v2, all code units use `#component`. The tag system handles classification.

| Directory Pattern | Symbol | Log Method |
|-------------------|--------|------------|
| `features/`, `routes/`, `api/` | `#` | `log.component()` |
| `components/`, `lib/`, `utils/` | `#` | `log.component()` |
| `services/`, `core/`, `drivers/` | `#` | `log.component()` |
| `integrations/`, `external/`, `vendors/` | `#` | `log.component()` |
| `stores/`, `state/`, `reducers/` | `#` | `log.component()` |
| `config/`, `models/` | `#` | `log.component()` |
| `middleware/`, `auth/`, `guards/`, `policies/` | `^` | `log.gate()` |
| `events/`, `handlers/`, `listeners/`, `hooks/` | `!` | `log.signal()` |
| `flows/`, `sagas/`, `workflows/`, `pipelines/` | `$` | `log.flow()` |
| `aspects/`, `rules/`, `constraints/` | `~` | `log.aspect()` |

---

## Common Patterns

### Component Entry/Exit

```
function login(email, password):
    tracker = log.component('#login-handler').start('Starting login', { email })

    try:
        user = authenticate(email, password)
        log.signal('!login-success').info('User authenticated', { userId: user.id })
        tracker.success('Login completed', { userId: user.id })
        return user
    catch error:
        log.signal('!login-failed').warn('Login failed', { email, error })
        tracker.error('Login failed', { error })
        throw error
```

### Gate Checks

```
function requireAuth(request):
    log.gate('^authenticated').debug('Checking gate')

    user = getUser(request)
    if not user:
        log.gate('^authenticated').warn('Access denied', { path: request.path })
        return unauthorized()

    log.gate('^authenticated').debug('Gate passed', { userId: user.id })
    return next()
```

> **Note:** For authorization flows that need AI validation, use the **Portal Validator** instead.
> See [Portal Validation Specification](./portal-validation.md) for structured decision logging.

### Component Operations

```
function query(sql, params):
    tracker = log.component('#database').start('Executing query')

    try:
        result = db.execute(sql, params)
        tracker.success('Query completed', { rows: result.length })
        return result
    catch error:
        tracker.error('Query failed', { error })
        throw error
```

### Integration Components

```
function processPayment(amount, token):
    tracker = log.component('#stripe-client').start('Processing payment', { amount })

    try:
        result = stripe.charges.create({ amount, source: token })
        log.signal('!payment-completed').info('Payment processed', { chargeId: result.id })
        tracker.success('Payment completed', { chargeId: result.id })
        return result
    catch error:
        log.signal('!payment-failed').error('Payment failed', { error })
        tracker.error('Payment failed', { error })
        throw error
```

### Aspect Enforcement

```
function auditMiddleware(request, next):
    log.aspect('~audit-required').debug('Audit middleware invoked', { path: request.path })

    before = captureState()
    result = next(request)
    after = captureState()

    log.aspect('~audit-required').info('Operation audited', {
        path: request.path,
        changes: diff(before, after)
    })

    return result
```

### State Components

```
function setAuthenticated(value):
    log.component('#user-store').info('State changing', {
        from: state.authenticated,
        to: value
    })
    state.authenticated = value
```

---

## Filtering

### By Log Level

```bash
# Environment variable
LOG_LEVEL=debug    # Show all
LOG_LEVEL=info     # Show info, warn, error
LOG_LEVEL=warn     # Show warn, error
LOG_LEVEL=error    # Show errors only
```

### By Symbol Type

```bash
# Environment variable (comma-separated)
PARADIGM_SYMBOLS=!          # Signals only — high-level overview
PARADIGM_SYMBOLS=#,^,!      # Components, gates, signals — auth debugging
PARADIGM_SYMBOLS=#          # Components only — infrastructure debugging
PARADIGM_SYMBOLS=~          # Aspects only — rule enforcement debugging
```

### Common Filter Recipes

| Use Case | Level | Symbols | What You See |
|----------|-------|---------|--------------|
| High-level overview | info | `!` | Just events/signals |
| Auth debugging | debug | `#,^,!` | Components, gates, signals |
| Infrastructure | debug | `#,!` | Components and signals |
| Rule enforcement | debug | `~,!` | Aspects and signals |
| Minimal | warn | (all) | Warnings and errors only |

---

## Output Formats

### Development (Pretty)

```
16:42:15.123 #login-handler INFO  Starting login {"email":"user@example.com"}
16:42:15.456 #database DEBUG Query executed {"table":"users","duration":"45ms"}
16:42:15.789 !login-success INFO User authenticated {"userId":"abc123"}
```

### Production (JSON)

```json
{"timestamp":"2026-01-14T00:42:15.123Z","level":"info","symbol":"#login-handler","symbolType":"component","message":"Starting login","email":"user@example.com"}
```

---

## Correlation IDs

Track requests across multiple log statements:

```
correlationId = createCorrelationId()

withCorrelation(correlationId, () => {
    log.component('#checkout').info('Starting checkout')
    log.component('#payment').info('Processing payment')
    log.signal('!checkout-complete').info('Order placed')
    // All logs include the same correlationId
})
```

---

## Implementation Checklist

When implementing the Paradigm logger in a new language:

- [ ] Symbol-typed methods: `log.component()`, `log.gate()`, `log.signal()`, `log.flow()`, `log.aspect()`
- [ ] Log levels: debug, info, warn, error
- [ ] Duration tracking: `.start()` → `.success()` / `.error()`
- [ ] Structured data parameter on all methods
- [ ] Level filtering via environment variable
- [ ] Symbol filtering via environment variable
- [ ] Pretty format for development
- [ ] JSON format for production
- [ ] Correlation ID support
- [ ] Timestamp in output

---

## Portal Validation

For authorization decisions that need to be validated by AI agents, use the **Portal Validator** alongside the standard logger. The Portal Validator emits structured decision logs:

```
┌─────────────────────────────────────────────────────────
│ 🚪 PORTAL CHECK: ^subscription-required
│ ├─ Requires: active subscription, trial not exceeded
│ ├─ Context: { userId: "abc123", plan: "growth" }
│ ├─ Decision: ✅ ALLOW
│ └─ Reason: Subscription valid - growth plan active
└─────────────────────────────────────────────────────────
```

Use cases:
- **`log.gate()`** - General gate-related logging and debugging
- **`portal.check()`** - Authorization decisions that need validation

See [Portal Validation Specification](./portal-validation.md) for full details.

---

## Reference Implementations

See working implementations in:
- **TypeScript (Browser):** Pattern with CSS console styling
- **TypeScript (Node.js):** Pattern with ANSI codes + AsyncLocalStorage
- **Python:** Pattern with logging module
- **Go:** Pattern with structured logging
- **Rust:** Pattern with tracing crate
