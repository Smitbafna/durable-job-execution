import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createTestPool, truncateJobs } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";

describe("leases and fencing (PostgreSQL)", () => {
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

  it("two workers cannot claim the same queued job", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [id, JSON.stringify({ numbers: [1] })],
    );
    const a = await repo.claimNextJob("w1", 30000);
    const b = await repo.claimNextJob("w2", 30000);
    expect(a?.id).toBe(id);
    expect(b).toBeNull();
  });

  it("expired running job can be reclaimed with new generation", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now(), 'w1', now() - interval '1 second', 1)`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob("w2", 30000);
    expect(claimed?.id).toBe(id);
    expect(claimed?.leaseGeneration).toBe(2);
    // worker id is stored in DB, not exposed on Job domain.
  });

  it("unexpired running job cannot be reclaimed", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now(), 'w1', now() + interval '1 minute', 1)`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob("w2", 30000);
    expect(claimed).toBeNull();
  });

  it("valid owner can renew lease; wrong worker/token cannot", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now(), 'w1', now() + interval '1 minute', 1)`,
      [id, JSON.stringify({})],
    );
    expect(await repo.renewLease(id, "w1", 1, 30000)).toBe(true);
    expect(await repo.renewLease(id, "w2", 1, 30000)).toBe(false);
    expect(await repo.renewLease(id, "w1", 2, 30000)).toBe(false);
  });

  it("stale worker cannot complete after reclaim", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now(), 'w1', now() - interval '1 second', 1)`,
      [id, JSON.stringify({})],
    );
    const reclaimed = await repo.claimNextJob("w2", 30000);
    expect(reclaimed?.leaseGeneration).toBe(2);
    const affected = await repo.markSucceeded(id, { sum: 1 }, "w1", 1);
    expect(affected).toBe(0);
    const row = await pool.query("SELECT result, worker_id, lease_generation FROM jobs WHERE id = $1", [id]);
    // worker_id checked via repository ownership; lease generation confirms reclaim.
    expect(Number(row.rows[0].lease_generation)).toBe(2);
  });
});

describe("mandatory fencing and boundary", () => {
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

  it("current owner can persist completion", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [id, JSON.stringify({ numbers: [1] })],
    );
    const workerId = "owner";
    const claimed = await repo.claimNextJob(workerId, 30000);
    expect(claimed).not.toBeNull();
    const affected = await repo.markSucceeded(id, { sum: 1 }, workerId, claimed!.leaseGeneration);
    expect(affected).toBe(1);
  });

  it("markFailed rejects a stale worker after reclamation", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now(), 'w1', now() - interval '1 second', 1)`,
      [id, JSON.stringify({})],
    );
    const reclaimed = await repo.claimNextJob("w2", 30000);
    expect(reclaimed?.leaseGeneration).toBe(2);
    const affected = await repo.markFailed(id, { code: "X", message: "stale" }, "w1", 1);
    expect(affected).toBe(0);
  });

  it("concurrent workers cannot both reclaim the same expired job", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now(), 'w1', now() - interval '1 second', 1)`,
      [id, JSON.stringify({})],
    );
    const [a, b] = await Promise.all([
      repo.claimNextJob("w2", 30000),
      repo.claimNextJob("w3", 30000),
    ]);
    const claimed = [a, b].filter(Boolean);
    expect(claimed.length).toBe(1);
  });

  it("lease expiring at the database time boundary is eligible for reclamation", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, worker_id, lease_expires_at, lease_generation)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now(), 'w1', now(), 1)`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob("w2", 30000);
    expect(claimed?.id).toBe(id);
  });
});
