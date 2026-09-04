#!/bin/sh
# Paradigm Cursor Pre-Commit Hook
# Intercepts git commit shell executions and auto-rebuilds the index.
# Installed by: paradigm hooks install --cursor
#
# Hook type: beforeShellExecution (matcher: "git commit")
# Exit 0 = allow (never blocks), just ensures index is fresh

# Read JSON from stdin (hook input)
INPUT=$(cat)

# Extract the command from Cursor's beforeShellExecution input
if command -v jq >/dev/null 2>&1; then
  COMMAND=$(echo "$INPUT" | jq -r '.command // .shellCommand // empty' 2>/dev/null)
else
  COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
fi

# If command doesn't contain "git commit", pass through
case "$COMMAND" in
  *"git commit"*) ;;
  *) exit 0 ;;
esac

# If no .paradigm directory, not a paradigm project
if [ ! -d ".paradigm" ]; then
  exit 0
fi

# Run paradigm index --quiet (the existing CLI command)
if command -v paradigm >/dev/null 2>&1; then
  paradigm index --quiet 2>/dev/null || true
elif command -v npx >/dev/null 2>&1; then
  npx paradigm index --quiet 2>/dev/null || true
fi

# Stage the rebuilt files if they exist
for f in .paradigm/scan-index.json .paradigm/navigator.yaml .paradigm/flow-index.json; do
  if [ -f "$f" ]; then
    git add "$f" 2>/dev/null || true
  fi
done

# Never block — exit 0
exit 0
