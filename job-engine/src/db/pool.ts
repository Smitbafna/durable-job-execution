/**
 * Job Engine — PostgreSQL connection pool.
 *
 * A single `pg.Pool` singleton is created from environment configuration. Tests
 * construct their own pools (see `test/helpers.ts`) and inject them via
 * `createApp({ pool })` so they never touch production credentials.
 */

import pg from "pg";
import { loadDatabaseConfig } from "../config.js";
import type { DatabaseConfig } from "../config.js";
import type { Pool, PoolClient, QueryResult } from "pg";

export type { Pool, PoolClient, QueryResult } from "pg";

const { Pool: PgPool } = pg;

let pool: Pool | null = null;

/** Creates a new `pg.Pool` from the supplied or env-derived configuration. */
export function createPool(config?: DatabaseConfig): Pool {
  const cfg = config ?? loadDatabaseConfig();
  return new PgPool({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    connectionTimeoutMillis: cfg.connectionTimeoutMillis,
  });
}

/** Returns the singleton pool, initializing it lazily from the environment. */
export function getPool(): Pool {
  if (pool === null) {
    pool = createPool();
  }
  return pool;
}

/** Gracefully closes the singleton pool (used on shutdown). */
export async function closePool(): Promise<void> {
  if (pool !== null) {
    const toClose = pool;
    pool = null;
    await toClose.end();
  }
}
