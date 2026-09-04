#!/bin/sh
# Paradigm Cursor PostToolUse Hook — Advisory Feedback
# Fires AFTER the agent calls Edit or Write.
# Tracks modified source files and outputs advisory the agent can see.
# Installed by: paradigm hooks install --cursor
#
# Hook type: postToolUse
# Matcher: Edit|Write
# Exit 0 always (never blocks — advisory only)
#
# Unlike afterFileEdit, postToolUse output is visible to the Cursor agent.
# This is the primary advisory mechanism for Cursor enforcement.

# Read JSON from stdin (hook input)
INPUT=$(cat)

# Extract file_path from postToolUse input
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // .input.file_path // empty' 2>/dev/null)
else
  FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
fi

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Extract workspace root
if command -v jq >/dev/null 2>&1; then
  CWD=$(echo "$INPUT" | jq -r '.workspace_roots[0] // empty' 2>/dev/null)
else
  CWD=$(echo "$INPUT" | grep -o '"workspace_roots"[[:space:]]*:[[:space:]]*\["[^"]*"' | head -1 | sed 's/.*\["//' | sed 's/"$//')
fi

if [ -z "$CWD" ]; then
  CWD="$(pwd)"
fi

# Not a paradigm project — pass
if [ ! -d "$CWD/.paradigm" ]; then
  exit 0
fi

cd "$CWD" || exit 0

# Pseudo-session-start: first edit of session emits one-time guidance
if [ ! -f ".paradigm/.session-started" ]; then
  PREV_PENDING=$(cat .paradigm/.pending-review 2>/dev/null | wc -l | tr -d ' ')
  if [ "$PREV_PENDING" -gt 0 ] 2>/dev/null; then
    echo "[paradigm] Session started. $PREV_PENDING uncovered edit(s) from last session." >&2
  fi
  touch ".paradigm/.session-started"
fi

# Convert to relative path
REL_PATH="$FILE_PATH"
case "$FILE_PATH" in
  "$CWD"/*) REL_PATH=$(echo "$FILE_PATH" | sed "s|^$CWD/||") ;;
esac

# If still absolute, file is outside project — skip
case "$REL_PATH" in
  /*) exit 0 ;;
esac

# Skip non-source files
case "$REL_PATH" in
  *.purpose|portal.yaml|*.md|*.lock|*.log|*.json|*.yaml|*.yml|.gitignore|.env*) exit 0 ;;
esac

# Skip .paradigm, .claude, and .cursor directories
case "$REL_PATH" in
  .paradigm/*|.claude/*|.cursor/*) exit 0 ;;
esac

# Track: append to .paradigm/.pending-review (deduplicated)
PENDING_FILE=".paradigm/.pending-review"
if [ -f "$PENDING_FILE" ]; then
  if ! grep -qxF "$REL_PATH" "$PENDING_FILE" 2>/dev/null; then
    echo "$REL_PATH" >> "$PENDING_FILE"
  fi
else
  echo "$REL_PATH" > "$PENDING_FILE"
fi

# Count pending files
PENDING_COUNT=$(wc -l < "$PENDING_FILE" | tr -d ' ')

# Walk up from the file's directory to find a .purpose file
dir=$(dirname "$REL_PATH")
found_purpose=""

while [ "$dir" != "." ] && [ "$dir" != "/" ] && [ "$dir" != "" ]; do
  if [ -f "$dir/.purpose" ]; then
    found_purpose="$dir/.purpose"
    break
  fi
  dir=$(dirname "$dir")
done

# Check root .purpose
if [ -z "$found_purpose" ] && [ -f ".purpose" ]; then
  found_purpose=".purpose"
fi

if [ -z "$found_purpose" ]; then
  file_dir=$(dirname "$REL_PATH")
  echo "" >&2
  echo "[paradigm] No .purpose file covers $file_dir/" >&2
  echo "  Create one: paradigm_purpose_init + paradigm_purpose_add_component" >&2
  echo "  $PENDING_COUNT file(s) pending review. The stop hook WILL BLOCK." >&2
elif [ "$PENDING_COUNT" -gt 0 ] && [ "$((PENDING_COUNT % 3))" -eq 0 ]; then
  echo "" >&2
  echo "[paradigm] $PENDING_COUNT source file(s) modified. Update $found_purpose:" >&2
  echo "  -> #components, ~aspects (with anchors), !signals, \$flows, ^gates" >&2
  echo "  The stop hook WILL BLOCK if .purpose files aren't updated." >&2
fi

# Context budget heuristic: suggest handoff check at high edit counts
if [ "$PENDING_COUNT" -ge 30 ]; then
  echo "[paradigm] ~$PENDING_COUNT edits this session. Consider preparing handoff." >&2
fi

exit 0
