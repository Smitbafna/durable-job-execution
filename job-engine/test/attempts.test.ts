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
    expect(r).toEqual({ status: "retry_scheduled" });
    const row = await pool.query(`SELECT status, worker_id, lease_expires_at FROM jobs WHERE id=$1`, [id]);
    expect(row.rows[0].status).toBe("queued");
    expect(row.rows[0].worker_id).toBeNull();
    expect(row.rows[0].lease_expires_at).toBeNull();
  });

  it("retry at max exhausted", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts) VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() + interval '1 minute', 3, 3, 3)`, [id, JSON.stringify({})]);
    const r = await repo.scheduleRetry(id, "w1", 3, { code: "ERR", message: "boom" }, new Date(Date.now() + 60000));
    expect(r).toEqual({ status: "exhausted" });
  });

  it("scheduleRetry does not change attempt_count", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() + interval '1 minute', 1, 1, 3)`,
      [id, JSON.stringify({})],
    );
    const r = await repo.scheduleRetry(id, "w1", 1, { code: "ERR", message: "boom" }, new Date(Date.now() + 60000));
    expect(r).toEqual({ status: "retry_scheduled" });
    const row = await pool.query(`SELECT attempt_count FROM jobs WHERE id=$1`, [id]);
    expect(Number(row.rows[0].attempt_count)).toBe(1);
  });

  it("next claim after retry scheduling increments attempt_count exactly once", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() + interval '1 minute', 1, 1, 3)`,
      [id, JSON.stringify({})],
    );
    await repo.scheduleRetry(id, "w1", 1, { code: "ERR", message: "boom" }, new Date(Date.now() - 60000));
    const claimed = await repo.claimNextJob("w2", 30000);
    expect(claimed?.id).toBe(id);
    expect(claimed?.attemptCount).toBe(2);
  });

  it("concurrent initial claims do not double-increment one job", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO jobs (id, type, status, payload) VALUES ($1,'sum_numbers','queued',$2)`, [id, JSON.stringify({})]);
    const [a, b] = await Promise.all([
      repo.claimNextJob("w2", 30000),
      repo.claimNextJob("w3", 30000),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    const row = await pool.query(`SELECT attempt_count FROM jobs WHERE id=$1`, [id]);
    expect(Number(row.rows[0].attempt_count)).toBe(1);
  });

  it("concurrent expired-lease reclamation does not double-increment one job", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() - interval '1 second', 1, 1, 3)`,
      [id, JSON.stringify({})],
    );
    const [a, b] = await Promise.all([
      repo.claimNextJob("w2", 30000),
      repo.claimNextJob("w3", 30000),
    ]);
    expect([a, b].filter(Boolean).length).toBe(1);
    const row = await pool.query(`SELECT attempt_count FROM jobs WHERE id=$1`, [id]);
    expect(Number(row.rows[0].attempt_count)).toBe(2);
  });

  it("expired-lease reclaim clears next_attempt_at", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts, next_attempt_at)
       VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() - interval '1 second', 1, 1, 3, now() + interval '1 hour')`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob("w2", 30000);
    expect(claimed).not.toBeNull();
    const row = await pool.query(`SELECT next_attempt_at FROM jobs WHERE id=$1`, [id]);
    expect(row.rows[0].next_attempt_at).toBeNull();
  });

  it("stale retry rejected", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() + interval '1 minute', 1, 1, 3)`,
      [id, JSON.stringify({})],
    );
    const r = await repo.scheduleRetry(id, "w2", 1, { code: "ERR", message: "boom" }, new Date(Date.now() + 60000));
    expect(r).toEqual({ status: "ownership_lost" });
  });
  it("heartbeat does not change attempt_count", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, started_at, worker_id, lease_expires_at, lease_generation, attempt_count, max_attempts)
       VALUES ($1,'sum_numbers','running',$2, now(), 'w1', now() + interval '1 minute', 1, 1, 3)`,
      [id, JSON.stringify({})],
    );
    const renewal = await repo.renewLease(id, "w1", 1, 30000);
    expect(renewal.renewed).toBe(true);
    expect(renewal.cancellationRequested).toBe(false);
    expect(renewal.cancelled).toBe(false);
    const row = await pool.query(`SELECT attempt_count FROM jobs WHERE id=$1`, [id]);
    expect(Number(row.rows[0].attempt_count)).toBe(1);
  });

});
