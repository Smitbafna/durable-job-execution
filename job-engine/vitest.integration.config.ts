import { defineConfig } from "vitest/config";

/**
 * Job Engine — PostgreSQL integration tests.
 *
 * These exercise the FULL stack (HTTP → service → repository → real PostgreSQL)
 * using an actual PostgreSQL instance (provided by `docker compose`). They are
 * intentionally NOT a substitute for real persistence: see test/integration.test.ts.
 *
 * Run with: npm run test:integration   (brings up Postgres via docker compose first)
 */
export default defineConfig({
  test: {
    environment: "node",
    globalSetup: ["./test/globalSetup.ts"],
    include: ["test/**/*.test.ts"],
    // Truncating the shared test DB between tests requires strict seriality.
    pool: "forks",
    maxWorkers: 1,
    minWorkers: 1,
    fileParallelism: false,
    singleThread: true,
    testTimeout: 15_000,
    hookTimeout: 30_000,
    restoreMocks: true,
    clearMocks: true,
  },
});
