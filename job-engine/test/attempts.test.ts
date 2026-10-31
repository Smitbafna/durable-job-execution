import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { truncateJobs, createTestPool } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";

describe("attempt tracking (PostgreSQL)", () => {
  let pool: Pool;
  let repo: JobRepository;
  beforeEach(async () => { pool = createTestPool(); repo = new JobRepository(pool); await truncateJobs(pool); });
  afterEach(async () => { await pool.end().catch(() => undefined); });

  it("defaults", async () => {
    const job = await repo.createJob({ id: randomUUID(), type: "sum_numbers" as any, payload: {} });
    expect(job.attemptCount).toBe(0);
    expect(job.maxAttempts).toBe(3);
    expect(job.nextAttemptAt).toBeNull();
  });

  it("claim increments", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload) VALUES ($1,'sum_numbers','queued',$2)`, [id, JSON.stringify({})]);
    const claimed = await repo.claimNextJob("w1", 30000);
    expect(claimed!.attemptCount).toBe(1);
  });

  it("future next_attempt_at blocks claim", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload, next_attempt_at) VALUES ($1,'sum_numbers','queued',$2, now() + interval '1 hour')`, [id, JSON.stringify({})]);
    expect(await repo.claimNextJob("w1", 30000)).toBeNull();
  });

  it("expired reclaim increments", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts) VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() - interval '1 second', 1, 1, 3)`, [id, JSON.stringify({})]);
    const claimed = await repo.claimNextJob("w2", 30000);
    expect(claimed!.attemptCount).toBe(2);
  });

  it("expired at max fails", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts) VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() - interval '1 second', 3, 3, 3)`, [id, JSON.stringify({})]);
    expect(await repo.claimNextJob("w2", 30000)).toBeNull();
    const row = await pool.query(`SELECT status FROM jobs WHERE id=$1`, [id]);
    expect(row.rows[0].status).toBe("failed");
  });

  it("retry schedules queued", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts) VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() + interval '1 minute', 1, 1, 3)`, [id, JSON.stringify({})]);
    const r = await repo.scheduleRetry(id, "w1", 1, { code: "ERR", message: "boom" }, new Date(Date.now() + 60000));
    expect(r).toBe("retry_scheduled");
    const row = await pool.query(`SELECT status, worker_id, lease_expires_at FROM jobs WHERE id=$1`, [id]);
    expect(row.rows[0].status).toBe("queued");
    expect(row.rows[0].worker_id).toBeNull();
    expect(row.rows[0].lease_expires_at).toBeNull();
  });

  it("retry at max exhausted", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts) VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() + interval '1 minute', 3, 3, 3)`, [id, JSON.stringify({})]);
    const r = await repo.scheduleRetry(id, "w1", 3, { code: "ERR", message: "boom" }, new Date(Date.now() + 60000));
    expect(r).toBe("exhausted");
  });

  it("stale retry rejected", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts) VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() + interval '1 minute', 1, 1, 3)`, [id, JSON.stringify({})]);
    const r = await repo.scheduleRetry(id, "w2", 1, { code: "ERR", message: "boom" }, new Date(Date.now() + 60000));
    expect(r).toBe("rejected");
  });
});
