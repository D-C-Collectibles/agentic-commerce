#!/bin/sh
# Paradigm Cursor Session Start Hook
# Fires before the agent does anything — injects additional_context
# that acts as a deterministic system prompt (not subject to context compaction).
# Installed by: paradigm hooks install --cursor
#
# Hook type: sessionStart
# Output: JSON with additional_context + continue: true
# Exit 0 always (never blocks)

# Read JSON from stdin (hook input)
INPUT=$(cat)

# Extract workspace root from Cursor's input
if command -v jq >/dev/null 2>&1; then
  CWD=$(echo "$INPUT" | jq -r '.workspace_roots[0] // empty' 2>/dev/null)
else
  CWD=$(echo "$INPUT" | grep -o '"workspace_roots"[[:space:]]*:[[:space:]]*\["[^"]*"' | head -1 | sed 's/.*\["//' | sed 's/"$//')
fi

if [ -z "$CWD" ]; then
  CWD="$(pwd)"
fi

# Not a paradigm project — pass without injection
if [ ! -d "$CWD/.paradigm" ]; then
  echo '{"continue":true}'
  exit 0
fi

# Build the additional_context payload
# This is injected as a system-level context that survives context compaction.

# Detect project characteristics for task-size guidance
HAS_PORTAL="false"
if [ -f "$CWD/portal.yaml" ]; then
  HAS_PORTAL="true"
fi

HAS_LORE="false"
if [ -d "$CWD/.paradigm/lore" ]; then
  HAS_LORE="true"
fi

HAS_FLOWS="false"
if [ -f "$CWD/.paradigm/flow-index.json" ]; then
  HAS_FLOWS="true"
fi

# Build context string (escaped for JSON)
CONTEXT="MANDATORY PARADIGM PROTOCOL — These rules are NON-NEGOTIABLE:\\n\\n"
CONTEXT="${CONTEXT}Rule 1: SESSION BOOKENDS\\n"
CONTEXT="${CONTEXT}  - FIRST action: Call paradigm_session_recover() to load previous session context\\n"
CONTEXT="${CONTEXT}  - LAST action before finishing: Call paradigm_pm_postflight() with filesModified and symbolsTouched\\n\\n"

CONTEXT="${CONTEXT}Rule 2: .PURPOSE UPDATES\\n"
CONTEXT="${CONTEXT}  - Every source file you modify MUST have a covering .purpose file\\n"
CONTEXT="${CONTEXT}  - Update the nearest .purpose file with: #components, ~aspects (with anchors), !signals\\n"
CONTEXT="${CONTEXT}  - The STOP HOOK WILL BLOCK you if .purpose files are not updated\\n\\n"

CONTEXT="${CONTEXT}Rule 3: RIPPLE BEFORE MODIFY\\n"
CONTEXT="${CONTEXT}  - Before modifying any existing symbol, call paradigm_ripple({ symbol: \\\"#symbol-name\\\" })\\n"
CONTEXT="${CONTEXT}  - This shows the blast radius — what else will break if you change it\\n\\n"

CONTEXT="${CONTEXT}ESSENTIAL MCP TOOLS:\\n"
CONTEXT="${CONTEXT}  paradigm_session_recover()          — Load previous session (call FIRST)\\n"
CONTEXT="${CONTEXT}  paradigm_ripple({ symbol })          — Check impact before modifying\\n"
CONTEXT="${CONTEXT}  paradigm_pm_postflight({ filesModified, symbolsTouched }) — Compliance check (call LAST)\\n"
CONTEXT="${CONTEXT}  paradigm_purpose_add_component({ path, name, description }) — Register code units\\n"
CONTEXT="${CONTEXT}  paradigm_reindex()                   — Rebuild indexes after .purpose changes\\n"
CONTEXT="${CONTEXT}  paradigm_lore_record({ type, title, summary, symbols_touched }) — Record session\\n"

if [ "$HAS_PORTAL" = "true" ]; then
  CONTEXT="${CONTEXT}  paradigm_gates_for_route({ method, path }) — Get auth gate suggestions for endpoints\\n"
  CONTEXT="${CONTEXT}  paradigm_portal_add_route({ method, path, gates }) — Register route with gates\\n"
fi

CONTEXT="${CONTEXT}\\nTASK-SIZE TIERS:\\n"
CONTEXT="${CONTEXT}  1 file:   Session bookends only (recover + postflight)\\n"
CONTEXT="${CONTEXT}  2-3 files: + ripple before modify + update .purpose files\\n"
CONTEXT="${CONTEXT}  3+ files:  + full workflow (ripple, .purpose, lore entry"

if [ "$HAS_PORTAL" = "true" ]; then
  CONTEXT="${CONTEXT}, portal.yaml for routes"
fi

if [ "$HAS_FLOWS" = "true" ]; then
  CONTEXT="${CONTEXT}, flow validation"
fi

CONTEXT="${CONTEXT})\\n"

if [ "$HAS_LORE" = "true" ]; then
  CONTEXT="${CONTEXT}\\nLORE: This project tracks session history. Record a lore entry when modifying 3+ source files.\\n"
fi

# Output JSON to stdout
printf '{"additional_context":"%s","continue":true}\n' "$CONTEXT"

exit 0
