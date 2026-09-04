#!/usr/bin/env node
// Appends a hackathon prompt to prompts.jsonl with author + timestamp.
// Usage: npm run log-prompt -- "the prompt text"
//        echo "the prompt text" | npm run log-prompt
import { execSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logPath = path.join(root, "prompts.jsonl");

function gitConfig(key) {
  try {
    return execSync(`git config ${key}`).toString().trim();
  } catch {
    return "";
  }
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

const argText = process.argv.slice(2).join(" ").trim();
const stdinText = argText ? "" : readFileSync(0, "utf8").trim();
const prompt = argText || stdinText;

if (!prompt) {
  console.error('Usage: npm run log-prompt -- "the prompt text" (or pipe via stdin)');
  process.exit(1);
}

const entry = {
  timestamp: new Date().toISOString(),
  author: `${name} <${email}>`,
  prompt,
};

appendFileSync(logPath, JSON.stringify(entry) + "\n");
console.log(`Logged prompt from ${entry.author}`);
