# agentic-commerce - Claude Context

## Naming
No single-character identifiers, ever — not even loop counters or `catch (e)`. Use short,
descriptive names: `conversation` not `c`, `index` not `i`, `error` not `e`. Descriptive ≠
verbose: `rule`, `contact`, `message` are right; `theConversationObject` is not.

## Comments
Comment *why*, never *what*. The code already says what it does.
- Keep: rationale, security/ordering constraints, edge cases, workarounds for external API quirks.
- Delete: anything that paraphrases the line below it, or labels structure (`// loop over rules`,
  `// Metrics`).
- If a comment is explaining a confusing line, fix the line instead (rename, extract, split)
  rather than annotate it.

## DRY & Reuse
Before writing a literal, type, helper, or response shape, search for an existing one first.
- Define enum-like ids once as a `const` object; derive the union type from it.
- Flag: literals repeated in 3+ places, copy-pasted blocks (auth preambles, error shapes),
  hand-rolled versions of existing helpers.
- Watch for *conceptual* duplication too — two functions with the same shape but renamed
  variables. Automated dup checkers only catch textual clones.

## Maintainability & Altitude
- Fix the underlying mechanism, don't stack another special-case branch on top.
- One module/file, one concern — split a "context"/"utils" file once it accretes unrelated things.
- Sibling code (two handlers, two cron jobs, two send paths) should share the same shape and
  primitives.
- **Uniformity default:** a cross-cutting concern (logging, timing, auth checks, error mapping)
  added to one sibling must be added to *all* siblings.

## Performance
- Batch independent async calls with `Promise.all` instead of sequential awaits.
- Never scan/list "all rows for user" without a filter — paginate or index instead.
- Index every column used in a filter or `order by`.
- Instrument duration on hot-path routes, multi-step I/O fan-outs, external API calls, and
  cron/queue jobs — skip pure functions and single-row reads.

## Commit Messages
`type(scope): short description` — conventional commits. Body explains why, not what.

## Before Implementing
- Non-trivial task (3+ files)? Sketch a short plan first.
- Touching a public/shared interface? Check who else calls it before changing its shape.

## Reviewer Checklist
When reviewing a diff (including a self-PR), flag:
- Single-char identifiers.
- Comments restating code, or comments masking an unclear name.
- Repeated literals/helpers that should be centralized.
- A special case that should've generalized existing logic instead.
- A cross-cutting concern applied to one sibling but not its peers.
- Sequential awaits that should be parallel; unbounded queries; missing indexes.
