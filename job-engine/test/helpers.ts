/**
 * Job Engine — shared test helpers.
 *
 * These use test-only credentials (never production data) and connect only to
 * the dedicated `job_engine_test` database that the global setup provisions and
 * tears down.
 */

import { Pool } from "pg";
import type { PoolConfig } from "pg";
import { createApp } from "../src/app.js";
import type { AppContainer } from "../src/app.js";

export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? "job_engine_test";

function serverConfig() {
  return {
    host: process.env.TEST_DB_HOST ?? "127.0.0.1",
    port: Number(process.env.TEST_DB_PORT ?? 15432),
    user: process.env.TEST_DB_USER ?? "jobeng",
    password: process.env.TEST_DB_PASSWORD ?? "jobeng-secret",
  };
}

/** Connects to the maintenance `postgres` database to create/drop the test DB. */
export function maintenancePoolConfig(): PoolConfig {
  return {
    ...serverConfig(),
    database: process.env.TEST_DB_MAINTENANCE ?? "postgres",
    connectionTimeoutMillis: 2000,
    max: 1,
  };
}

/** Connects to the (test) application database. */
export function testPoolConfig(): PoolConfig {
  return {
    ...serverConfig(),
    database: TEST_DB_NAME,
    connectionTimeoutMillis: 3000,
    max: 5,
  };
}

export function createTestPool(): Pool {
  return new Pool(testPoolConfig());
}

export function createMaintenancePool(): Pool {
  return new Pool(maintenancePoolConfig());
}

/** Removes all rows from `jobs` (called between tests via the shared pool). */
export async function truncateJobs(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE TABLE jobs");
}

/** Removes all rows from `artifacts` (called between tests via the shared pool). */
export async function truncateArtifacts(pool: Pool): Promise<void> {
  await pool.query("TRUNCATE TABLE artifacts");
}

/** Builds a fresh app + pool for a test. The shared pool should be ended in `afterAll`. */
export function createTestApp(): AppContainer {
  const pool = createTestPool();
  return createApp({ pool });
}
