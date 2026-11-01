import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { maintenancePoolConfig } from "./helpers.js";
import { runMigrations, readMigrationFiles } from "../src/db/migrate.js";

const MIGRATION_DB_NAME = "job_engine_migration_test";
const MIGRATIONS_DIR = path.resolve(process.cwd(), "migrations");

describe("migration backfill (PostgreSQL)", () => {
  let maintenance: Pool;
  let pool: Pool;
  let tmpDir: string;
  let queuedId: string;
  let runningId: string;

  beforeAll(async () => {
    maintenance = new Pool(maintenancePoolConfig());
    await maintenance.query(`DROP DATABASE IF EXISTS ${MIGRATION_DB_NAME}`);
    await maintenance.query(`CREATE DATABASE ${MIGRATION_DB_NAME}`);

    const cfg = maintenancePoolConfig();
    pool = new Pool({ ...cfg, database: MIGRATION_DB_NAME });

    // Apply only migrations that predate attempt tracking, so the jobs table
    // has no attempt columns yet (simulating a pre-M5.1 schema).
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
    const preFiles = readMigrationFiles(MIGRATIONS_DIR).filter(
      (f) => f.name <= "0005_add_job_leases.sql",
    );
    for (const f of preFiles) {
      fs.writeFileSync(path.join(tmpDir, f.name), f.sql);
    }
    await runMigrations(pool, tmpDir);

    // Rows that genuinely exist before the attempt-tracking migration.
    queuedId = randomUUID();
    runningId = randomUUID();

    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, now(), now())`,
      [queuedId, JSON.stringify({})],
    );
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation)
       VALUES ($1, 'sum_numbers', 'running', $2, now(), now(), now(), 'w-pre', now() + interval '5 minutes', 7)`,
      [runningId, JSON.stringify({})],
    );

    // Now apply the full migration set, including attempt tracking + backfill.
    await runMigrations(pool, MIGRATIONS_DIR);
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await maintenance?.query(`DROP DATABASE IF EXISTS ${MIGRATION_DB_NAME}`).catch(() => undefined);
    await maintenance?.end().catch(() => undefined);
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("backfills a pre-existing running job to attempt count 1", async () => {
    const row = await pool.query(
      `SELECT attempt_count, worker_id, lease_expires_at, lease_generation FROM jobs WHERE id = $1`,
      [runningId],
    );
    expect(Number(row.rows[0].attempt_count)).toBe(1);
    expect(row.rows[0].worker_id).toBe("w-pre");
    expect(row.rows[0].lease_expires_at).not.toBeNull();
    expect(Number(row.rows[0].lease_generation)).toBe(7);
  });

  it("leaves a pre-existing queued job at attempt count 0", async () => {
    const row = await pool.query(`SELECT attempt_count FROM jobs WHERE id = $1`, [queuedId]);
    expect(Number(row.rows[0].attempt_count)).toBe(0);
  });
});