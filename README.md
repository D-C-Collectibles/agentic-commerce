# agentic-commerce
agentic commerce hackathon library

## AI tool usage

Built with Claude Code, using a spec-driven workflow (Paradigm). All planning artifacts are
tracked in this repo, not just the generated code:

- `prompts.jsonl` — every prompt sent to Claude Code, auto-logged via a `UserPromptSubmit` hook
  (see `CLAUDE.md`).
- `.paradigm/specs/` — architecture specs written before implementation (e.g.
  `wallet-checkout.md`).
- `.paradigm/orchestrations/`, `.paradigm/tasks/` — multi-agent (architect/security/reviewer)
  planning runs behind specific features.
- `.purpose` files alongside source — document what each component does and which gates/signals
  it touches, kept in sync with the code.

AI tools assisted implementation; see git history and `prompts.jsonl` for what was directed vs.
written by hand.
