import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Each test file boots its own in-memory Postgres (PGlite + pgvector).
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Tests never call the API, even if a key is set in the shell.
    env: { MOCK_LLM: "1", ANTHROPIC_API_KEY: "", DATABASE_URL: "", VOYAGE_API_KEY: "" },
  },
});
