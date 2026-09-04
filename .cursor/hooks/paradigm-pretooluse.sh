#!/bin/sh
# Paradigm Cursor PreToolUse Hook — Graduated Blocking
# Fires BEFORE the agent calls Edit or Write.
# Uses graduated enforcement based on uncovered source edits.
# Installed by: paradigm hooks install --cursor
#
# Hook type: preToolUse
# Matcher: Edit|Write
# Exit 0 = allow, Exit 2 = block with stderr message
#
# Graduated enforcement:
#   1-2 uncovered edits → silent pass (exit 0)
#   3-4 uncovered edits → warn via stderr (exit 0)
#   5+  uncovered edits → BLOCK (exit 2 + stderr)

# Read JSON from stdin (hook input)
INPUT=$(cat)

# Extract tool_name and file_path from preToolUse input
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
  FILE_PATH=$(echo "$INPUT" | jq -r '.file_path // .input.file_path // empty' 2>/dev/null)
else
  TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
  FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
fi

# Must have a file path to check
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

# Convert to relative path
REL_PATH="$FILE_PATH"
case "$FILE_PATH" in
  "$CWD"/*) REL_PATH=$(echo "$FILE_PATH" | sed "s|^$CWD/||") ;;
esac

# If still absolute, file is outside project — skip
case "$REL_PATH" in
  /*) exit 0 ;;
esac

# Skip non-source files (paradigm metadata, docs, config)
case "$REL_PATH" in
  *.purpose|portal.yaml|*.md|*.lock|*.log|*.json|*.yaml|*.yml|.gitignore|.env*) exit 0 ;;
esac

# Skip .paradigm, .claude, and .cursor directories
case "$REL_PATH" in
  .paradigm/*|.claude/*|.cursor/*) exit 0 ;;
esac

# Check if target file has a covering .purpose file
dir=$(dirname "$REL_PATH")
has_purpose=false

while [ "$dir" != "." ] && [ "$dir" != "/" ] && [ "$dir" != "" ]; do
  if [ -f "$dir/.purpose" ]; then
    has_purpose=true
    break
  fi
  dir=$(dirname "$dir")
done

# Check root .purpose
if [ "$has_purpose" = false ] && [ -f ".purpose" ]; then
  has_purpose=true
fi

# If this file already has .purpose coverage, always allow
if [ "$has_purpose" = true ]; then
  exit 0
fi

# Count uncovered source edits from .pending-review
PENDING_FILE=".paradigm/.pending-review"
UNCOVERED_COUNT=0

if [ -f "$PENDING_FILE" ]; then
  while IFS= read -r tracked_file; do
    [ -z "$tracked_file" ] && continue
    # Check if this tracked file has .purpose coverage
    check_dir=$(dirname "$tracked_file")
    found=false
    while [ "$check_dir" != "." ] && [ "$check_dir" != "/" ] && [ "$check_dir" != "" ]; do
      if [ -f "$check_dir/.purpose" ]; then
        found=true
        break
      fi
      check_dir=$(dirname "$check_dir")
    done
    if [ "$found" = false ] && [ -f ".purpose" ]; then
      found=true
    fi
    if [ "$found" = false ]; then
      UNCOVERED_COUNT=$((UNCOVERED_COUNT + 1))
    fi
  done < "$PENDING_FILE"
fi

# Include the current file (not yet tracked)
UNCOVERED_COUNT=$((UNCOVERED_COUNT + 1))

# Graduated enforcement
if [ "$UNCOVERED_COUNT" -le 2 ]; then
  # Silent pass — don't slow down small fixes
  exit 0
elif [ "$UNCOVERED_COUNT" -le 4 ]; then
  # Warn but allow
  echo "" >&2
  echo "[paradigm] Warning: $UNCOVERED_COUNT source files modified without .purpose coverage." >&2
  echo "  Update the nearest .purpose file before the stop hook blocks you." >&2
  echo "  Use: paradigm_purpose_init + paradigm_purpose_add_component" >&2
  exit 0
else
  # Block — too many uncovered edits
  echo "" >&2
  echo "[paradigm] BLOCKED: $UNCOVERED_COUNT source files modified without .purpose coverage." >&2
  echo "  You must update .purpose files before continuing." >&2
  echo "  Steps:" >&2
  echo "    1. paradigm_purpose_init — create .purpose in uncovered directories" >&2
  echo "    2. paradigm_purpose_add_component — register code units" >&2
  echo "    3. paradigm_reindex — rebuild the index" >&2
  echo "  Then retry your edit." >&2
  exit 2
fi
