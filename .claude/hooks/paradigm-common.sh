#!/bin/sh
# paradigm-common.sh — Shared compliance checks for Paradigm stop hooks
# Sourced by claude-code-stop.sh and cursor-stop.sh
#
# Caller must set:
#   CWD      — Project root directory (already cd'd into)
#   MODIFIED — Output of `git diff --name-only HEAD`
#
# Caller may set:
#   PARADIGM_AUTO_FIX — Set to "1" to auto-fix trivial violations (missing .purpose stubs, missing lore)
#
# Sets:
#   VIOLATIONS      — Newline-separated violation messages
#   VIOLATION_COUNT — Number of violations
#   ADVISORY        — Non-blocking advisory text
#   SOURCE_COUNT    — Number of modified source files
#   AUTO_FIXED      — Newline-separated auto-fix actions taken
#   AUTO_FIX_COUNT  — Number of auto-fixes applied
#
# Checks:
#   1. Source files modified without .purpose updates (threshold: 2+)
#   2. Modified source directories missing .purpose files entirely
#   3. Route-like patterns added without portal.yaml updates
#   4. Aspect anchor files that no longer exist
#   5. Per-directory .purpose freshness (tracked via .pending-review)
#   6. Aspect coverage advisory
#   7. Lore entry expected for significant sessions (3+ source files)
#   8. Blocking habits not satisfied (from unified compliance-check)
#   9. Purpose-required patterns from config.yaml
#  10. Aspect drift detection with auto-heal (from unified compliance-check)
#  11. Portal gate implementation compliance (from unified compliance-check)
#  12. Graduation failure tracking (auto-demotion)
#  13. Orchestration required for complex tasks
#  14. Active remediations from agent-authored .paradigm/remediations/ (v6.1)

VIOLATIONS=""
VIOLATION_COUNT=0
AUTO_FIXED=""
AUTO_FIX_COUNT=0
PARADIGM_AUTO_FIX="${PARADIGM_AUTO_FIX:-0}"

# --- Load enforcement config ---
ENFORCEMENT_MAP=""
if command -v paradigm >/dev/null 2>&1; then
  ENFORCEMENT_MAP=$(paradigm enforcement resolve --json 2>/dev/null) || true
fi

# Helper: get severity for a check ID
_check_severity() {
  _id="$1"
  _default="$2"
  if [ -z "$ENFORCEMENT_MAP" ]; then
    echo "$_default"
    return
  fi
  _val=$(echo "$ENFORCEMENT_MAP" | grep -o "\"$_id\":\"[^\"]*\"" | sed 's/.*":\"//' | sed 's/"//')
  if [ -n "$_val" ]; then
    echo "$_val"
  else
    echo "$_default"
  fi
}

# Read orchestration threshold
ORCH_THRESHOLD=3
if [ -n "$ENFORCEMENT_MAP" ]; then
  _ot=$(echo "$ENFORCEMENT_MAP" | grep -o '"orchestrationThreshold":[0-9]*' | sed 's/.*://')
  [ -n "$_ot" ] && ORCH_THRESHOLD="$_ot"
fi

# --- Detect compliance archetype on roster (v6.0.4) ---
# Sets HAS_COMPLIANCE_CLAIMANT=true iff .paradigm/roster.yaml has 'compliance'
# under its 'active:' list (block- or inline-array form). Falls back to false on
# missing/unparseable. Wave 1: helper only — no callers yet (Wave 2 wires Check
# 6 and Check 10 to consume this gate).
HAS_COMPLIANCE_CLAIMANT=false
_ROSTER_FILE=".paradigm/roster.yaml"
if [ -f "$_ROSTER_FILE" ]; then
  # Extract the 'active:' section: from 'active:' line until the next non-indented
  # top-level key, then look for 'compliance' as a list item or array entry.
  _ACTIVE_BLOCK=$(awk '/^active:/{flag=1; print; next} /^[A-Za-z]/{flag=0} flag' "$_ROSTER_FILE" 2>/dev/null)
  if echo "$_ACTIVE_BLOCK" | grep -Eq '(^[[:space:]]*-[[:space:]]*compliance[[:space:]]*$|[[\,[:space:]]compliance[\],[:space:]])'; then
    HAS_COMPLIANCE_CLAIMANT=true
  fi
fi

# --- Cache active remediations JSON (v6.1, consumed by Check 14) ---
# Single shell-out per stop-hook run. Helper outputs `[]` on every error path
# (missing dir, parse failure, missing binary) so this never breaks the hook.
_REMEDIATIONS_JSON="[]"
if command -v paradigm >/dev/null 2>&1; then
  _REMEDIATIONS_JSON=$(paradigm internal active-remediations --json 2>/dev/null) || _REMEDIATIONS_JSON="[]"
  [ -z "$_REMEDIATIONS_JSON" ] && _REMEDIATIONS_JSON="[]"
fi

# --- Cache .purpose file paths (avoid repeated find scans) ---
PURPOSE_CACHE=".paradigm/.purpose-paths"
if [ -f "$PURPOSE_CACHE" ]; then
  PURPOSE_PATHS=$(cat "$PURPOSE_CACHE")
else
  PURPOSE_PATHS=$(find . -name ".purpose" -not -path "*/node_modules/*" -not -path "*/.git/*" 2>/dev/null)
  if [ -n "$PURPOSE_PATHS" ]; then
    echo "$PURPOSE_PATHS" > "$PURPOSE_CACHE"
  fi
fi

# --- Check 1: Source files modified without .purpose updates ---
# Instead of counting total source files globally, check per-directory:
# only flag directories where source files were modified but no .purpose
# exists in that directory's ancestor chain OR the covering .purpose was not updated.
SOURCE_COUNT=0
PARADIGM_COUNT=0
UNCOVERED_SOURCE_DIRS=""

for file in $MODIFIED; do
  case "$file" in
    .paradigm/*|*.purpose|portal.yaml)
      PARADIGM_COUNT=$((PARADIGM_COUNT + 1))
      ;;
    *.md|*.lock|*.log|.gitignore|.env*|*.json) ;;
    *)
      SOURCE_COUNT=$((SOURCE_COUNT + 1))
      # Check if this file's directory has a covering .purpose that was modified
      src_dir=$(dirname "$file")
      covering=""
      walk_dir="$src_dir"
      while [ "$walk_dir" != "." ] && [ "$walk_dir" != "" ]; do
        if [ -f "$walk_dir/.purpose" ]; then
          covering="$walk_dir/.purpose"
          break
        fi
        walk_dir=$(dirname "$walk_dir")
      done
      if [ -z "$covering" ] && [ -f ".purpose" ]; then
        covering=".purpose"
      fi
      # If there IS a covering .purpose, check if it was modified too
      if [ -n "$covering" ]; then
        purpose_was_modified=false
        for mod_file in $MODIFIED; do
          if [ "$mod_file" = "$covering" ]; then
            purpose_was_modified=true
            break
          fi
        done
        if [ "$purpose_was_modified" = false ]; then
          # Deduplicate by directory
          case "$UNCOVERED_SOURCE_DIRS" in
            *"$src_dir"*) ;;
            *) UNCOVERED_SOURCE_DIRS="$UNCOVERED_SOURCE_DIRS $src_dir" ;;
          esac
        fi
      else
        # No .purpose at all — already caught by Check 2
        :
      fi
      ;;
  esac
done

# Only flag if there are uncovered directories AND zero paradigm files were touched
_SEV=$(_check_severity "purpose-coverage" "block")
if [ "$_SEV" != "off" ] && [ -n "$UNCOVERED_SOURCE_DIRS" ] && [ "$PARADIGM_COUNT" -eq 0 ]; then
  # Count uncovered dirs
  UNCOVERED_DIR_COUNT=0
  for _d in $UNCOVERED_SOURCE_DIRS; do
    UNCOVERED_DIR_COUNT=$((UNCOVERED_DIR_COUNT + 1))
  done
  if [ "$_SEV" = "block" ]; then
    VIOLATIONS="$VIOLATIONS
  - You modified source files in $UNCOVERED_DIR_COUNT director(ies) without updating their .purpose files:
   $UNCOVERED_SOURCE_DIRS
    Update the nearest .purpose file for each modified code area."
    VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
  else
    ADVISORY="$ADVISORY
  - (warn) Source files in $UNCOVERED_DIR_COUNT director(ies) modified without .purpose updates:
   $UNCOVERED_SOURCE_DIRS"
  fi
fi

# --- Check 2: Modified source directories missing .purpose files ---
DIRS_WITHOUT_PURPOSE=""

for file in $MODIFIED; do
  case "$file" in
    .paradigm/*|*.md|*.lock|*.log|.gitignore|.env*|*.json|*.purpose|portal.yaml) continue ;;
  esac

  dir=$(dirname "$file")
  # Walk up to find a .purpose file
  found_purpose=false
  check_dir="$dir"
  while [ "$check_dir" != "." ] && [ "$check_dir" != "" ]; do
    if [ -f "$check_dir/.purpose" ]; then
      found_purpose=true
      break
    fi
    check_dir=$(dirname "$check_dir")
  done
  # Also check root
  if [ "$found_purpose" = false ] && [ -f ".purpose" ]; then
    found_purpose=true
  fi

  if [ "$found_purpose" = false ]; then
    # Deduplicate directory names
    case "$DIRS_WITHOUT_PURPOSE" in
      *"$dir"*) ;;
      *) DIRS_WITHOUT_PURPOSE="$DIRS_WITHOUT_PURPOSE $dir" ;;
    esac
  fi
done

_SEV=$(_check_severity "purpose-exists" "block")
if [ "$_SEV" != "off" ] && [ -n "$DIRS_WITHOUT_PURPOSE" ]; then
  if [ "$PARADIGM_AUTO_FIX" = "1" ]; then
    # Auto-fix: create stub .purpose files for directories missing them
    for dir in $DIRS_WITHOUT_PURPOSE; do
      dir_basename=$(basename "$dir")
      cat > "$dir/.purpose" <<PURPOSEEOF
# Auto-generated .purpose stub — update with real descriptions
components:
  $dir_basename:
    description: "TODO: describe this component"
    tags: []
PURPOSEEOF
      AUTO_FIXED="$AUTO_FIXED
  - Created stub .purpose in $dir (update descriptions)"
      AUTO_FIX_COUNT=$((AUTO_FIX_COUNT + 1))
    done
  elif [ "$_SEV" = "block" ]; then
    VIOLATIONS="$VIOLATIONS
  - These directories have modified source files but no .purpose file anywhere in their path:
   $DIRS_WITHOUT_PURPOSE
    Create a .purpose file using paradigm_purpose_init + paradigm_purpose_add_component."
    VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
  else
    ADVISORY="$ADVISORY
  - (warn) Directories with modified source files but no .purpose file:
   $DIRS_WITHOUT_PURPOSE"
  fi
fi

# --- Check 3: Route patterns added without portal.yaml ---
_SEV=$(_check_severity "portal-gates" "block")
if [ "$_SEV" != "off" ]; then
  if [ -f "portal.yaml" ] || echo "$MODIFIED" | grep -q "portal.yaml"; then
    : # portal.yaml exists or was modified — OK
  else
    # Check if any modified files contain route-like patterns
    # Skip: test/spec/fixture files, markdown, and comment-only matches
    ROUTE_FILES=""
    for file in $MODIFIED; do
      # Skip test, spec, and fixture files entirely
      case "$file" in
        *test*|*spec*|*fixture*|*__tests__*|*__mocks__*|*.test.*|*.spec.*) continue ;;
      esac
      case "$file" in
        *.ts|*.js|*.tsx|*.jsx|*.py|*.rs|*.go)
          if [ -f "$file" ]; then
            # Grep for route patterns, then filter out comment lines and description strings
            ROUTE_MATCH=$(grep -nE '\.(get|post|put|patch|delete)\s*\(|router\.|app\.(get|post|put|delete)|@(Get|Post|Put|Delete)|#\[actix_web::(get|post)' "$file" 2>/dev/null \
              | grep -v '^\s*[0-9]*:\s*//' \
              | grep -v '^\s*[0-9]*:\s*\*' \
              | grep -v '^\s*[0-9]*:\s*#' \
              | grep -v '^\s*[0-9]*:\s*<!--' \
              | grep -v 'description:' \
              | grep -v 'summary:' \
              | grep -v 'comment:' \
              | grep -v '@example' \
              | grep -v '@see' \
              || true)
            if [ -n "$ROUTE_MATCH" ]; then
              ROUTE_FILES="$ROUTE_FILES $file"
            fi
          fi
          ;;
      esac
    done

    if [ -n "$ROUTE_FILES" ]; then
      if [ "$_SEV" = "block" ]; then
        VIOLATIONS="$VIOLATIONS
  - Route/endpoint patterns found in modified files but no portal.yaml exists:
   $ROUTE_FILES
    Create portal.yaml with gate definitions. Use paradigm_gates_for_route for suggestions."
        VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
      else
        ADVISORY="$ADVISORY
  - (warn) Route/endpoint patterns found without portal.yaml:
   $ROUTE_FILES"
      fi
    fi
  fi
fi

# --- Check 4: Aspect anchor files that no longer exist ---
_SEV=$(_check_severity "aspect-anchors" "block")
if [ "$_SEV" != "off" ]; then
  for purpose_file in $PURPOSE_PATHS; do
    if grep -q "anchors:" "$purpose_file" 2>/dev/null; then
      purpose_dir=$(dirname "$purpose_file")
      in_anchors=false
      while IFS= read -r line; do
        case "$line" in
          *"anchors:"*) in_anchors=true; continue ;;
          *"- "*)
            if [ "$in_anchors" = true ]; then
              anchor_path=$(echo "$line" | sed 's/.*- //' | sed 's/:.*//' | tr -d ' ')
              if [ -n "$anchor_path" ]; then
                # Try relative to .purpose dir first, then project root
                if [ ! -f "$purpose_dir/$anchor_path" ] && [ ! -f "./$anchor_path" ]; then
                  if [ "$_SEV" = "block" ]; then
                    VIOLATIONS="$VIOLATIONS
  - Aspect anchor '$anchor_path' in $purpose_file does not exist.
    Update the anchor or remove the stale aspect."
                    VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
                  else
                    ADVISORY="$ADVISORY
  - (warn) Aspect anchor '$anchor_path' in $purpose_file does not exist."
                  fi
                fi
              fi
            fi
            ;;
          *) in_anchors=false ;;
        esac
      done < "$purpose_file"
    fi
  done
fi

# --- Check 5: Per-directory .purpose freshness ---
# Uses .pending-review if available, plus a git-based fallback that cross-references
# modified source files against .purpose modification times.
PENDING_FILE=".paradigm/.pending-review"
STALE_PURPOSES=""

# Helper: record a stale .purpose (deduplicating)
_record_stale_purpose() {
  _cov="$1"
  case "$STALE_PURPOSES" in
    *"$_cov"*) ;;
    *) STALE_PURPOSES="$STALE_PURPOSES $_cov" ;;
  esac
}

# Strategy A: Use .pending-review tracking file if present
if [ -f "$PENDING_FILE" ]; then
  while IFS= read -r tracked_file; do
    [ -z "$tracked_file" ] && continue
    # Find covering .purpose for this tracked file
    check_dir=$(dirname "$tracked_file")
    covering_purpose=""
    while [ "$check_dir" != "." ] && [ "$check_dir" != "" ]; do
      if [ -f "$check_dir/.purpose" ]; then
        covering_purpose="$check_dir/.purpose"
        break
      fi
      check_dir=$(dirname "$check_dir")
    done
    if [ -z "$covering_purpose" ] && [ -f ".purpose" ]; then
      covering_purpose=".purpose"
    fi
    # Check if covering .purpose was also modified
    if [ -n "$covering_purpose" ]; then
      if ! echo "$MODIFIED" | grep -qxF "$covering_purpose"; then
        _record_stale_purpose "$covering_purpose"
      fi
    fi
  done < "$PENDING_FILE"
fi

# Strategy B: Git-based fallback — for each modified source file, check whether
# its covering .purpose was modified more recently (by filesystem mtime).
# This catches cases where .pending-review is missing or out of sync.
for file in $MODIFIED; do
  case "$file" in
    .paradigm/*|*.md|*.lock|*.log|.gitignore|.env*|*.json|*.purpose|portal.yaml) continue ;;
  esac
  [ -f "$file" ] || continue

  # Find covering .purpose
  check_dir=$(dirname "$file")
  covering_purpose=""
  while [ "$check_dir" != "." ] && [ "$check_dir" != "" ]; do
    if [ -f "$check_dir/.purpose" ]; then
      covering_purpose="$check_dir/.purpose"
      break
    fi
    check_dir=$(dirname "$check_dir")
  done
  if [ -z "$covering_purpose" ] && [ -f ".purpose" ]; then
    covering_purpose=".purpose"
  fi
  [ -n "$covering_purpose" ] || continue

  # Skip if .purpose was in the modified list (already updated this session)
  echo "$MODIFIED" | grep -qxF "$covering_purpose" && continue

  # Compare modification times: if source file is newer than .purpose, it's stale
  if [ -f "$covering_purpose" ]; then
    # Use portable stat-based mtime comparison (works on macOS + Linux)
    if command -v stat >/dev/null 2>&1; then
      # macOS stat: -f %m gives epoch seconds; Linux stat: -c %Y
      src_mtime=$(stat -f %m "$file" 2>/dev/null || stat -c %Y "$file" 2>/dev/null || echo "0")
      purpose_mtime=$(stat -f %m "$covering_purpose" 2>/dev/null || stat -c %Y "$covering_purpose" 2>/dev/null || echo "0")
      if [ "$src_mtime" -gt "$purpose_mtime" ] 2>/dev/null; then
        _record_stale_purpose "$covering_purpose"
      fi
    fi
  fi
done

_SEV=$(_check_severity "purpose-freshness" "warn")
if [ "$_SEV" != "off" ] && [ -n "$STALE_PURPOSES" ]; then
  if [ "$_SEV" = "block" ]; then
    VIOLATIONS="$VIOLATIONS
  - These .purpose files cover modified source code but were NOT updated:
   $STALE_PURPOSES
    Update each with: #components, ~aspects (with anchors), !signals, \$flows, ^gates."
    VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
  else
    ADVISORY="$ADVISORY
  - (warn) These .purpose files cover modified source code but were NOT updated:
   $STALE_PURPOSES"
  fi
fi

# --- Check 6: Aspect coverage advisory ---
ADVISORY=""
_SEV=$(_check_severity "aspect-advisory" "warn")
if [ "$_SEV" != "off" ]; then
  HAS_ASPECTS=false
  for purpose_file in $PURPOSE_PATHS; do
    if grep -qE '^\s*~' "$purpose_file" 2>/dev/null; then
      HAS_ASPECTS=true
      break
    fi
  done

  if [ "$HAS_ASPECTS" = true ] && [ "$SOURCE_COUNT" -gt 0 ]; then
    ASPECT_UPDATED=false
    for file in $MODIFIED; do
      case "$file" in
        *.purpose)
          if grep -qE '^\s*~|anchors:|applies-to:' "$file" 2>/dev/null; then
            ASPECT_UPDATED=true
            break
          fi
          ;;
      esac
    done

    # v6.0.4: emit only when a compliance archetype is rostered (Rune owns aspect
    # advisories). Detection above runs unconditionally for data-continuity
    # symmetry with Check 10; only the user-facing emission is gated.
    if [ "$ASPECT_UPDATED" = false ] && [ "$HAS_COMPLIANCE_CLAIMANT" = "true" ]; then
      ADVISORY="  This project defines ~aspects with code anchors. Check if existing
  ~aspects need updated anchors or applies-to patterns."
    fi
  fi
fi

# --- Check 7: Lore entry expected for significant sessions ---
_SEV=$(_check_severity "lore-required" "block")
if [ "$_SEV" != "off" ] && [ "$SOURCE_COUNT" -ge 3 ] && [ -d ".paradigm/lore" ]; then
  LORE_RECORDED=false

  # Check git diff first (covers staged/committed lore)
  for file in $MODIFIED; do
    case "$file" in
      .paradigm/lore/entries/*.yaml|.paradigm/lore/entries/*/*.yaml|.paradigm/lore/entries/*.lore|.paradigm/lore/entries/*/*.lore)
        LORE_RECORDED=true
        break
        ;;
    esac
  done

  # Also check for recent lore on disk (covers MCP-written entries not yet staged)
  if [ "$LORE_RECORDED" = false ]; then
    TODAY=$(date -u +"%Y-%m-%d")
    if [ -d ".paradigm/lore/entries/$TODAY" ]; then
      ENTRY_COUNT=$(find ".paradigm/lore/entries/$TODAY" \( -name "*.yaml" -o -name "*.lore" \) 2>/dev/null | head -1)
      if [ -n "$ENTRY_COUNT" ]; then
        LORE_RECORDED=true
      fi
    fi
  fi

  if [ "$LORE_RECORDED" = false ]; then
    if [ "$PARADIGM_AUTO_FIX" = "1" ]; then
      # Auto-fix: create a stub lore entry with modified file info
      TODAY=$(date -u +"%Y-%m-%d" 2>/dev/null || date +"%Y-%m-%d")
      LORE_TIMESTAMP=$(date -u +"%H%M%S" 2>/dev/null || date +"%H%M%S")
      LORE_DIR=".paradigm/lore/entries/$TODAY"
      mkdir -p "$LORE_DIR" 2>/dev/null
      LORE_ID="L-${TODAY}-auto-${LORE_TIMESTAMP}"
      LORE_FILE="$LORE_DIR/${LORE_ID}.yaml"

      # Extract symbols from modified file paths (directory basenames as component names)
      LORE_SYMBOLS=""
      for file in $MODIFIED; do
        case "$file" in
          .paradigm/*|*.md|*.lock|*.log|.gitignore|.env*|*.json|*.purpose|portal.yaml) continue ;;
        esac
        sym_dir=$(basename "$(dirname "$file")")
        case "$LORE_SYMBOLS" in
          *"#$sym_dir"*) ;;
          *) LORE_SYMBOLS="$LORE_SYMBOLS \"#$sym_dir\"" ;;
        esac
      done

      cat > "$LORE_FILE" <<LOREEOF
id: "$LORE_ID"
type: agent-session
title: "Auto-recorded session — $SOURCE_COUNT files modified"
summary: "Session modified $SOURCE_COUNT source files. Auto-recorded by stop hook."
symbols_touched: [$(echo $LORE_SYMBOLS | sed 's/^ //')]
timestamp: "$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")"
LOREEOF
      AUTO_FIXED="$AUTO_FIXED
  - Created stub lore entry $LORE_ID (update with real summary)"
      AUTO_FIX_COUNT=$((AUTO_FIX_COUNT + 1))
    elif [ "$_SEV" = "block" ]; then
      VIOLATIONS="$VIOLATIONS
  - You modified $SOURCE_COUNT source files but recorded no lore entry.
    Record your session: paradigm_lore_record (MCP) or paradigm lore record (CLI).
    Include: type, title, summary, and symbols_touched."
      VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
    else
      ADVISORY="$ADVISORY
  - (warn) $SOURCE_COUNT source files modified without a lore entry."
    fi
  fi
fi

# --- Checks 8, 10, 11: Unified compliance check (single Node.js process) ---
# Replaces 3 separate subprocess calls (habits check, drift check, portal check)
# with a single `paradigm compliance-check` invocation.
#
# v5.37.12 fail-closed fix (security audit 2026-04-22, Scenario D):
# the prior `|| true` swallowed non-zero exits, which masked every upstream
# failure mode (missing binary, corrupt index, uncaught exception on malformed
# portal.yaml). On non-zero exit we now record the exit code and block with
# an explicit "compliance check failed to run" violation — never silently
# fall through to the habits-only branch.
COMPLIANCE_RESULT=""
COMPLIANCE_EXIT=0
if command -v paradigm >/dev/null 2>&1; then
  COMPLIANCE_RESULT=$(paradigm compliance-check --json --auto-heal --learn --trigger on-stop 2>/dev/null)
  COMPLIANCE_EXIT=$?
elif command -v npx >/dev/null 2>&1; then
  COMPLIANCE_RESULT=$(npx paradigm compliance-check --json --auto-heal --learn --trigger on-stop 2>/dev/null)
  COMPLIANCE_EXIT=$?
else
  # No binary available at all — mark as unavailable, not as silent success.
  COMPLIANCE_EXIT=127
fi

# Fail-closed: non-zero exit MUST block the stop hook. The prior behavior
# silently dropped this signal via `|| true`.
_SEV_COMPLIANCE_RUN=$(_check_severity "portal-compliance" "block")
if [ "$COMPLIANCE_EXIT" -ne 0 ] && [ "$_SEV_COMPLIANCE_RUN" != "off" ]; then
  if [ "$_SEV_COMPLIANCE_RUN" = "block" ]; then
    VIOLATIONS="$VIOLATIONS
  - paradigm compliance-check failed to run (exit $COMPLIANCE_EXIT).
    Refusing to complete session. Run 'paradigm compliance-check' manually
    to see the error. If portal.yaml is malformed, run 'paradigm doctor'."
    VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
  else
    ADVISORY="$ADVISORY
  - (warn) paradigm compliance-check failed to run (exit $COMPLIANCE_EXIT)."
  fi
fi

if [ -n "$COMPLIANCE_RESULT" ]; then
  # --- Check 8: Blocking habits (from unified result) ---
  _SEV=$(_check_severity "habits-blocking" "block")
  if [ "$_SEV" != "off" ] && [ -f ".paradigm/.habits-blocking" ]; then
    HABITS_BLOCKING=$(cat ".paradigm/.habits-blocking")
    if [ "$_SEV" = "block" ]; then
      VIOLATIONS="$VIOLATIONS
  - Blocking habit(s) not satisfied:
    $HABITS_BLOCKING
    Fix: satisfy the habit(s), or change severity to 'warn' in .paradigm/habits.yaml to make advisory."
      VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
    else
      ADVISORY="$ADVISORY
  - (warn) Blocking habit(s) not satisfied: $HABITS_BLOCKING"
    fi
  fi

  # --- Check 10: Aspect drift (from unified result) ---
  _SEV=$(_check_severity "drift-detection" "block")
  DRIFTED_COUNT=$(echo "$COMPLIANCE_RESULT" | grep -o '"driftedCount":[0-9]*' | sed 's/.*://')
  HEALED_COUNT=$(echo "$COMPLIANCE_RESULT" | grep -o '"healedCount":[0-9]*' | sed 's/.*://')

  if [ -n "$HEALED_COUNT" ] && [ "$HEALED_COUNT" -gt 0 ] 2>/dev/null; then
    echo "[paradigm] Auto-healed $HEALED_COUNT shifted anchor(s)." >&2
  fi

  # v6.0.4: drift emission gated on compliance archetype being rostered (Rune
  # owns aspect-drift policy). DRIFTED_COUNT compute above stays unconditional
  # so it still flows to compliance-history.jsonl for Loid's data continuity.
  # NOTE: gate placement matters — invocation (lines ~538-547) and the
  # v5.37.12 fail-closed audit fix (lines ~549-563) MUST stay outside this
  # guard. Only the user-facing emission is gated.
  if [ "$HAS_COMPLIANCE_CLAIMANT" = "true" ] && [ "$_SEV" != "off" ] && [ -n "$DRIFTED_COUNT" ] && [ "$DRIFTED_COUNT" -gt 0 ] 2>/dev/null; then
    if [ "$_SEV" = "block" ]; then
      VIOLATIONS="$VIOLATIONS
  - $DRIFTED_COUNT aspect anchor(s) have drifted (content genuinely changed).
    Run paradigm_aspect_check to review. Update anchors in .purpose files."
      VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
    else
      ADVISORY="$ADVISORY
  - (warn) $DRIFTED_COUNT aspect anchor(s) have drifted."
    fi
  fi

  # --- Check 11: Portal gate compliance (from unified result) ---
  _SEV=$(_check_severity "portal-compliance" "block")
  UNDECLARED=$(echo "$COMPLIANCE_RESULT" | grep -o '"usedButUndeclaredCount":[0-9]*' | sed 's/.*://')

  # v5.37.12: detect unparseable-portal sentinel (classifier, not a gate name).
  # checkPortalCompliance emits `__portal_unparseable__` in usedButUndeclared
  # to force a block when portal.yaml fails to parse. We never render the
  # sentinel or the raw YAMLException to the user — only a redacted class.
  PORTAL_ERR_CLASS=$(echo "$COMPLIANCE_RESULT" | grep -o '"errorClass":"[^"]*"' | head -1 | sed 's/.*"errorClass":"\([^"]*\)".*/\1/')

  if [ "$_SEV" != "off" ] && [ -n "$UNDECLARED" ] && [ "$UNDECLARED" -gt 0 ] 2>/dev/null; then
    UNDECLARED_LIST=$(echo "$COMPLIANCE_RESULT" | grep -o '"usedButUndeclared":\[[^]]*\]' | sed 's/.*\[//;s/\].*//;s/"//g')
    # Strip the unparseable-portal sentinel from the user-visible list.
    CLEAN_LIST=$(echo "$UNDECLARED_LIST" | sed 's/__portal_unparseable__,//g; s/,__portal_unparseable__//g; s/__portal_unparseable__//g')

    if echo "$UNDECLARED_LIST" | grep -q '__portal_unparseable__'; then
      # Portal unparseable path — redacted message, classifier only.
      if [ "$_SEV" = "block" ]; then
        VIOLATIONS="$VIOLATIONS
  - portal.yaml unparseable${PORTAL_ERR_CLASS:+ ($PORTAL_ERR_CLASS)}.
    Run 'paradigm doctor' locally for line-specific details.
    Fix the YAML error or run 'paradigm portal check'."
        VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
      else
        ADVISORY="$ADVISORY
  - (warn) portal.yaml unparseable${PORTAL_ERR_CLASS:+ ($PORTAL_ERR_CLASS)} — run 'paradigm doctor'."
      fi
    elif [ -n "$CLEAN_LIST" ]; then
      # Real undeclared gates — existing behavior.
      if [ "$_SEV" = "block" ]; then
        VIOLATIONS="$VIOLATIONS
  - $UNDECLARED gate(s) used in code but not declared in portal.yaml:
    $CLEAN_LIST
    Add them to portal.yaml or use paradigm_portal_add_gate."
        VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
      else
        ADVISORY="$ADVISORY
  - (warn) $UNDECLARED gate(s) used in code but not declared in portal.yaml: $CLEAN_LIST"
      fi
    fi
  fi
else
  # Fallback: check habits blocking marker even if compliance-check unavailable
  _SEV=$(_check_severity "habits-blocking" "block")
  if [ "$_SEV" != "off" ] && [ -f ".paradigm/.habits-blocking" ]; then
    HABITS_BLOCKING=$(cat ".paradigm/.habits-blocking")
    if [ "$_SEV" = "block" ]; then
      VIOLATIONS="$VIOLATIONS
  - Blocking habit(s) not satisfied:
    $HABITS_BLOCKING
    Fix: satisfy the habit(s), or change severity to 'warn' in .paradigm/habits.yaml to make advisory."
      VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
    else
      ADVISORY="$ADVISORY
  - (warn) Blocking habit(s) not satisfied: $HABITS_BLOCKING"
    fi
  fi
fi

# --- Check 9: Purpose-required patterns from config.yaml ---
_SEV=$(_check_severity "purpose-required-patterns" "block")
CONFIG_FILE=".paradigm/config.yaml"
if [ "$_SEV" != "off" ] && [ -f "$CONFIG_FILE" ]; then
  MISSING_REQUIRED=""
  in_section=false
  current_pattern=""

  while IFS= read -r line; do
    # Detect start of purpose-required section
    case "$line" in
      "purpose-required:"*|"  purpose-required:"*)
        in_section=true
        continue
        ;;
    esac

    if [ "$in_section" = true ]; then
      # Check if we've left the section (new top-level or same-level key)
      case "$line" in
        "  - pattern:"*)
          current_pattern=$(echo "$line" | sed 's/.*pattern:[[:space:]]*//' | tr -d '"' | tr -d "'")
          ;;
        "    depth:"*)
          # We have pattern + depth — validate
          if [ -n "$current_pattern" ]; then
            for dir in $current_pattern; do
              [ -d "$dir" ] || continue
              if [ ! -f "$dir/.purpose" ]; then
                # Deduplicate
                case "$MISSING_REQUIRED" in
                  *"$dir"*) ;;
                  *) MISSING_REQUIRED="$MISSING_REQUIRED $dir" ;;
                esac
              fi
            done
            current_pattern=""
          fi
          ;;
        [a-z]*|[A-Z]*)
          # New top-level key — end of section
          # Handle last pattern if depth wasn't specified
          if [ -n "$current_pattern" ]; then
            for dir in $current_pattern; do
              [ -d "$dir" ] || continue
              if [ ! -f "$dir/.purpose" ]; then
                case "$MISSING_REQUIRED" in
                  *"$dir"*) ;;
                  *) MISSING_REQUIRED="$MISSING_REQUIRED $dir" ;;
                esac
              fi
            done
            current_pattern=""
          fi
          in_section=false
          ;;
      esac
    fi
  done < "$CONFIG_FILE"

  # Handle last pattern if file ended while in section
  if [ "$in_section" = true ] && [ -n "$current_pattern" ]; then
    for dir in $current_pattern; do
      [ -d "$dir" ] || continue
      if [ ! -f "$dir/.purpose" ]; then
        case "$MISSING_REQUIRED" in
          *"$dir"*) ;;
          *) MISSING_REQUIRED="$MISSING_REQUIRED $dir" ;;
        esac
      fi
    done
  fi

  if [ -n "$MISSING_REQUIRED" ]; then
    if [ "$PARADIGM_AUTO_FIX" = "1" ]; then
      # Auto-fix: create stub .purpose files for required patterns
      for dir in $MISSING_REQUIRED; do
        dir_basename=$(basename "$dir")
        cat > "$dir/.purpose" <<PURPOSEEOF
# Auto-generated .purpose stub (purpose-required) — update with real descriptions
components:
  $dir_basename:
    description: "TODO: describe this component"
    tags: []
PURPOSEEOF
        AUTO_FIXED="$AUTO_FIXED
  - Created stub .purpose in $dir (purpose-required pattern)"
        AUTO_FIX_COUNT=$((AUTO_FIX_COUNT + 1))
      done
    elif [ "$_SEV" = "block" ]; then
      VIOLATIONS="$VIOLATIONS
  - These directories match purpose-required patterns but have no .purpose file:
   $MISSING_REQUIRED
    Create .purpose files: paradigm_purpose_init + paradigm_purpose_add_component."
      VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
    else
      ADVISORY="$ADVISORY
  - (warn) Directories matching purpose-required patterns without .purpose file:
   $MISSING_REQUIRED"
    fi
  fi
fi

# --- Check 12: Graduation failure tracking ---
# When violations occur for graduated habits, record failures for auto-demotion.
_SEV=$(_check_severity "graduation-tracking" "warn")
if [ "$_SEV" != "off" ] && [ "$VIOLATION_COUNT" -gt 0 ] && [ -f ".paradigm/graduation.yaml" ]; then
  GRAD_FAILURES_DIR=".paradigm/.graduation-failures"
  mkdir -p "$GRAD_FAILURES_DIR" 2>/dev/null

  # Map violations to graduated habit IDs
  # Check 1/2/5 → purpose-coverage, Check 3/11 → gates-for-routes, Check 7 → record-lore-for-significant
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date +%Y-%m-%dT%H:%M:%SZ)

  # Purpose coverage violations → purpose-coverage habit
  if echo "$VIOLATIONS" | grep -q "source file.*without .purpose\|missing .purpose\|purpose.*stale" 2>/dev/null; then
    if grep -q "purpose-coverage" ".paradigm/graduation.yaml" 2>/dev/null && grep -A1 "purpose-coverage" ".paradigm/graduation.yaml" | grep -q "tier: hook" 2>/dev/null; then
      echo "$NOW" >> "$GRAD_FAILURES_DIR/purpose-coverage"
    fi
  fi

  # Portal gate violations → gates-for-routes habit
  if echo "$VIOLATIONS" | grep -q "portal.yaml\|gate.*undeclared\|gate.*not declared" 2>/dev/null; then
    if grep -q "gates-for-routes" ".paradigm/graduation.yaml" 2>/dev/null && grep -A1 "gates-for-routes" ".paradigm/graduation.yaml" | grep -q "tier: hook" 2>/dev/null; then
      echo "$NOW" >> "$GRAD_FAILURES_DIR/gates-for-routes"
    fi
  fi

  # Lore entry violations → record-lore-for-significant habit
  if echo "$VIOLATIONS" | grep -q "lore entry expected\|no lore" 2>/dev/null; then
    if grep -q "record-lore-for-significant" ".paradigm/graduation.yaml" 2>/dev/null && grep -A1 "record-lore-for-significant" ".paradigm/graduation.yaml" | grep -q "tier: hook" 2>/dev/null; then
      echo "$NOW" >> "$GRAD_FAILURES_DIR/record-lore-for-significant"
    fi
  fi

  # Count recent failures and emit advisory if approaching demotion threshold
  for fail_file in "$GRAD_FAILURES_DIR"/*; do
    [ -f "$fail_file" ] || continue
    habit_id=$(basename "$fail_file")
    fail_count=$(wc -l < "$fail_file" | tr -d ' ')
    if [ "$fail_count" -ge 3 ]; then
      ADVISORY="$ADVISORY
  - Graduated habit '$habit_id' has $fail_count failures — auto-demotion triggered.
    Run paradigm_graduate_status to review tier changes."
    elif [ "$fail_count" -ge 2 ]; then
      ADVISORY="$ADVISORY
  - Graduated habit '$habit_id' has $fail_count failures (demotion at 3).
    Fix the underlying issue or it will be demoted to habit tier."
    fi
  done
fi

# --- Check 13: Orchestration required for complex tasks (magnitude-based) ---
_SEV=$(_check_severity "orchestration-required" "warn")
if [ "$_SEV" != "off" ]; then
  # Compute magnitude score from multiple signals
  MAGNITUDE=0
  MAGNITUDE_REASONS=""

  # Signal 1: Source files modified (1 point each)
  MAGNITUDE=$((MAGNITUDE + SOURCE_COUNT))
  [ "$SOURCE_COUNT" -gt 0 ] && MAGNITUDE_REASONS="$SOURCE_COUNT source files"

  # Signal 2: Cross-package changes (2 points — different packages/ dirs)
  CROSS_PKG_COUNT=0
  SEEN_PKGS=""
  for file in $MODIFIED; do
    case "$file" in
      packages/*)
        _pkg=$(echo "$file" | cut -d'/' -f2)
        case "$SEEN_PKGS" in
          *"|$_pkg|"*) ;;
          *)
            SEEN_PKGS="$SEEN_PKGS|$_pkg|"
            CROSS_PKG_COUNT=$((CROSS_PKG_COUNT + 1))
            ;;
        esac
        ;;
    esac
  done
  if [ "$CROSS_PKG_COUNT" -ge 2 ]; then
    MAGNITUDE=$((MAGNITUDE + 2))
    MAGNITUDE_REASONS="$MAGNITUDE_REASONS, $CROSS_PKG_COUNT packages"
  fi

  # Signal 3: Security-adjacent files (2 points each)
  SEC_ADJACENT=0
  for file in $MODIFIED; do
    case "$file" in
      portal.yaml|*/portal.yaml) SEC_ADJACENT=$((SEC_ADJACENT + 1)) ;;
      *auth*|*permission*|*gate*|*security*|*token*|*session*) SEC_ADJACENT=$((SEC_ADJACENT + 1)) ;;
    esac
  done
  if [ "$SEC_ADJACENT" -gt 0 ]; then
    MAGNITUDE=$((MAGNITUDE + SEC_ADJACENT * 2))
    MAGNITUDE_REASONS="$MAGNITUDE_REASONS, $SEC_ADJACENT security-adjacent"
  fi

  # Signal 4: Symbol-bearing files (1 point if .purpose files were changed alongside source)
  SYMBOL_FILES=0
  for file in $MODIFIED; do
    case "$file" in
      *.purpose) SYMBOL_FILES=$((SYMBOL_FILES + 1)) ;;
    esac
  done
  if [ "$SYMBOL_FILES" -ge 2 ]; then
    MAGNITUDE=$((MAGNITUDE + 1))
    MAGNITUDE_REASONS="$MAGNITUDE_REASONS, $SYMBOL_FILES .purpose files"
  fi

  # Compare magnitude against threshold (default 3)
  if [ "$MAGNITUDE" -ge "$ORCH_THRESHOLD" ]; then
    # Gate markers expire by age (Stop fires per assistant turn, so clearing
    # them here would erase declarations mid-session). TTL default 4h.
    _GATE_TTL_MIN=$(( ${PARADIGM_GATE_TTL_HOURS:-4} * 60 ))
    _marker_fresh() {
      [ -f "$1" ] || return 1
      [ -n "$(find "$1" -mmin "-$_GATE_TTL_MIN" 2>/dev/null)" ]
    }
    # A structured solo declaration (paradigm solo <reason>) satisfies the gate —
    # bypass becomes a legible recorded choice instead of silent drift.
    if [ ! -f ".paradigm/.orchestrated" ] && ! _marker_fresh ".paradigm/.solo-declared"; then
      # Record the bypass to the team-funnel telemetry regardless of severity —
      # the invocation-rate metric needs the event even when only warning.
      # Deduped per TTL window: Stop fires per turn, and per-turn duplicates
      # would structurally deflate the invocation rate Loid calibrates from.
      if ! _marker_fresh ".paradigm/.team-bypass-recorded"; then
        mkdir -p ".paradigm/events" 2>/dev/null
        _BYPASS_TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        _BYPASS_REASONS=$(printf '%s' "$MAGNITUDE_REASONS" | tr -cd 'a-zA-Z0-9,. ' | head -c 120)
        echo "{\"timestamp\":\"$_BYPASS_TS\",\"type\":\"bypass\",\"source\":\"stop-hook\",\"magnitude\":$MAGNITUDE,\"reasons\":\"$_BYPASS_REASONS\",\"severity\":\"$_SEV\"}" >> ".paradigm/events/team-funnel.jsonl" 2>/dev/null
        touch ".paradigm/.team-bypass-recorded" 2>/dev/null
      fi

      if [ "$_SEV" = "block" ]; then
        VIOLATIONS="$VIOLATIONS
  - Task magnitude $MAGNITUDE >= $ORCH_THRESHOLD without orchestration ($MAGNITUDE_REASONS).
    Run paradigm_orchestrate_inline mode=\"quick\" for fast pre-check.
    Or declare solo explicitly: paradigm solo <trivial|hotfix|user-directed|exploratory>
    Override: paradigm enforcement override orchestration-required warn"
        VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
      else
        ADVISORY="$ADVISORY
  - (orchestration) Magnitude $MAGNITUDE ($MAGNITUDE_REASONS) without team orchestration.
    Bypass recorded to team-funnel telemetry. Next time: orchestrate, or declare \`paradigm solo <reason>\`."
      fi
    fi
  fi
fi

# --- Check 14: Active remediations (v6.1 soft-block primitive) ---
# Iterates the cached _REMEDIATIONS_JSON array. severity=guard adds to
# VIOLATIONS (block); advise|auto-author goes to ADVISORY. PARADIGM_OVERRIDE
# (comma-separated id list) skips matching remediations and writes an
# override audit row to .paradigm/events/overrides.jsonl.
#
# Iteration uses a temp file + redirect (NOT pipe) so VIOLATION_COUNT
# increments propagate out of the loop (POSIX subshell-safe — spec §12 #4).
if [ "$_REMEDIATIONS_JSON" != "[]" ] && [ -n "$_REMEDIATIONS_JSON" ]; then
  _RMD_TMP="/tmp/.paradigm-rmds-$$"
  # Split JSON array into one record per line: strip outer brackets, split on `},{`.
  echo "$_REMEDIATIONS_JSON" | sed 's/^\[//; s/\]$//; s/},{/}\n{/g' > "$_RMD_TMP"
  _OVERRIDE_LIST=",${PARADIGM_OVERRIDE:-},"
  while IFS= read -r _line; do
    [ -z "$_line" ] && continue
    case "$_line" in
      *'"id":"'*) ;;
      *) continue ;;
    esac
    _RID=$(echo "$_line" | grep -o '"id":"[^"]*"' | head -1 | sed 's/^"id":"//; s/"$//')
    _RSEV=$(echo "$_line" | grep -o '"severity":"[^"]*"' | head -1 | sed 's/^"severity":"//; s/"$//')
    _RCLAIM=$(echo "$_line" | grep -o '"claimant":"[^"]*"' | head -1 | sed 's/^"claimant":"//; s/"$//')
    _RREASON=$(echo "$_line" | grep -o '"reason":"[^"]*"' | head -1 | sed 's/^"reason":"//; s/"$//')
    [ -z "$_RID" ] && continue

    # PARADIGM_OVERRIDE check — comma-separated list, exact id match.
    case "$_OVERRIDE_LIST" in
      *",$_RID,"*)
        # Write override audit event (mirror compliance-snapshot pattern, line 906).
        _ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
        mkdir -p ".paradigm/events" 2>/dev/null || true
        printf '{"timestamp":"%s","remediation_id":"%s","claimant":"%s","mechanism":"env","unblock_predicate_matched":false}\n' \
          "$_ts" "$_RID" "$_RCLAIM" >> ".paradigm/events/overrides.jsonl" 2>/dev/null || true
        continue
        ;;
    esac

    case "$_RSEV" in
      guard)
        VIOLATIONS="$VIOLATIONS
  - [$_RID] ($_RCLAIM) $_RREASON
    Override: paradigm override $_RID  (or PARADIGM_OVERRIDE=$_RID <cmd>)"
        VIOLATION_COUNT=$((VIOLATION_COUNT + 1))
        ;;
      advise|auto-author)
        ADVISORY="$ADVISORY
  - (remediation:$_RSEV) [$_RID] ($_RCLAIM) $_RREASON"
        ;;
    esac
  done < "$_RMD_TMP"
  rm -f "$_RMD_TMP"
fi

# --- Compliance snapshot (non-fatal, fire-and-forget) ---
# Record this stop-hook run to .paradigm/events/compliance-history.jsonl for trend analysis.
# VIOLATION_COUNT and SOURCE_COUNT are now final at this point.
_compliance_snapshot() {
  _ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
  _checks=$((SOURCE_COUNT + PARADIGM_COUNT))
  [ "$_checks" -eq 0 ] && _checks=1  # Avoid divide-by-zero downstream
  _dir=".paradigm/events"
  mkdir -p "$_dir" 2>/dev/null || return
  printf '{"timestamp":"%s","violations":%d,"warnings":0,"checks":%d}\n' \
    "$_ts" "$VIOLATION_COUNT" "$_checks" >> "$_dir/compliance-history.jsonl" 2>/dev/null || true
}
_compliance_snapshot
