---
applyTo: "**/*.ts,**/*.tsx,**/*.js,**/*.jsx"
---
# Paradigm Logging

## Paradigm Logging

**IMPORTANT:** Use the Paradigm logger instead of raw console.log/print.

```
// Use this pattern:
log.component('#login-handler').info('Starting login', { email });
log.component('#database').debug('Query executed', { duration });
log.gate('^authenticated').warn('Access denied', { userId });
log.signal('!login-success').info('User authenticated');
```

### Symbol Mapping by Directory

| Directory | Symbol | Logger Method |
|-----------|--------|---------------|
| `services/**` | `#` | `log.component()` |
| `routes/**` | `#` | `log.component()` |
| `api/**` | `#` | `log.component()` |
| `models/**` | `#` | `log.component()` |
| `lib/**` | `#` | `log.component()` |
| `utils/**` | `#` | `log.component()` |
| `core/**` | `#` | `log.component()` |
| `config/**` | `#` | `log.component()` |
| `middleware/**` | `^` | `log.gate()` |
| `auth/**` | `^` | `log.gate()` |
| `guards/**` | `^` | `log.gate()` |
| `policies/**` | `^` | `log.gate()` |
| `events/**` | `!` | `log.signal()` |
| `handlers/**` | `!` | `log.signal()` |
| `listeners/**` | `!` | `log.signal()` |
| `flows/**` | `$` | `log.flow()` |
| `workflows/**` | `$` | `log.flow()` |
| `pipelines/**` | `$` | `log.flow()` |
| `aspects/**` | `~` | `log.aspect()` |
| `rules/**` | `~` | `log.aspect()` |

See `.paradigm/specs/logger.md` for full specification.

