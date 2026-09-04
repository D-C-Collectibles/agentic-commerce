# Agent CLI Queries (Token-Efficient)

Instead of reading large context files, query Paradigm CLI on-demand for fresh, precise data.

## When to Query

| Before doing this... | Run this command |
|---------------------|------------------|
| Modifying a symbol | `paradigm ripple #symbol --json` |
| Debugging an error | `paradigm echo ERROR_CODE --json` |
| Starting a session | `paradigm thread --json` |
| Understanding relationships | `paradigm constellation` |
| Getting oriented | `paradigm beacon --json` |

## Query Patterns

### Before Changing Code

```bash
# See what depends on what you're changing
paradigm ripple #checkout --json

# Output includes: upstream deps, downstream effects, flow membership
```

### When Debugging

```bash
# Look up error context
paradigm echo AUTH_REQUIRED --json

# Then check ripple effects of the related symbol
paradigm ripple ^authenticated --json
```

### Starting Work

```bash
# Check previous session context
paradigm thread --json

# Quick orientation
paradigm beacon --json
```

### Querying Constellation

```bash
# Get specific symbol
jq '.stars["#checkout"]' .paradigm/constellation.json

# Find what requires a gate
jq '[.stars | to_entries[] | select(.value.gates[]? == "^authenticated") | .key]' .paradigm/constellation.json

# List all flows
jq '.orbits | keys' .paradigm/constellation.json
```

## Benefits

- **Fresh data**: Always current, not stale from file generation
- **Precise**: Only get the data you need
- **Token-efficient**: ~100 tokens per query vs ~2000 upfront
