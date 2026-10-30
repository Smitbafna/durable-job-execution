/**
 * Job Engine — minimal, dependency-free migration runner.
 *
 * Migrations live as `*.sql` files in the migrations directory (sorted by
 * filename) and are tracked in a `job_engine_migrations` table. Already-applied
 * files are verified by checksum to detect a rolled-back/changed file. Each
 * migration runs in its own transaction so a failure rolls back cleanly.
 */

import type { Pool, PoolClient, QueryResult } from "pg";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const TRACKING_TABLE = "job_engine_migrations";

export interface MigrationRecord {
  name: string;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

/** Reads migration SQL files from `dir`, sorted by name, with sha256 checksums. */
export function readMigrationFiles(dir: string): MigrationFile[] {
  if (dir.trim() === "") {
    throw new Error("Migrations directory path is required");
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    throw new Error(
      `Cannot read migrations directory "${dir}": ${(e as Error).message}`,
    );
  }
  const files = entries.filter((f) => f.endsWith(".sql")).sort();
  const out: MigrationFile[] = [];
  for (const name of files) {
    const full = path.join(dir, name);
    const sql = fs.readFileSync(full, "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    out.push({ name, sql, checksum });
  }
  return out;
}

async function ensureTrackingTable(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function listApplied(client: PoolClient): Promise<Map<string, string>> {
  const res: QueryResult<{ name: string; checksum: string }> = await client.query<{
    name: string;
    checksum: string;
  }>(`SELECT name, checksum FROM ${TRACKING_TABLE};`);
  const m = new Map<string, string>();
  for (const row of res.rows) {
    m.set(row.name, row.checksum);
  }
  return m;
}

/**
 * Applies pending migrations against `pool`. Idempotent: already-applied
 * migrations are skipped, but their on-disk checksum is verified to detect
 * tampering. Throws if a file changed after being applied.
 */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
): Promise<void> {
  const files = readMigrationFiles(migrationsDir);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureTrackingTable(client);
    const applied = await listApplied(client);
    await client.query("COMMIT");

    for (const mig of files) {
      const prev = applied.get(mig.name);
      if (prev !== undefined) {
        if (prev !== mig.checksum) {
          throw new Error(
            `Migration "${mig.name}" was already applied with checksum "${prev}" but the file on disk now has checksum "${mig.checksum}". Refusing to continue.`,
          );
        }
        continue; // already applied — skip.
      }
      await client.query("BEGIN");
      try {
        await client.query(mig.sql);
        await client.query(
          `INSERT INTO ${TRACKING_TABLE} (name, checksum) VALUES ($1, $2)`,
          [mig.name, mig.checksum],
        );
        await client.query("COMMIT");
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch {
          /* ignore rollback errors */
        }
        throw new Error(
          `Migration "${mig.name}" failed: ${(e as Error).message}`,
        );
      }
    }
  } finally {
    client.release();
  }
}

/** Returns the list of applied migrations, newest-first. */
export async function listMigrations(
  pool: Pool,
): Promise<MigrationRecord[]> {
  const res = await pool.query<{
    name: string;
    checksum: string;
    applied_at: Date;
  }>(`SELECT name, checksum, applied_at FROM ${TRACKING_TABLE} ORDER BY applied_at DESC;`);
  return res.rows.map((r) => ({
    name: r.name,
    checksum: r.checksum,
    appliedAt: r.applied_at,
  }));
}
