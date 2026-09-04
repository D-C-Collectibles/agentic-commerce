#!/bin/sh
# Paradigm Claude Code UserPromptSubmit — Team Invocation Gate (advisory tier)
# Fires on every user prompt. If the task looks orchestration-eligible and the
# session has neither orchestrated nor declared solo, injects a decision-time
# directive into the model's context (UserPromptSubmit stdout = context).
#
# Why decision-time: CLAUDE.md "always use the team" instructions sit far back
# in context and lose to the model's action bias. A directive injected at the
# moment of decision is deterministic — it fires 100% of the time.
#
# Hook type: UserPromptSubmit
# Exit 0 = always (advisory only — never blocks)
#
# Telemetry: every eligible prompt appends an `eligible` event to
# .paradigm/events/team-funnel.jsonl (even when the directive is capped),
# so the classifier's false-positive rate and the team-invocation rate are
# measurable from day one. Loid calibrates the gate from this data.
#
# Escape hatches: PARADIGM_TEAM_GATE=off env var; `paradigm solo <reason>`
# declares a legible solo session; orchestrating clears the gate naturally.

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

# Markers expire by age, NOT by Stop-hook clearing — the Stop hook fires per
# assistant turn, so clearing there would erase solo declarations mid-session
# and turn the once-per-session cap into once-per-turn nagging. TTL default 4h.
TTL_MIN=$(( ${PARADIGM_GATE_TTL_HOURS:-4} * 60 ))
marker_fresh() {
  [ -f "$1" ] || return 1
  [ -n "$(find "$1" -mmin "-$TTL_MIN" 2>/dev/null)" ]
}

# Session already resolved the gate (team ran, or solo was declared) — pass
if [ -f "$CWD/.paradigm/.orchestrated" ] || marker_fresh "$CWD/.paradigm/.solo-declared"; then
  exit 0
fi

# Extract the prompt text
if command -v jq >/dev/null 2>&1; then
  PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
else
  PROMPT=$(printf '%s' "$INPUT" | grep -o '"prompt"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"prompt"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')
fi

# Too short to be a task (confirmations, "yes", "continue") — pass
if [ "${#PROMPT}" -lt 24 ]; then
  exit 0
fi

# Eligibility: implementation-shaped verbs. Deliberately simple — the funnel
# telemetry measures this classifier's false-positive rate; tune from data.
# printf (not echo): a prompt starting with -n/-e must not be mangled.
MATCHED=$(printf '%s\n' "$PROMPT" | grep -ioE 'implement|build |fix |refactor|migrate|rewrite|integrate|add (a |an |the )?(feature|support|endpoint|command|tool|component)|create (a |an |the )?(feature|component|module|service)' | head -1)

if [ -z "$MATCHED" ]; then
  exit 0
fi

# Record the eligible event (telemetry fires every time, even when the
# directive itself is capped)
EVENTS_DIR="$CWD/.paradigm/events"
mkdir -p "$EVENTS_DIR" 2>/dev/null
MATCHED_CLEAN=$(printf '%s' "$MATCHED" | tr -cd 'a-zA-Z ' | head -c 40)
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"timestamp\":\"$TS\",\"type\":\"eligible\",\"source\":\"prompt-gate\",\"matched\":\"$MATCHED_CLEAN\"}" >> "$EVENTS_DIR/team-funnel.jsonl" 2>/dev/null

# Inject the directive at most once per TTL window (age-based, see above)
MARKER="$CWD/.paradigm/.team-prompted"
if marker_fresh "$MARKER"; then
  exit 0
fi
touch "$MARKER" 2>/dev/null

# stdout on UserPromptSubmit = injected into the model's context
echo "[paradigm] This task looks orchestration-eligible (matched: \"$MATCHED_CLEAN\")."
echo "Standing opt-in for team orchestration exists in this project. Before editing source:"
echo "  - Run paradigm_orchestrate_inline (mode=\"plan\") to engage the agent team, OR"
echo "  - Declare solo explicitly: \`paradigm solo <trivial|hotfix|user-directed|exploratory> [note]\`"
echo "Solo work on eligible tasks without a declaration is recorded as a bypass at session end."

exit 0
