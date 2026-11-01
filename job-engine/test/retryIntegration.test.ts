import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { truncateJobs, createTestPool } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";
import { Worker } from "../src/worker/worker.js";
import { RuntimeRegistry } from "../src/runtime/executionRuntime.js";
import { AppError, AppErrorCode } from "../src/errors.js";
import { loadRetryPolicyConfig } from "../src/config.js";

describe("worker retry integration (PostgreSQL)", () => {
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

  function makeWorker(runtimeExecute: () => Promise<any>) {
    const artifactService = {
      getArtifact: async () => ({ storageKey: "k" }),
      materializeArtifact: async () => {},
    };
    const registry = new RuntimeRegistry();
    registry.register("python:3.12", {
      execute: runtimeExecute,
      shutdown: async () => {},
    } as any);
    return new Worker(
      { workerId: "w1", pollIntervalMs: 10, concurrency: 1 } as any,
      { info() {}, warn() {}, error() {} },
      repo,
      pool,
      registry,
      artifactService as any,
      { maxCpu: 4, maxMemoryMb: 1024, maxTimeoutSeconds: 300, maxCommandLength: 64, maxInputJsonBytes: 65536, maxInputDepth: 8 } as any,
      { leaseDurationMs: 30000, heartbeatIntervalMs: 10000 },
      loadRetryPolicyConfig(),
    );
  }

  async function insertArtifactJob() {
    const id = randomUUID();
    const artifactId = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload) VALUES ($1, 'execute_artifact', 'queued', $2)`,
      [
        id,
        JSON.stringify({
          artifactId,
          runtime: "python:3.12",
          command: ["python", "main.py"],
          workingDirectory: ".",
          input: {},
          resources: { cpu: 1, memoryMb: 128, timeoutSeconds: 30 },
        }),
      ],
    );
    return { id, artifactId };
  }

  it("retryable failure schedules a retry and does not increment attempt count", async () => {
    const { id } = await insertArtifactJob();
    const job = await repo.claimNextJob("w1", 30000);
    expect(job).not.toBeNull();

    const worker = makeWorker(async () => {
      throw new AppError(AppErrorCode.Internal, 500, "Docker execution failed: temporary", {
        retryable: true,
        failureKind: "docker_infrastructure",
      });
    });
    await (worker as any).executeJob(job);

    const row = await pool.query(
      `SELECT status, attempt_count, next_attempt_at FROM jobs WHERE id = $1`,
      [id],
    );
    expect(row.rows[0].status).toBe("queued");
    expect(Number(row.rows[0].attempt_count)).toBe(1);
    expect(row.rows[0].next_attempt_at).not.toBeNull();
  });

  it("non-retryable failure becomes terminal", async () => {
    const { id } = await insertArtifactJob();
    const job = await repo.claimNextJob("w1", 30000);
    const worker = makeWorker(async () => {
      throw new AppError(AppErrorCode.Internal, 500, "Docker execution failed: bad");
    });
    await (worker as any).executeJob(job);

    const row = await pool.query(`SELECT status, attempt_count FROM jobs WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("failed");
    expect(Number(row.rows[0].attempt_count)).toBe(1);
  });

  it("exhausted attempts become terminal", async () => {
    const { id } = await insertArtifactJob();
    await pool.query(`UPDATE jobs SET max_attempts = 1 WHERE id = $1`, [id]);
    const job = await repo.claimNextJob("w1", 30000);
    expect(job?.attemptCount).toBe(1);

    const worker = makeWorker(async () => {
      throw new AppError(AppErrorCode.Internal, 500, "Docker execution failed: temporary", {
        retryable: true,
        failureKind: "docker_infrastructure",
      });
    });
    await (worker as any).executeJob(job);

    const row = await pool.query(`SELECT status FROM jobs WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("failed");
  });

  it("success behavior remains unchanged", async () => {
    const { id } = await insertArtifactJob();
    const job = await repo.claimNextJob("w1", 30000);
    const worker = makeWorker(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 1,
    }));
    await (worker as any).executeJob(job);

    const row = await pool.query(`SELECT status, result, error FROM jobs WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe("succeeded");
    expect(row.rows[0].result).not.toBeNull();
    expect(row.rows[0].error).toBeNull();
  });
});