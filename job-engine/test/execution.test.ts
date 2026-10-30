/**
 * Job Engine — PostgreSQL integration tests: job execution outcomes.
 *
 * Exercises the worker handler and the outcome persistence invariants against
 * the real `job_engine_test` database: `sum_numbers` produces the correct
 * result, a successful job becomes `succeeded` with `completed_at` populated,
 * a handler error becomes `failed`, error info is persisted safely, and the
 * worker keeps processing subsequent jobs after one fails.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { truncateJobs, createTestPool } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";
import { sumNumbersHandler } from "../src/worker/handlers/sumNumbersHandler.js";

function poolWith(): Pool {
  return createTestPool();
}

function insertJob(
  pool: Pool,
  status: string,
  result: unknown,
  error: unknown,
) {
  return pool.query(
    `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
     VALUES ($1, 'sum_numbers', $2, $3, $4, $5, now(), now())`,
    [randomUUID(), status, JSON.stringify({ numbers: [1, 2, 3] }), result, error],
  );
}

describe("job execution outcomes", () => {
  let pool: Pool;
  beforeEach(async () => {
    pool = poolWith();
    await truncateJobs(pool);
  });
  afterEach(async () => {
    await pool.end().catch(() => undefined);
  });

  it("a successfully executed job becomes succeeded with its result persisted", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [id, JSON.stringify({ numbers: [1, 2, 3] })],
    );

    const repo = new JobRepository(pool);
    const claimed = await repo.claimNextJob(`exec-${Math.random().toString(16).slice(2)}`);
    expect(claimed).not.toBeNull();
    expect(claimed!.status).toBe("running");

    const handler = sumNumbersHandler({});
    const result = handler(claimed!.payload);
    const affected = await repo.markSucceeded(id, result);

    expect(affected).toBe(1);

    const refreshed = await repo.getJobById(id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.status).toBe("succeeded");
    expect(refreshed!.result).toEqual({ sum: 6 });
    expect(refreshed!.startedAt).not.toBeNull();
    expect(refreshed!.completedAt).not.toBeNull();
  });

  it("a handler error marks the job failed with safe error info", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [id, JSON.stringify({ numbers: ["not-a-number"] })],
    );

    const repo = new JobRepository(pool);
    const claimed = await repo.claimNextJob(`exec2-${Math.random().toString(16).slice(2)}`);
    expect(claimed).not.toBeNull();

    const handler = sumNumbersHandler({});
    let failure = false;
    try {
      handler(claimed!.payload);
    } catch (e) {
      failure = true;
      expect((e as Error).message).toBeDefined();
    }
    expect(failure).toBe(true);

    const affected = await repo.markFailed(
      id,
      { code: "VALIDATION_ERROR", message: "payload.numbers must be an array" },
    );
    expect(affected).toBe(1);

    const refreshed = await repo.getJobById(id);
    expect(refreshed).not.toBeNull();
    expect(refreshed!.status).toBe("failed");
    expect(refreshed!.error).not.toBeNull();
    expect(refreshed!.error!.code).toBe("VALIDATION_ERROR");
    expect(refreshed!.error!.message).toBe("payload.numbers must be an array");
  });

  it("a failed job cannot be completed again", async () => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, completed_at)
       VALUES ($1, 'sum_numbers', 'failed', $2, $3, $4, now(), now(), now(), now())`,
      [id, JSON.stringify({}), JSON.stringify({ sum: 6 }), JSON.stringify({ code: "TEST" })],
    );

    const repo = new JobRepository(pool);
    const failed = await repo.markFailed(id, {
      code: "DUPLICATE",
      message: "should not happen",
    });
    expect(failed).toBe(0);
  });

  it("a worker continues processing subsequent jobs after a failure", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [id1, JSON.stringify({ numbers: ["not-a-number"] })],
    );
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [id2, JSON.stringify({ numbers: [10, 20] })],
    );

    const repo = new JobRepository(pool);

    // Claim the first job (which has an invalid payload that will cause the
    // handler to throw), execute it, and record the failure.
    const first = await repo.claimNextJob(`continue1-${Math.random().toString(16).slice(2)}`);
    expect(first).not.toBeNull();
    expect(first!.status).toBe("running");

    const handler = sumNumbersHandler({});
    let failureError: Error | undefined;
    try {
      handler(first!.payload);
    } catch (e) {
      failureError = e as Error;
    }
    expect(failureError).toBeDefined();
    expect(failureError!.message).toBeDefined();

    const markFailed = await repo.markFailed(id1, {
      code: "HANDLER_EXCEPTION",
      message: failureError!.message,
    });
    expect(markFailed).toBe(1);

    // Claim and execute the second job (valid payload).
    const second = await repo.claimNextJob(`continue2-${Math.random().toString(16).slice(2)}`);
    expect(second).not.toBeNull();
    expect(second!.status).toBe("running");
    const result = handler(second!.payload);
    const affected = await repo.markSucceeded(second!.id, result);
    expect(affected).toBe(1);

    const [r1, r2] = await Promise.all([repo.getJobById(id1), repo.getJobById(id2)]);
    expect(r1!.status).toBe("failed");
    expect(r1!.error).not.toBeNull();
    expect(r1!.completedAt).not.toBeNull();
    expect(r2!.status).toBe("succeeded");
    expect(r2!.result).toEqual({ sum: 30 });
    expect(r2!.completedAt).not.toBeNull();
  });

  it("a running job cannot be re-claimed, and terminal jobs cannot be re-claimed", async () => {
    const queued = randomUUID();
    const running = randomUUID();
    const succeeded = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
       VALUES ($1, 'sum_numbers', 'queued', $2, NULL, NULL, now(), now())`,
      [queued, JSON.stringify({})],
    );
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now())`,
      [running, JSON.stringify({})],
    );
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, completed_at)
       VALUES ($1, 'sum_numbers', 'succeeded', $2, $3, NULL, now(), now(), now(), now())`,
      [succeeded, JSON.stringify({}), JSON.stringify({ sum: 1 })],
    );

    const repo = new JobRepository(pool);
    const claimed = await repo.claimNextJob(`e2e-${Math.random().toString(16).slice(2)}`);
    expect(claimed).not.toBeNull();
    const r = claimed!.id;

    expect(r).toBe(queued);
    // The running and succeeded jobs must not be yieldable.
    expect((await repo.claimNextJob(`e2e2-${Math.random().toString(16).slice(2)}`))).toBeNull();
  });
});
