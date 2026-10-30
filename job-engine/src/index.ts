/**
 * Job Engine — application bootstrap / entry point.
 *
 * Run with `npm run dev` (tsx watch) or `npm run start` (compiled `node dist/`).
 * Migrations are applied on startup so a fresh database is always ready.
 *
 * The heavy lifting (the Express app, routes, repositories) lives in `app.ts` and
 * the `db/` module; this file is intentionally thin.
 */

import path from "node:path";
import { createApp } from "./app.js";
import { getPool, closePool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";

export { createApp } from "./app.js";
export type { AppContainer, CreateAppOptions } from "./app.js";
export type { Job } from "./domain/job.js";
export { JobStatus } from "./domain/job.js";
export { AppError, AppErrorCode } from "./errors.js";
export { canTransition, assertTransitionAllowed } from "./domain/jobTransitions.js";

const DEFAULT_PORT = 4700;
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");

async function main(): Promise<void> {
  const pool = getPool(); // initializes from env; throws if DB_USER/DB_PASSWORD missing
  await runMigrations(pool, MIGRATIONS_DIR);
  console.log("[job-engine] migrations applied");

  const { app } = createApp({ pool });
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const server = app.listen(port, "0.0.0.0", () => {
    // eslint-disable-next-line no-console
    console.log(`[job-engine] listening on :${port}`);
  });

  const shutdown = async (): Promise<void> => {
    // eslint-disable-next-line no-console
    console.log("[job-engine] shutting down...");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Start only when executed directly (not when imported by tests).
const isMainModule =
  process.argv[1] !== undefined &&
  new URL(import.meta.url).pathname === process.argv[1];
if (isMainModule) {
  main().catch((err) => {
    console.error("[job-engine] fatal:", err);
    process.exit(1);
  });
}

