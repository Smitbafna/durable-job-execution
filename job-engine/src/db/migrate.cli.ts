/**
 * Job Engine — migration CLI.
 *
 * Run with `npm run migrate`. Reads credentials from the environment (DB_USER,
 * DB_PASSWORD, …) and applies all pending migrations in `MIGRATIONS_DIR`
 * (defaults to ./migrations relative to the current working directory).
 */

import path from "node:path";
import { createPool } from "./pool.js";
import { runMigrations, listMigrations } from "./migrate.js";

const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");

async function main(): Promise<void> {
  const pool = createPool();
  try {
    const cfg = pool.options;
    // eslint-disable-next-line no-console
    console.log(
      `[migrate] target: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`,
    );
    console.log(`[migrate] migrations dir: ${MIGRATIONS_DIR}`);
    await runMigrations(pool, MIGRATIONS_DIR);
    const applied = await listMigrations(pool);
    // eslint-disable-next-line no-console
    console.log(
      `[migrate] done. Applied migrations: ${
        applied.map((m) => m.name).join(", ") || "(none)"
      }`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[migrate] ERROR:", err);
  process.exit(1);
});
