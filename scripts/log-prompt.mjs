#!/usr/bin/env node
// Appends a hackathon log entry to the author's PERSONAL log at prompts/<slug>.jsonl.
// One file per contributor => two people appending in parallel never merge-conflict.
// The old top-level prompts.jsonl is a frozen historical archive; nothing writes to it.
//
// Usage:
//   pnpm log-prompt -- "the prompt text"                 # type=prompt (default)
//   pnpm log-prompt -- --type merge "resolved X, took theirs"   # type=merge (conflict note)
//   echo "the prompt text" | pnpm log-prompt
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(root, "prompts");

function gitConfig(key) {
  try {
    return execSync(`git config ${key}`).toString().trim();
  } catch {
    return "";
  }
}

// Friendly first-name slugs for known contributors, keyed by lowercased email.
// Add a line here when a new person joins; anyone unlisted falls back to a
// slugified git user.name (see slugify()).
const AUTHOR_SLUGS = {
  "ascendinfinitely@gmail.com": "matt",
  "chaosstriker0319@gmail.com": "darren",
};

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const name = gitConfig("user.name");
const email = gitConfig("user.email");

if (!name || !email) {
  console.error(
    "git user.name/user.email are not set. Run `git config user.name \"Your Name\"` " +
      "and `git config user.email \"you@example.com\"` before logging prompts."
  );
  process.exit(1);
}

const slug = AUTHOR_SLUGS[email.toLowerCase()] || slugify(name) || slugify(email.split("@")[0]);
if (!slug) {
  console.error(`Could not derive a log slug from git user.name "${name}" / email "${email}".`);
  process.exit(1);
}

// Parse an optional leading `--type <value>` / `--type=<value>`; the rest is the text.
const argv = process.argv.slice(2);
let type = "prompt";
if (argv[0] === "--type") {
  type = (argv[1] || "").trim() || "prompt";
  argv.splice(0, 2);
} else if (argv[0] && argv[0].startsWith("--type=")) {
  type = argv[0].slice("--type=".length).trim() || "prompt";
  argv.splice(0, 1);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8").trim();
  } catch {
    return "";
  }
}

const argText = argv.join(" ").trim();
const text = argText || readStdin();

if (!text) {
  console.error(
    'Usage: pnpm log-prompt -- "the prompt text"  (or  --type merge "note", or pipe via stdin)'
  );
  process.exit(1);
}

// type=prompt stores the text under `prompt`; every other type stores it under `note`.
const entry = {
  timestamp: new Date().toISOString(),
  author: `${name} <${email}>`,
  type,
  ...(type === "prompt" ? { prompt: text } : { note: text }),
};

mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `${slug}.jsonl`);
appendFileSync(logPath, JSON.stringify(entry) + "\n");
console.log(`Logged ${type} from ${entry.author} -> prompts/${slug}.jsonl`);
