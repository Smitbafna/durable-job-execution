import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createTestApp, truncateJobs } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";

const { app, pool } = createTestApp();

beforeEach(async () => {
  await truncateJobs(pool);
  await pool.query("TRUNCATE TABLE workers");
});

afterAll(async () => {
  await pool.end();
});

describe("worker repository (PostgreSQL integration)", () => {
  it("A: registration — register and retrieve a worker", async () => {
    const newWorkerId = randomUUID();
    await pool.query(
      `INSERT INTO workers (id, type) VALUES ($1, 'node')`,
      [newWorkerId],
    );
    const repo = new JobRepository(pool);
    const worker = await repo.getWorker(newWorkerId);
    expect(worker).not.toBeNull();
    expect(worker!.id).toBe(newWorkerId);
    expect(worker!.type).toBe("node");
    expect(worker!.startedAt).toBeInstanceOf(Date);
    expect(worker!.lastHeartbeatAt).toBeInstanceOf(Date);
    expect(worker!.shutdownAt).toBeNull();
  });

  it("B: re-registration — registering the same ID resets lifecycle timestamps", async () => {
    const workerId = randomUUID();
    await pool.query(
      `INSERT INTO workers (id, type) VALUES ($1, 'node')`,
      [workerId],
    );
    const repo = new JobRepository(pool);
    const first = await repo.getWorker(workerId);
    expect(first).not.toBeNull();
    const firstStartedAt = first!.startedAt.getTime();
    await repo.registerWorker(workerId);
    const second = await repo.getWorker(workerId);
    expect(second).not.toBeNull();
    expect(second!.startedAt.getTime()).not.toBe(firstStartedAt);
    expect(second!.shutdownAt).toBeNull();
  });

  it("C: heartbeat — advances lastHeartbeatAt and keeps worker registered", async () => {
    const workerId = randomUUID();
    await pool.query(
      `INSERT INTO workers (id, type) VALUES ($1, 'node')`,
      [workerId],
    );
    const repo = new JobRepository(pool);
    let worker = await repo.getWorker(workerId);
    expect(worker?.lastHeartbeatAt).toBeInstanceOf(Date);
    await repo.updateWorkerHeartbeat(workerId);
    const after = await repo.getWorker(workerId);
    expect(after!.lastHeartbeatAt.getTime()).toBeGreaterThan(
      worker!.lastHeartbeatAt.getTime(),
    );
    expect(after).not.toBeNull();
    expect(after!.id).toBe(workerId);
  });

  it("C-alt: updating a stopped worker does not clear shutdownAt", async () => {
    const workerId = randomUUID();
    await pool.query(
      `INSERT INTO workers (id, type) VALUES ($1, 'node')`,
      [workerId],
    );
    const repo = new JobRepository(pool);
    await repo.recordWorkerShutdown(workerId);
    const before = await repo.getWorker(workerId);
    expect(before!.shutdownAt).not.toBeNull();
    await repo.updateWorkerHeartbeat(workerId);
    const after = await repo.getWorker(workerId);
    expect(after!.shutdownAt).not.toBeNull();
    expect(after!.shutdownAt!.getTime()).toBe(before!.shutdownAt!.getTime());
    expect(after!.id).toBe(workerId);
  });

  it("D: shutdown — records shutdownAt and worker remains retrievable", async () => {
    const workerId = randomUUID();
    await pool.query(
      `INSERT INTO workers (id, type) VALUES ($1, 'node')`,
      [workerId],
    );
    const repo = new JobRepository(pool);
    await repo.recordWorkerShutdown(workerId);
    const worker = await repo.getWorker(workerId);
    expect(worker!.shutdownAt).not.toBeNull();
    expect(worker!.id).toBe(workerId);
  });

  it("D-alt: calling shutdown again is consistent and does not error", async () => {
    const workerId = randomUUID();
    await pool.query(
      `INSERT INTO workers (id, type) VALUES ($1, 'node')`,
      [workerId],
    );
    const repo = new JobRepository(pool);
    await repo.recordWorkerShutdown(workerId);
    await repo.recordWorkerShutdown(workerId);
    const worker = await repo.getWorker(workerId);
    expect(worker!.shutdownAt).not.toBeNull();
    expect(worker!.id).toBe(workerId);
  });

  it("E: unknown worker — getWorker returns null", async () => {
    const repo = new JobRepository(pool);
    const unknownId = randomUUID();
    const worker = await repo.getWorker(unknownId);
    expect(worker).toBeNull();
  });

  it("E: unknown worker — updateWorkerHeartbeat throws DbError", async () => {
    const repo = new JobRepository(pool);
    const unknownId = randomUUID();
    await expect(repo.updateWorkerHeartbeat(unknownId)).rejects.toThrow(
      /Cannot update heartbeat: worker/,
    );
  });

  it("E: unknown worker — recordWorkerShutdown throws DbError", async () => {
    const repo = new JobRepository(pool);
    const unknownId = randomUUID();
    await expect(repo.recordWorkerShutdown(unknownId)).rejects.toThrow(
      /Cannot record shutdown: worker/,
    );
  });

  it("F: listing — returns all workers ordered by startedAt ASC", async () => {
    const repo = new JobRepository(pool);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      ids.push(id);
      await pool.query(`INSERT INTO workers (id, type) VALUES ($1, 'node')`, [id]);
    }
    const workers = await repo.listWorkers();
    expect(workers).toHaveLength(3);
    const workerIds = workers.map((w) => w.id);
    ids.forEach((id) => expect(workerIds).toContain(id));
    for (let i = 1; i < workers.length; i++) {
      expect(workers[i - 1].startedAt.getTime()).toBeLessThanOrEqual(
        workers[i].startedAt.getTime(),
      );
    }
  });
});
