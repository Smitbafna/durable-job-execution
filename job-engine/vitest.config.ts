import { defineConfig } from "vitest/config";

/**
 * Job Engine — unit tests.
 *
 * Pure, fast, no database. These exercise the domain rules (state transitions,
 * payload validation, request validation, error mapping) in isolation.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    restoreMocks: true,
    clearMocks: true,
  },
});
