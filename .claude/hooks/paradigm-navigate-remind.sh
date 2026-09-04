#!/bin/sh
# Paradigm Claude Code PreToolUse — Navigation Reminder
# Fires before Glob/Grep tool calls to inject scan-index context and prompt
# paradigm_navigate usage before broad file searches.
# Installed by: paradigm hooks install --claude-code
#
# Hook type: PreToolUse (matcher: Glob|Grep)
# Exit 0 = always allows (advisory only — never blocks)
#
# Advisory model: lightweight context injection that fires once per session.
# Unlike a pure text reminder, this reads the scan-index $meta and surfaces
# the symbol counts directly — agents can act on the context immediately
# without a separate tool call.
# Uses a session marker (.paradigm/.nav-reminded) to fire at most once.

# Read JSON from stdin (hook input)
INPUT=$(cat)

# Extract cwd from input
if command -v jq >/dev/null 2>&1; then
  CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
else
  CWD=$(echo "$INPUT" | grep -o '"cwd"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"cwd"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
fi

if [ -z "$CWD" ]; then
  CWD="$(pwd)"
fi

# Not a paradigm project — pass
if [ ! -d "$CWD/.paradigm" ]; then
  exit 0
fi

# Only remind once per session
MARKER="$CWD/.paradigm/.nav-reminded"
if [ -f "$MARKER" ]; then
  exit 0
fi

# Extract tool name to check we're in a search/read context
if command -v jq >/dev/null 2>&1; then
  TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
else
  TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"tool_name"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
fi

# Only fire for broad exploration tools (Glob/Grep) — not targeted Read calls
case "$TOOL_NAME" in
  Glob|Grep) ;;
  *) exit 0 ;;
esac

# Mark as reminded so this only fires once per session
touch "$MARKER" 2>/dev/null

# Read scan-index $meta for symbol counts (optional — graceful fallback)
SCAN_INDEX="$CWD/.paradigm/scan-index.json"
SYMBOL_SUMMARY=""
if [ -f "$SCAN_INDEX" ] && command -v jq >/dev/null 2>&1; then
  COMP_COUNT=$(jq '(.components // {}) | length' "$SCAN_INDEX" 2>/dev/null)
  FEAT_COUNT=$(jq '(.features // {}) | length' "$SCAN_INDEX" 2>/dev/null)
  FLOW_COUNT=$(jq '(.flows // {}) | length' "$SCAN_INDEX" 2>/dev/null)
  GATE_COUNT=$(jq '(.gates // {}) | length' "$SCAN_INDEX" 2>/dev/null)
  if [ -n "$COMP_COUNT" ] && [ -n "$FEAT_COUNT" ]; then
    SYMBOL_SUMMARY=" ($COMP_COUNT components, $FEAT_COUNT features, $FLOW_COUNT flows, $GATE_COUNT gates indexed)"
  fi
fi

# Emit context injection (non-blocking)
echo "" >&2
echo "[paradigm] Context available — use paradigm_navigate before searching.$SYMBOL_SUMMARY" >&2
echo "  paradigm_navigate({ intent: \"context\", task: \"<your task>\" })" >&2
echo "  Returns relevant .purpose files, symbols, and file paths — skips blind Glob/Grep." >&2
echo "  Scan index: $SCAN_INDEX" >&2
echo "  Navigator:  $CWD/.paradigm/navigator.yaml" >&2

exit 0
