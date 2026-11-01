import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { truncateJobs, createTestPool } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";

describe("result/error state cleanup (PostgreSQL)", () => {
  let pool: Pool;
  let repo: JobRepository;

  beforeEach(async () => {
    pool = createTestPool();
    repo = new JobRepository(pool);
    await truncateJobs(pool);
  });

  afterEach(async () => {
    await pool.end().catch(() => undefined);
  });

  it("successful completion clears an earlier error", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, $3, now(), now(), now(), 'w1', now() + interval '1 minute', 1, 1, 3)`,
      [id, JSON.stringify({ numbers: [1] }), JSON.stringify({ code: "OLD_ERROR", message: "old" })],
    );
    const affected = await repo.markSucceeded(id, { sum: 1 }, "w1", 1);
    expect(affected).toBe(1);
    const row = await pool.query(`SELECT result, error FROM jobs WHERE id = $1`, [id]);
    expect(row.rows[0].result).not.toBeNull();
    expect(row.rows[0].error).toBeNull();
  });

  it("terminal failure clears an earlier result", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1, 'sum_numbers', 'running', $2, $3, NULL, now(), now(), now(), 'w1', now() + interval '1 minute', 1, 1, 3)`,
      [id, JSON.stringify({ numbers: [1] }), JSON.stringify({ sum: 42 })],
    );
    const affected = await repo.markFailed(id, { code: "BOOM", message: "failed" }, "w1", 1);
    expect(affected).toBe(1);
    const row = await pool.query(`SELECT result, error FROM jobs WHERE id = $1`, [id]);
    expect(row.rows[0].result).toBeNull();
    expect(row.rows[0].error).not.toBeNull();
  });

  it("stale worker cannot overwrite result or clear error via markSucceeded", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, $3, now(), now(), now(), 'w1', now() - interval '1 second', 1, 1, 3)`,
      [id, JSON.stringify({}), JSON.stringify({ code: "OLD_ERROR", message: "old" })],
    );
    const reclaimed = await repo.claimNextJob("w2", 30000);
    expect(reclaimed?.leaseGeneration).toBe(2);
    const affected = await repo.markSucceeded(id, { sum: 999 }, "w1", 1);
    expect(affected).toBe(0);
    const row = await pool.query(`SELECT result, error, lease_generation FROM jobs WHERE id = $1`, [id]);
    expect(row.rows[0].result).toBeNull();
    expect(row.rows[0].error).toEqual({ code: "OLD_ERROR", message: "old" });
    expect(Number(row.rows[0].lease_generation)).toBe(2);
  });

  it("stale worker cannot overwrite error or clear result via markFailed", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1, 'sum_numbers', 'running', $2, $3, NULL, now(), now(), now(), 'w1', now() - interval '1 second', 1, 1, 3)`,
      [id, JSON.stringify({}), JSON.stringify({ sum: 42 })],
    );
    const reclaimed = await repo.claimNextJob("w2", 30000);
    expect(reclaimed?.leaseGeneration).toBe(2);
    const affected = await repo.markFailed(id, { code: "STALE", message: "stale" }, "w1", 1);
    expect(affected).toBe(0);
    const row = await pool.query(`SELECT result, error, lease_generation FROM jobs WHERE id = $1`, [id]);
    expect(row.rows[0].result).toEqual({ sum: 42 });
    expect(row.rows[0].error).toBeNull();
    expect(Number(row.rows[0].lease_generation)).toBe(2);
  });
});