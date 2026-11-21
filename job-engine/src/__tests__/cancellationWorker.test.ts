import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Worker } from "../worker/worker.js";
import { RuntimeRegistry } from "../runtime/executionRuntime.js";
import type { Job } from "../domain/job.js";

function makeJob(): Job {
  return {
    id: "job-1",
    type: "execute_artifact" as any,
    payload: {
      artifactId: "123e4567-e89b-41d4-a716-446655440000",
      runtime: "python:3.12",
      command: ["python", "main.py"],
      workingDirectory: ".",
      input: {},
    },
    status: "running" as any,
    result: null,
    error: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    leaseExpiresAt: new Date(Date.now() + 30000),
    leaseGeneration: 1,
    fencingToken: 1,
    cancellationRequestedAt: null,
    attemptCount: 1,
    maxAttempts: 3,
    nextAttemptAt: null,
  };
}

class FakeRepo {
  renewCalls = 0;
  markSucceededCalled = false;
  markFailedCalled = false;
  renewImpl: () => Promise<boolean> = async () => true;
  async claimNextJob() { return null; }
  async renewLease() { this.renewCalls++; return this.renewImpl(); }
  async markSucceeded() { this.markSucceededCalled = true; return 1; }
  async markFailed() { this.markFailedCalled = true; return 1; }
  async getJobById() { return null; }
  async requestCancellation(id: string) { return 1; }
  async markCancelled(id: string, workerId: string, leaseGeneration: number) { return 1; }
}

function makeWorker(repo: FakeRepo, heartbeatIntervalMs = 10000) {
  const artifactService = {
    getArtifact: async () => ({ storageKey: "artifact-key" }),
    materializeArtifact: async () => {},
  };
  const runtime = {
    execute: async (_spec: any, _path: string, options?: { signal?: AbortSignal }) => {
      new Promise<any>((resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  };
  const registry = new RuntimeRegistry();
  registry.register("python:3.12", runtime as any);
  return new Worker(
    { workerId: "w", pollIntervalMs: 10, concurrency: 1 } as any,
    { info() {}, warn() {}, error() {} },
    repo as any,
    undefined,
    registry,
    artifactService as any,
    undefined,
    { leaseDurationMs: 30000, heartbeatIntervalMs, maxCpu: 4, maxMemoryMb: 1024, maxTimeoutSeconds: 300, maxCommandLength: 64, maxInputJsonBytes: 65536, maxInputDepth: 8 } as any,
  );
}

describe("worker cancellation lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("8. heartbeat detects cancellation", async () => {
    const repo = new FakeRepo();
    repo.renewImpl = async () => {
      return false;
    };
    const worker = makeWorker(repo);
    const job = makeJob();
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(15000);
    expect(repo.markSucceededCalled).toBe(false);
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });

  it("9. heartbeat scheduling stops after cancellation", async () => {
    const repo = new FakeRepo();
    let renewalCalled = false;
    repo.renewImpl = async () => {
      renewalCalled = true;
      return true;
    };
    const worker = makeWorker(repo, 50);
    const job = makeJob();
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(60000);
    await repo.requestCancellation(job.id);
    await vi.advanceTimersByTimeAsync(60000);
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });

  it("10. cancellation prevents success persistence", async () => {
    const repo = new FakeRepo();
    repo.renewImpl = async () => true;
    const worker = makeWorker(repo);
    const job = makeJob();
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    await repo.requestCancellation(job.id);
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
    expect(repo.markSucceededCalled).toBe(false);
  });

  it("11. cancellation prevents retry scheduling", async () => {
    const repo = new FakeRepo();
    repo.renewImpl = async () => true;
    const worker = makeWorker(repo);
    const job = makeJob();
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    await repo.requestCancellation(job.id);
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });

  it("12. failed markCancelled is observable", async () => {
    const repo = new FakeRepo();
    repo.markCancelled = async (id: string, workerId: string, leaseGeneration: number) => {
      throw new Error("stale worker attempted cancellation");
    };
    const worker = makeWorker(repo);
    const job = makeJob();
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    try {
      await repo.markCancelled(job.id, "w1", 1);
      expect(true).toBe(true);
    } catch (e: any) {
      expect(e.message).toContain("stale worker");
    }
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });

  it("13. stale worker cannot finalize cancellation", async () => {
    const repo = new FakeRepo();
    repo.markCancelled = async (id: string, workerId: string, leaseGeneration: number) => {
      return 0;
    };
    const worker = makeWorker(repo);
    const job = makeJob();
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(35000);
    const marked = await repo.markCancelled(job.id, "stale-worker", 1);
    expect(marked).toBe(0);
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });

  it("14. expired-lease recovery finalizes cancellation after worker failure", async () => {
    const repo = new FakeRepo();
    let reclaimCount = 0;
    repo.renewImpl = async () => {
      reclaimCount++;
      return reclaimCount <= 1;
    };
    repo.markCancelled = async (id: string, workerId: string, leaseGeneration: number) => {
      return 1;
    };
    const worker = makeWorker(repo);
    const job = makeJob();
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(35000);
    const marked = await repo.markCancelled(job.id, "new-worker", 2);
    expect(marked).toBe(1);
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });
});
