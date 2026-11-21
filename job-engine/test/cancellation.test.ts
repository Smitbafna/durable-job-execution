import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { truncateJobs, createTestPool } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";
import { JobService } from "../src/service/jobService.js";
import { JobStatus } from "../src/domain/job.js";

describe("job cancellation (PostgreSQL)", () => {
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

  /** Helper: insert a queued job and claim it as running. */
  async function claimRunningJob(pool: Pool, workerId = "w1"): Promise<{ id: string; leaseGeneration: number }> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
     VALUES ($1, 'sum_numbers', 'queued', $2, now(), now())`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob(workerId, 30000);
    if (!claimed) {
      throw new Error("Failed to claim job");
    }
    return { id, leaseGeneration: claimed.leaseGeneration };
  };

  it("1. queued job cancellation", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
     VALUES ($1, 'sum_numbers', 'queued', $2, now(), now())`,
      [id, JSON.stringify({})],
    );
    const affected = await repo.cancelQueuedJob(id);
    expect(affected).toBe(1);
    const refreshed = await repo.getJobById(id);
    expect(refreshed?.status).toBe("cancelled");
    expect(refreshed?.completedAt).not.toBeNull();
  });
  it("1. queued job cancellation", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
     VALUES ($1, 'sum_numbers', 'queued', $2, now(), now())`,
      [id, JSON.stringify({})],
    );
    const affected = await repo.cancelQueuedJob(id);
    expect(affected).toBe(1);
    const refreshed = await repo.getJobById(id);
    expect(refreshed?.status).toBe("cancelled");
    expect(refreshed?.completedAt).not.toBeNull();
  });
  it("2. running job cancellation request", async () => {
    const { id, leaseGeneration } = await claimRunningJob(pool);
    const affected = await repo.requestCancellation(id);
    expect(affected).toBe(1);
    const refreshed = await repo.getJobById(id);
    expect(refreshed?.cancellationRequestedAt).not.toBeNull();
    expect(refreshed?.status).toBe("running");
  });
  it("3. repeated cancellation", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
     VALUES ($1, 'sum_numbers', 'queued', $2, now(), now())`,
      [id, JSON.stringify({})],
    );
    let affected = await repo.cancelQueuedJob(id);
    expect(affected).toBe(1);
    affected = await repo.cancelQueuedJob(id);
    expect(affected).toBe(0);
    const refreshed = await repo.getJobById(id);
    expect(refreshed?.status).toBe("cancelled");
  });
  it("4. unknown job returns 404", async () => {
    const affected = await repo.requestCancellation(randomUUID());
    expect(affected).toBe(0);
  });
  it("5. terminal job remains unchanged", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, completed_at)
     VALUES ($1, 'sum_numbers', 'succeeded', $2, $3, NULL, now(), now(), now(), now())`,
      [id, JSON.stringify({}), JSON.stringify({ sum: 1 })],
    );
    const affected = await repo.requestCancellation(id);
    expect(affected).toBe(0);
    const refreshed = await repo.getJobById(id);
    expect(refreshed?.result).toEqual({ sum: 1 });
  });
  it("6. cancelled queued job cannot be claimed", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at, completed_at)
     VALUES ($1, 'sum_numbers', 'cancelled', $2, now(), now(), now())`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob("w1", 30000);
    expect(claimed).toBeNull();
  });
  it("7. cancellation does not increment attempt count", async () => {
    const id = randomUUID();
    // Test 1: queued job cancellation via cancelQueuedJob does not increment attempt count
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
     VALUES ($1, 'sum_numbers', 'queued', $2, now(), now())`,
      [id, JSON.stringify({})],
    );
    const affected1 = await repo.cancelQueuedJob(id);
    expect(affected1).toBe(1);
    const refreshed1 = await repo.getJobById(id);
    expect(refreshed1?.attemptCount).toBe(0);
    expect(refreshed1?.status).toBe("cancelled");

    // Test 2: running job cancellation via requestCancellation does not increment attempt count
    // Insert a running job directly (without claimRunningJob which increments attemptCount via claimNextJob)
    const id2 = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at, started_at, lease_generation, lease_expires_at, attempt_count)
     VALUES ($1, 'sum_numbers', 'running', $2, now(), now(), now(), 1, NULL, 0)`,
      [id2, JSON.stringify({})],
    );
    const affected2 = await repo.requestCancellation(id2);
    expect(affected2).toBe(1);
    const refreshed2 = await repo.getJobById(id2);
    // requestCancellation sets cancellation_requested_at but does not change status
    // The key verification: requestCancellation itself does not increment attemptCount
    // (any increment would have come from claimNextJob, which we bypassed by direct insertion)
    expect(refreshed2?.status).toBe("running");
    expect(refreshed2?.cancellationRequestedAt).not.toBeNull();
    // attemptCount should remain at the initial value since we bypassed claimNextJob
    expect(refreshed2?.attemptCount).toBe(0);
  });
  it("8. cancellation wins over success persistence", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
     VALUES ($1, 'sum_numbers', 'queued', $2, now(), now())`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob("w1", 30000);
    expect(claimed).not.toBeNull();
    await repo.requestCancellation(id);
    expect(Number(claimed?.leaseGeneration)).toBeGreaterThan(0);
    // Try to persist success - should fail because cancellation_requested_at is set
    const affected = await repo.markSucceeded(id, { sum: 42 }, "w1", Number(claimed?.leaseGeneration));
    expect(affected).toBe(0);
    // Job should remain with cancellation requested, status stays 'running'
    // but cancellation wins over success persistence
    const refreshed = await repo.getJobById(id);
    expect(refreshed?.cancellationRequestedAt).not.toBeNull();
    expect(refreshed?.status).toBe("running");
  });
  it("9. natural completion wins over cancellation", async () => {
    const id = randomUUID();
    // Insert as queued job, then claim it (simulating natural progression)
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at)
     VALUES ($1, 'sum_numbers', 'queued', $2, now(), now())`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob("w1", 30000);
    expect(claimed).not.toBeNull();
    // Let the job complete naturally first
    const affected = await repo.markSucceeded(id, { sum: 123 }, "w1", Number(claimed?.leaseGeneration));
    expect(affected).toBe(1);
    // Now request cancellation - should fail because status is 'succeeded', not 'running'
    const cancelAffected = await repo.requestCancellation(id);
    expect(cancelAffected).toBe(0);
    // Job should remain succeeded
    const refreshed = await repo.getJobById(id);
    expect(refreshed?.status).toBe("succeeded");
    expect(refreshed?.result).toEqual({ sum: 123 });
    expect(refreshed?.completedAt).not.toBeNull();
  });
  it("10. competing transitions - only one wins via database fencing", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, created_at, updated_at, started_at)
     VALUES ($1, 'sum_numbers', 'queued', $2, now(), now(), now())`,
      [id, JSON.stringify({})],
    );
    const claimed = await repo.claimNextJob("w1", 30000);
    expect(claimed).not.toBeNull();
    const cancelPromise = repo.requestCancellation(id);
    const successPromise = repo.markSucceeded(id, { sum: 999 }, "w1", Number(claimed?.leaseGeneration));
    let cancelResult: number;
    let successResult: number;
    [cancelResult, successResult] = await Promise.all([cancelPromise, successPromise]);
    const affectedCount = (cancelResult ?? 0) + (successResult ?? 0);
    expect(affectedCount).toBe(1);
    // Database fencing ensures only one transition wins
    // Since requestCancellation sets cancellation_requested_at, markSucceeded returns 0
    // The winning transition's result is reflected in the affected count
    const refreshed = await repo.getJobById(id);
    // The winning transition should have affected 1 row
    // Since cancellation was requested first (in the parallel execution), markSucceeded returns 0
    // and requestCancellation returns 1, so the job has cancellation requested but status stays 'running'
    // until markCancelled is called by the worker
    expect(affectedCount).toBe(1);
    expect(refreshed?.cancellationRequestedAt).not.toBeNull();
    // Status may be 'running' until markCancelled is called, or 'cancelled' if markCancelled was called
    // The key invariant is that only one of the transitions affected 1 row
  });
});