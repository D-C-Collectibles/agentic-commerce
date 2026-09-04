#!/bin/sh
# Paradigm Claude Code PreToolUse — Team Edit Gate (advisory tier)
# Fires before Write/Edit tool calls. If source code is about to be edited in a
# session that has neither orchestrated nor declared solo, emits a one-time
# advisory. Second line of defense after the prompt-gate (UserPromptSubmit) —
# catches sessions where the task only became implementation-shaped mid-way.
#
# Hook type: PreToolUse (matcher: Write|Edit)
# Exit 0 = always allows (advisory only — never blocks at this tier).
# Graduation to a blocking guard happens only after baseline telemetry
# justifies it (Loid: "advisory-everywhere first, four weeks minimum").
#
# Uses a session marker (.paradigm/.team-reminded) to fire at most once.
# Escape hatch: PARADIGM_TEAM_GATE=off

# Read JSON from stdin (hook input)
INPUT=$(cat)

# Kill switch
if [ "$PARADIGM_TEAM_GATE" = "off" ]; then
  exit 0
fi

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

# Markers expire by age, NOT by Stop-hook clearing (Stop fires per turn).
TTL_MIN=$(( ${PARADIGM_GATE_TTL_HOURS:-4} * 60 ))
marker_fresh() {
  [ -f "$1" ] || return 1
  [ -n "$(find "$1" -mmin "-$TTL_MIN" 2>/dev/null)" ]
}

# Session already resolved the gate — pass
if [ -f "$CWD/.paradigm/.orchestrated" ] || marker_fresh "$CWD/.paradigm/.solo-declared"; then
  exit 0
fi

# Only remind once per TTL window
MARKER="$CWD/.paradigm/.team-reminded"
if marker_fresh "$MARKER"; then
  exit 0
fi

# Extract the target file path
if command -v jq >/dev/null 2>&1; then
  FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
else
  FILE_PATH=$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
fi

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only fire for source files — docs/config/purpose edits are not team-eligible
case "$FILE_PATH" in
  *.md|*.markdown|*.yaml|*.yml|*.json|*.txt|*.purpose) exit 0 ;;
  */docs/*|*/.paradigm/*) exit 0 ;;
esac

# Mark as reminded so this only fires once per session
touch "$MARKER" 2>/dev/null

# Record the edit-advisory event (telemetry)
EVENTS_DIR="$CWD/.paradigm/events"
mkdir -p "$EVENTS_DIR" 2>/dev/null
FILE_BASE=$(basename -- "$FILE_PATH" | tr -cd 'a-zA-Z0-9._-' | head -c 60)
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"timestamp\":\"$TS\",\"type\":\"edit-advisory\",\"source\":\"team-gate\",\"file\":\"$FILE_BASE\"}" >> "$EVENTS_DIR/team-funnel.jsonl" 2>/dev/null

# Emit advisory (non-blocking)
echo "" >&2
echo "[paradigm] Source edit without team orchestration this session." >&2
echo "  Standing opt-in exists: run paradigm_orchestrate_inline (mode=\"plan\") to engage the team," >&2
echo "  or declare solo explicitly: paradigm solo <trivial|hotfix|user-directed|exploratory> [note]" >&2
echo "  Undeclared solo work on eligible tasks is recorded as a bypass at session end." >&2

exit 0
