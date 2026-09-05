# Matt handoff — prompt-logging + merge-tracking work

**Date:** 2026-09-04 · **Repo:** `D-C-Collectibles/agentic-commerce` · **Branch:** `main` (clean, all work merged)

One-off note to continue on my other computer. Delete this file whenever — it's not part of the app.

---

## TL;DR — where things stand

All this session's work is **merged to `main` and pushed**. Nothing is half-done.

- **PR #3** (merged) — per-contributor prompt logs: each person writes `prompts/<name>.jsonl` instead of the shared `prompts.jsonl` (which is now a frozen archive). Entries have a `type` field: `prompt` | `merge`.
- **PR #4** (merged) — git hooks that **auto-note merges** to your personal log.
- Darren was pinged on PR #4 to run `pnpm install` (he needs it to activate the hooks).

`main` HEAD is `7dfd739` (the last thing is an auto-noted merge — the hooks working).

---

## Setup on the new machine (do these in order)

1. **Clone + pull**
   ```
   git clone https://github.com/D-C-Collectibles/agentic-commerce.git
   cd agentic-commerce && git pull
   ```

2. **Git identity — must match so logs route to `prompts/matt.jsonl`.** The slug is keyed by *email* (`AUTHOR_SLUGS` in `scripts/log-prompt.mjs`):
   ```
   git config user.name  "ascend"
   git config user.email "ascendinfinitely@gmail.com"
   ```
   (A different email → your prompts land in a different file. This is the one that maps to `matt`.)

3. **GitHub CLI auth** — need the `ascend42` account (it has WRITE on the repo now; it briefly didn't earlier):
   ```
   gh auth login
   ```

4. **`pnpm install`** — this is what activates the merge-auto-note hooks (the `prepare` script sets `core.hooksPath .githooks`). Without it, merges won't auto-note.
   ```
   pnpm install
   ```

5. **Patch the Paradigm plugin `.jsonl` Stop-hook bug** (per machine — it lives in the global plugin cache, not the repo). The plugin's Stop hook false-positives on `.jsonl` changes and blocks the turn. Find the version dir and patch both exclusion lines:
   ```
   PC=$(ls -d ~/.claude/plugins/cache/a-paradigm/paradigm/*/scripts/paradigm-common.sh | tail -1)
   sed -i '' 's/\*\.log|\.gitignore/*.log|*.jsonl|.gitignore/' "$PC"
   ```
   (macOS `sed`. A plugin update re-clobbers it — real fix belongs upstream in `a-paradigm`.)

6. **Backend (only if working on the API)** — `server/` is its own Express + TS app:
   ```
   cd server && pnpm install && cp .env.example .env   # set DATABASE_URL (Neon: agentic-commerce)
   pnpm dev
   ```

---

## Conventions cheat-sheet (decided with Darren)

- **Prompt logs:** each person → own `prompts/<name>.jsonl`. Never the shared `prompts.jsonl` (frozen archive). Auto-logged in Claude Code via `UserPromptSubmit` hook.
- **Merges:** auto-noted by `.githooks/` (`post-merge` = clean merges, `post-commit` = conflict-resolved). Edit an auto-note with what you *kept* if a resolution was non-trivial:
  `pnpm log-prompt -- --type merge "kept theirs on X because …"`
- **Workflow:** feature/code work → side-branch → PR → merge. **Review intentionally skipped** during initial stand-up for speed; tighten it up as integrations land. `main` is **not** branch-protected, so routine prompt-log appends commit **directly to main** (a PR per log-append would be silly).
- Repo is **pnpm-only** (never `npm`). Paradigm conventions in `CLAUDE.md`.

---

## Key files

| Path | What |
|------|------|
| `scripts/log-prompt.mjs` | Logger — routing, slugs (`AUTHOR_SLUGS`), `type` field |
| `.githooks/post-merge`, `.githooks/post-commit` | Merge auto-note hooks |
| `prompts/<name>.jsonl` | Personal logs (mine = `prompts/matt.jsonl`) |
| `prompts.jsonl` | Frozen archive — don't write to it |
| `CLAUDE.md` › "Hackathon prompt logging" | The full rule |

---

## Open threads / next up

- **Paradigm plugin `.jsonl` bug** — patched locally on *this* machine only; needs the step-5 patch on the other machine, and ideally a fix upstream in `a-paradigm`.
- **Darren** — confirm he ran `pnpm install` so his merges auto-note.
- Actual product work (wallet checkout / integrations) is where the "closer review" kicks back in — that's the next phase.
