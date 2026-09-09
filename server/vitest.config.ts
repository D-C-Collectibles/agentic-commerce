import { defineConfig } from "vitest/config";

// ponytail: this repo has no DB-mocking layer — every test file hits the same real dev
// Postgres and shares schema-ensuring DDL / advisory locks. Running test files in
// parallel processes intermittently deadlocks Postgres across files; serializing files
// (workers still run tests within a file concurrently) avoids that cross-file contention.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
