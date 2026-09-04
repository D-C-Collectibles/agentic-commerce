#!/bin/sh
# UserPromptSubmit hook — auto-logs every prompt to prompts.jsonl (hackathon requirement, see CLAUDE.md).
# Advisory only: never blocks the prompt, even if logging fails.

INPUT=$(cat)

if command -v jq >/dev/null 2>&1; then
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
  PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
else
  CWD=$(echo "$INPUT" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"cwd"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
  PROMPT=$(echo "$INPUT" | grep -o '"prompt"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"prompt"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
fi

[ -z "$CWD" ] && CWD="$(pwd)"
[ -z "$PROMPT" ] && exit 0
[ -f "$CWD/scripts/log-prompt.mjs" ] || exit 0

node "$CWD/scripts/log-prompt.mjs" "$PROMPT" >/dev/null 2>&1

exit 0
