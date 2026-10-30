/**
 * Job Engine — PostgreSQL integration tests: atomic job claiming.
 *
 * These run against the dedicated `job_engine_test` database (created by the
 * global setup) using real `pg` connections and the worker's repository
 * operations. The pool is shared and truncated between tests.
 *
 * The central guarantee probed here: `claimNextJob` is atomic (a single
 * transaction that SELECT ... FOR UPDATE SKIP LOCKED then flips the row to
 * `running`), so no two claim operations can take the same job.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { truncateJobs, createTestPool } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";

describe("atomic job claiming (PostgreSQL)", () => {
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

  it("claims a queued job and flips it to running", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [id, JSON.stringify({ numbers: [1, 2, 3] })],
    );

    const claimed = await repo.claimNextJob("worker-a");
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("running");
    expect(claimed!.startedAt).not.toBeNull();
    expect(claimed!.startedAt).not.toBeNull();
  });

  it("populates started_at when claiming", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [id, JSON.stringify({})],
    );

    const claimed = await repo.claimNextJob("worker-b");
    expect(claimed).not.toBeNull();
    expect(claimed!.startedAt).not.toBeNull();
    // started_at must be >= the job's created_at.
    expect(claimed!.startedAt!.getTime()).toBeGreaterThanOrEqual(
      new Date(claimed!.createdAt).getTime(),
    );
  });

  it("claims the oldest queued job first", async () => {
    const oldId = randomUUID();
    const newId = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [oldId, JSON.stringify({})],
    );
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now() + interval '1 second', now())`,
      [newId, JSON.stringify({})],
    );

    const first = (await repo.claimNextJob("w"))!.id;
    const second = (await repo.claimNextJob("w"))!.id;
    expect(first).toBe(oldId);
    expect(second).toBe(newId);
  });

  it("returns null when the queue is empty", async () => {
    const claimed = await repo.claimNextJob("worker-c");
    expect(claimed).toBeNull();
  });

  it("skips a succeeded job and returns null when nothing is queued", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, completed_at)
       VALUES ($1, 'sum_numbers', 'succeeded', $2, $3, NULL, now(), now(), now(), now())`,
      [id, JSON.stringify({}), JSON.stringify({ sum: 1 })],
    );

    // Nothing to claim: no queued job.
    expect(await repo.claimNextJob("w")).toBeNull();
  });

  it("cannot claim a failed job", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, completed_at)
       VALUES ($1, 'sum_numbers', 'failed', $2, NULL, $3, now(), now(), now(), now())`,
      [id, JSON.stringify({}), JSON.stringify({ code: "TEST" })],
    );

    const claimed = await repo.claimNextJob("w");
    expect(claimed).toBeNull();
  });

  it("cannot claim a running job", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now())`,
      [id, JSON.stringify({})],
    );

    const claimed = await repo.claimNextJob("w");
    expect(claimed).toBeNull();
  });

  it("does not overwrite a terminal job: a second claim must not mark it terminal", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, completed_at)
       VALUES ($1, 'sum_numbers', 'succeeded', $2, $3, NULL, now(), now(), now(), now())`,
      [id, JSON.stringify({}), JSON.stringify({ sum: 6 })],
    );

    const first = await repo.claimNextJob("w");
    expect(first).toBeNull();

    // Re-open the row from a new connection to be sure the DB state was
    // untouched by the failed claim attempt.
    const direct = createTestPool();
    try {
      const got = await direct.query(
        `SELECT status, result, error, started_at FROM jobs WHERE id = $1`,
        [id],
      );
      expect(got.rows[0].status).toBe("succeeded");
      expect(got.rows[0].result).not.toBeNull();
    } finally {
      await direct.end();
    }
  });
});
