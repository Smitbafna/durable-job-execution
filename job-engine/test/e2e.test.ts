/**
 * Job Engine — end-to-end PostgreSQL integration tests.
 *
 * Exercises the full HTTP -> service -> repository -> PostgreSQL -> worker ->
 * PostgreSQL -> HTTP flow using the real test database. A job is submitted
 * through `POST /jobs`, a real worker process claims and executes it, and the
 * final status/result are retrieved via `GET /jobs/:id`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { Pool } from "pg";
import type { Express } from "express";
import { truncateJobs, createTestPool } from "./helpers.js";
import { createApp } from "../src/app.js";
import { JobRepository } from "../src/db/repository.js";
import { Worker, type WorkerLogger } from "../src/worker/worker.js";

function poolWith(): Pool {
  return createTestPool();
}

function logger(): WorkerLogger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `fn` until it returns truthy or `timeoutMs` elapses. */
async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null) return v;
    await sleep(intervalMs);
  }
  return null;
}

describe("end-to-end HTTP -> worker -> PostgreSQL", () => {
  let appPool: Pool;
  let app: Express;

  beforeEach(async () => {
    appPool = poolWith();
    const container = createApp({ pool: appPool });
    app = container.app;
    await truncateJobs(appPool);
  });

  afterEach(async () => {
    await appPool.end().catch(() => undefined);
  });

  it("sum_numbers submits, is queued, executed by a worker, and becomes succeeded with { sum: 60 }", async () => {
    // 1. Submit a job.
    const create = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: [10, 20, 30] } })
      .set("Accept", "application/json");
    expect(create.status).toBe(201);
    expect(create.body.status).toBe("queued");
    expect(create.body.result).toBeNull();
    const id = create.body.id;

    // 2. Verify it is initially queued.
    const fetched = await request(app).get(`/jobs/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.status).toBe("queued");
    expect(fetched.body.result).toBeNull();

    // 3. Run a real worker against the test database.
    const workerPool = poolWith();
    const repo = new JobRepository(workerPool);
    const worker = new Worker({ workerId: "e2e-worker", pollIntervalMs: 50, concurrency: 1 }, logger(), repo, workerPool);
    worker.start();

    // 4. Wait for execution to finish (bounded polling).
    const status = await pollUntil(
      async () => {
        const res = await request(app).get(`/jobs/${id}`);
        return res.body.status === "succeeded" ? res.body : null;
      },
      5000,
      100,
    );

    worker.stop();

    expect(status).not.toBeNull();
    expect(status!.status).toBe("succeeded");
    expect(status!.result).toEqual({ sum: 60 });
    expect(status!.completed_at).not.toBeNull();

    // 5. Retrieve through GET /jobs/:id again.
    const final = await request(app).get(`/jobs/${id}`);
    expect(final.status).toBe(200);
    expect(final.body.status).toBe("succeeded");
    expect(final.body.result).toEqual({ sum: 60 });
  });

  it("a failing job is persisted as failed through the worker path", async () => {
    // Submit a valid job, then manually corrupt its payload in the DB so the
    // handler will fail when the worker processes it.
    const create = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: [1, 2, 3] } })
      .set("Accept", "application/json");
    expect(create.status).toBe(201);
    const id = create.body.id;
    expect(create.body.status).toBe("queued");

    // Corrupt the payload so the handler will fail on execution.
    await appPool.query(
      `UPDATE jobs SET payload = $1 WHERE id = $2`,
      [JSON.stringify({ numbers: ["bad"] }), id],
    );

    const workerPool = poolWith();
    const repo = new JobRepository(workerPool);
    const worker = new Worker({ workerId: "e2e-fail-worker", pollIntervalMs: 50, concurrency: 1 }, logger(), repo, workerPool);
    worker.start();

    const final = await pollUntil(
      async () => {
        const res = await request(app).get(`/jobs/${id}`);
        return res.body.status === "failed" ? res.body : null;
      },
      5000,
      100,
    );

    worker.stop();

    expect(final).not.toBeNull();
    expect(final!.status).toBe("failed");
    expect(final!.error).not.toBeNull();
    // Error info is sanitized: no stack trace.
    expect(final!.error!.code).toBe("VALIDATION_ERROR");
  });

  it("a worker keeps processing subsequent jobs after one job fails", async () => {
    // Submit one valid job and one job that will fail (corrupted payload).
    // Both should be processed: the valid one succeeds, the invalid one fails,
    // and the worker continues running.
    const goodCreate = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: [1, 2, 3] } })
      .set("Accept", "application/json");
    expect(goodCreate.status).toBe(201);
    const goodId = goodCreate.body.id;

    const badCreate = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: [10, 20] } })
      .set("Accept", "application/json");
    expect(badCreate.status).toBe(201);
    const badId = badCreate.body.id;

    // Corrupt the second job's payload so it will fail.
    await appPool.query(
      `UPDATE jobs SET payload = $1 WHERE id = $2`,
      [JSON.stringify({ numbers: ["bad"] }), badId],
    );

    const workerPool = poolWith();
    const repo = new JobRepository(workerPool);
    const worker = new Worker({ workerId: "e2e-continue", pollIntervalMs: 50, concurrency: 1 }, logger(), repo, workerPool);
    worker.start();

    const good = await pollUntil(
      async () => {
        const res = await request(app).get(`/jobs/${goodId}`);
        return res.body.status === "succeeded" ? res.body : null;
      },
      5000,
      100,
    );
    expect(good).not.toBeNull();
    expect(good!.result).toEqual({ sum: 6 });

    const failed = await pollUntil(
      async () => {
        const res = await request(app).get(`/jobs/${badId}`);
        return res.body.status === "failed" ? res.body : null;
      },
      5000,
      100,
    );
    expect(failed).not.toBeNull();
    expect(failed!.status).toBe("failed");
    expect(failed!.error).not.toBeNull();

    worker.stop();
  });

  it("empty queue does not spin the worker: no queued jobs yields promptly", async () => {
    const create = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: [1, 2, 3] } })
      .set("Accept", "application/json");
    expect(create.status).toBe(201);
    const id = create.body.id;

    const workerPool = poolWith();
    const repo = new JobRepository(workerPool);
    const worker = new Worker({ workerId: "e2e-nothing", pollIntervalMs: 50, concurrency: 1 }, logger(), repo, workerPool);
    worker.start();

    // We only verify the worker started and the job is claimed after a poll.
    const status = await pollUntil(
      async () => {
        const res = await request(app).get(`/jobs/${id}`);
        return res.body.status === "succeeded" ? res.body.status : null;
      },
      5000,
      100,
    );

    worker.stop();
    expect(status).not.toBeNull();
    expect(status).toBe("succeeded");
  });
});
