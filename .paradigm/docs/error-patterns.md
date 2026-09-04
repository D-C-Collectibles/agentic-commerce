# Error Patterns

> Standard error handling across the project (Language-Agnostic)

## Error Response Format

All APIs/services return errors in this format:

```
// Error response
{
  error: string       // Human-readable message
  code?: string       // Machine-readable code (optional)
}

// Success response  
{
  success?: true      // Optional confirmation
  data?: any          // Response payload
}
```

## Standard Error Codes

| Code | Meaning | When to Use |
|------|---------|-------------|
| `INVALID_REQUEST` | Malformed input | Missing fields, wrong types |
| `INVALID_CREDENTIALS` | Auth validation failed | Wrong password, expired token |
| `UNAUTHORIZED` | Not authenticated | Missing/expired session |
| `FORBIDDEN` | Authenticated but denied | Insufficient permissions |
| `NOT_FOUND` | Resource doesn't exist | Unknown ID, deleted item |
| `CONFLICT` | State conflict | Duplicate entry, version mismatch |
| `RATE_LIMITED` | Too many requests | Brute force protection |
| `SERVER_ERROR` | Internal error | Database down, unexpected crash |
| `UNAVAILABLE` | Service unavailable | Maintenance, overloaded |

## Patterns (Pseudocode)

### Basic Error Return

```
// Simple error
return error_response("Invalid request", status=400)

// With code
return error_response("Too many attempts", code="RATE_LIMITED", status=429)
```

### Input Validation

```
function handle_request(request):
    data = parse_json(request.body)
    
    if data is null:
        return error_response("Invalid request body", status=400)
    
    if not valid_email(data.email):
        return error_response("Valid email required", status=400)
    
    // Continue processing...
```

### Auth Check

```
function require_auth(request):
    user = get_user_from_session(request)
    
    if user is null:
        return error_response("Unauthorized", status=401)
    
    return user
```

### Resource Access

```
function get_resource(id):
    resource = database.find(id)
    
    if resource is null:
        return error_response("Not found", status=404)
    
    if not user_can_access(resource):
        return error_response("Forbidden", status=403)
    
    return success_response(resource)
```

### Database Operations

```
function query_database(query, params):
    try:
        result = db.execute(query, params)
        return result
    catch DatabaseError as error:
        log.component('#database').error('Query failed', { error })
        return error_response("Database error", status=500)
```

## Error Handling Flow

```
┌─────────────────┐
│  Receive Input  │
└────────┬────────┘
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Validate Input  │────▶│ 400 Bad Request │
└────────┬────────┘ no  └─────────────────┘
         │ yes
         ▼
┌─────────────────┐     ┌─────────────────┐
│   Check Auth    │────▶│ 401 Unauthorized│
└────────┬────────┘ no  └─────────────────┘
         │ yes
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Check Permission│────▶│  403 Forbidden  │
└────────┬────────┘ no  └─────────────────┘
         │ yes
         ▼
┌─────────────────┐     ┌─────────────────┐
│  Find Resource  │────▶│  404 Not Found  │
└────────┬────────┘ no  └─────────────────┘
         │ yes
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Execute Action  │────▶│ 500 Server Error│
└────────┬────────┘ fail└─────────────────┘
         │ ok
         ▼
┌─────────────────┐
│  200 Success    │
└─────────────────┘
```

## Logging Errors

Always use the Paradigm logger:

```
// Component context (features)
log.component('#checkout').error('Payment failed', { reason, order_id })

// Component context (infrastructure)
log.component('#database').error('Connection lost', { host })

// Gate context
log.gate('^auth').warn('Access denied', { user_id, resource })

// Component context (integrations)
log.component('#stripe-client').error('API error', { status, message })
```

## Graceful Degradation

When non-critical features fail, don't block the user:

```
// Bad: crashes if optional feature fails
data = fetch_optional_feature()  // throws on error

// Good: graceful fallback
data = null
try:
    data = fetch_optional_feature()
catch:
    log.component('#optional').debug('Feature unavailable, using fallback')

// Continue with or without optional data
```

## Client-Side Handling

```
function api_call(endpoint, options):
    try:
        response = http.request(endpoint, options)
        
        if not response.ok:
            return { error: response.data.error or "Request failed" }
        
        return { data: response.data }
    catch NetworkError:
        return { error: "Connection error" }
```

## Error State in UI

```
// State
error = null

function submit():
    error = null  // Clear previous error
    
    result = api_call('/endpoint', data)
    
    if result.error:
        error = result.error
        return
    
    // Success handling...

// Display
if error:
    show_error_message(error)
```

---

*Part of Paradigm v2.0 - Language Agnostic*
