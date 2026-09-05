# Prompt logs

Per-contributor AI prompt logs for the hackathon. **Each person writes only their own file**
(`<name>.jsonl`), so parallel logging never produces a merge conflict.

- `matt.jsonl`, `darren.jsonl`, … — one JSON Lines file per contributor. The `<name>` slug is
  derived automatically from git identity (see `AUTHOR_SLUGS` in `scripts/log-prompt.mjs`);
  unlisted contributors fall back to a slugified `git config user.name`.
- The repo-root `../prompts.jsonl` is a **frozen historical archive** from before the split —
  nothing writes to it anymore.

Each line is one entry, tagged with `type`:

```json
{"timestamp":"…","author":"Name <email>","type":"prompt","prompt":"…"}
{"timestamp":"…","author":"Name <email>","type":"merge","note":"resolved conflict in X, took theirs"}
```

Prompts are logged automatically in Claude Code (`UserPromptSubmit` hook). Log manually — or log a
merge/conflict note — with:

```
pnpm log-prompt -- "the prompt text"
pnpm log-prompt -- --type merge "resolved conflict in X, took theirs"
```

See `CLAUDE.md` › "Hackathon prompt logging" for the full rule.
