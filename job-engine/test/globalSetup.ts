/**
 * Job Engine — integration test global setup.
 *
 * Ensures a PostgreSQL instance is reachable, provisions a dedicated
 * `job_engine_test` database (isolated from the dev/Production `job_engine`
 * database used by `docker compose`), and runs migrations. The teardown drops
 * the test database so every run starts clean.
 *
 * If the DB is unreachable this fails fast with a clear message; it never falls
 * back to a fake/in-memory database.
 */

import path from "node:path";
import { Pool } from "pg";
import { runMigrations } from "../src/db/migrate.js";
import {
  TEST_DB_NAME,
  maintenancePoolConfig,
  testPoolConfig,
} from "./helpers.js";

const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdentifier(name: string, label: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(`Invalid ${label}: ${name}`);
  }
}

async function waitForServer(pool: Pool, ms: number): Promise<void> {
  const cfg = pool.options;
  const deadline = Date.now() + ms;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `PostgreSQL at ${cfg.host}:${cfg.port} is not reachable after ${ms}ms: ${msg}. ` +
      "Start it with `docker compose up -d` first.",
  );
}

async function createDatabase(pool: Pool, name: string): Promise<void> {
  try {
    await pool.query(`CREATE DATABASE ${name}`);
  } catch (e: unknown) {
    // 42P04 = duplicate_database → idempotent no-op.
    if ((e as { code?: string })?.code === "42P04") return;
    throw e;
  }
}

async function globalSetup() {
  assertIdentifier(TEST_DB_NAME, "test database name");
  assertIdentifier(maintenancePoolConfig().database ?? "postgres", "maintenance database name");

  const maintenance = new Pool(maintenancePoolConfig());
  try {
    await waitForServer(maintenance, 30_000);
    await createDatabase(maintenance, TEST_DB_NAME);
    console.log(`[integration] database ready: ${TEST_DB_NAME}`);
  } finally {
    await maintenance.end();
  }

  const pool = new Pool(testPoolConfig());
  try {
    await runMigrations(pool, MIGRATIONS_DIR);
    console.log("[integration] migrations applied");
  } finally {
    await pool.end();
  }

  return async () => {
    const m = new Pool(maintenancePoolConfig());
    try {
      await m.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`);
      console.log("[integration] dropped test database");
    } catch (e) {
      console.error("[integration] teardown: could not drop test database:", e);
    } finally {
      await m.end();
    }
  };
};

export default globalSetup;
