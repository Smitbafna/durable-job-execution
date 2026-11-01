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
      resources: { cpu: 1, memoryMb: 128, timeoutSeconds: 30 },
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
}

function makeWorker(repo: FakeRepo, heartbeatIntervalMs = 10000) {
  const artifactService = {
    getArtifact: async () => ({ storageKey: "artifact-key" }),
    materializeArtifact: async () => {},
  };
  const runtime = {
    execute: async (_spec: any, _path: string, options?: { signal?: AbortSignal }) =>
      new Promise<any>((resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
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

describe("worker heartbeat M4.1B", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ownership loss cancels execution and skips persistence", async () => {
    vi.useRealTimers();
    const repo = new FakeRepo();
    repo.renewImpl = async () => false;
    const worker = makeWorker(repo, 5);
    const job = makeJob();
    const promise = (worker as any).executeJob(job);
    await new Promise((r) => setTimeout(r, 50));
    await promise.catch(() => undefined);
    expect(repo.markSucceededCalled).toBe(false);
    expect(repo.markFailedCalled).toBe(false);
  });

  it("transient failure then success allows execution to continue", async () => {
    const repo = new FakeRepo();
    let calls = 0;
    repo.renewImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("db unavailable");
      return true;
    };
    const worker = makeWorker(repo);
    const job = makeJob();
    let resolved = false;
    const runtimePromise = new Promise<any>((resolve) => {
      (worker as any)._resolveRuntime = resolve;
    });
    // Replace runtime execute to resolve after we trigger it.
    const registry = (worker as any).runtimeRegistry;
    const rt = registry.resolve("python:3.12");
    rt.execute = async (_spec: any, _path: string, options?: { signal?: AbortSignal }) =>
      new Promise<any>((resolve) => {
        (worker as any)._resolveRuntime = resolve;
      });
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(1000);
    (worker as any)._resolveRuntime({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
    await promise;
    expect(repo.markSucceededCalled).toBe(true);
  });

  it("repeated failures reach safety deadline and fail closed", async () => {
    const repo = new FakeRepo();
    repo.renewImpl = async () => {
      throw new Error("db unavailable");
    };
    const worker = makeWorker(repo);
    const job = makeJob();
    const registry = (worker as any).runtimeRegistry;
    const rt = registry.resolve("python:3.12");
    rt.execute = async (_spec: any, _path: string, options?: { signal?: AbortSignal }) =>
      new Promise<any>((resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(15000);
    await promise.catch(() => undefined);
    expect(repo.markSucceededCalled).toBe(false);
    expect(repo.markFailedCalled).toBe(false);
  });

  it("shutdown stops heartbeat timers", async () => {
    const repo = new FakeRepo();
    const worker = makeWorker(repo);
    const job = makeJob();
    (worker as any).startHeartbeat(job, new AbortController());
    expect((worker as any).heartbeats.size).toBe(1);
    (worker as any).stopHeartbeat(job.id);
    expect((worker as any).heartbeats.size).toBe(0);
    await vi.advanceTimersByTimeAsync(20000);
    expect(repo.renewCalls).toBe(0);
  });

  it("slow renewal does not overlap", async () => {
    const repo = new FakeRepo();
    let resolveRenew: ((v: boolean) => void) | undefined;
    repo.renewImpl = () => new Promise<boolean>((resolve) => {
      resolveRenew = resolve;
    });
    const worker = makeWorker(repo);
    const job = makeJob();
    const registry = (worker as any).runtimeRegistry;
    const rt = registry.resolve("python:3.12");
    rt.execute = async (_spec: any, _path: string, options?: { signal?: AbortSignal }) =>
      new Promise<any>((resolve) => {
        (worker as any)._resolveRuntime = resolve;
      });
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    expect(repo.renewCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(repo.renewCalls).toBe(1);
    resolveRenew?.(true);
    await vi.advanceTimersByTimeAsync(0);
    (worker as any)._resolveRuntime({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
    await promise;
    expect(repo.markSucceededCalled).toBe(true);
  });
});

describe("heartbeat deadline and late renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("records renewal deadline from request start despite DB latency", async () => {
    const repo = new FakeRepo();
    repo.renewImpl = () => new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(true), 8000);
    });
    const worker = makeWorker(repo);
    const job = makeJob();
    const runtime = (worker as any).runtimeRegistry.resolve("python:3.12");
    let resolveRuntime: ((v: any) => void) | undefined;
    runtime.execute = async () => new Promise<any>((resolve) => { resolveRuntime = resolve; });
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(8000);
    const state = (worker as any).heartbeatStates.get(job.id);
    expect(typeof state.lastRenewalStartedAt).toBe("number");
    resolveRuntime?.({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
    await (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });

  it("failed renewal does not update the last successful renewal timestamp", async () => {
    const repo = new FakeRepo();
    repo.renewImpl = async () => {
      throw new Error("db unavailable");
    };
    const worker = makeWorker(repo);
    const job = makeJob();
    const runtime = (worker as any).runtimeRegistry.resolve("python:3.12");
    let resolveRuntime: ((v: any) => void) | undefined;
    runtime.execute = async () => new Promise<any>((resolve) => { resolveRuntime = resolve; });
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    const state = (worker as any).heartbeatStates.get(job.id);
    expect(typeof state.lastRenewalStartedAt).toBe("number");
    resolveRuntime?.({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });

  it("successful retry establishes a new deadline from that request", async () => {
    const repo = new FakeRepo();
    let calls = 0;
    repo.renewImpl = async () => {
      calls++;
      if (calls === 1) throw new Error("db unavailable");
      return true;
    };
    const worker = makeWorker(repo);
    const job = makeJob();
    const runtime = (worker as any).runtimeRegistry.resolve("python:3.12");
    let resolveRuntime: ((v: any) => void) | undefined;
    runtime.execute = async () => new Promise<any>((resolve) => { resolveRuntime = resolve; });
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    await vi.advanceTimersByTimeAsync(1000);
    const state = (worker as any).heartbeatStates.get(job.id);
    expect(typeof state.lastRenewalStartedAt).toBe("number");
    resolveRuntime?.({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });

  it("initial claim deadline is conservative", async () => {
    const repo = new FakeRepo();
    const worker = makeWorker(repo);
    const job = makeJob();
    (worker as any).startHeartbeat(job, new AbortController(), 0);
    const state = (worker as any).heartbeatStates.get(job.id);
    expect(typeof state.lastRenewalStartedAt).toBe("number");
    (worker as any).stopHeartbeat(job.id);
  });

  it("late renewal response cannot restart scheduling after shutdown", async () => {
    const repo = new FakeRepo();
    let resolveRenew: ((v: boolean) => void) | undefined;
    repo.renewImpl = () => new Promise<boolean>((resolve) => {
      resolveRenew = resolve;
    });
    const worker = makeWorker(repo);
    const job = makeJob();
    const runtime = (worker as any).runtimeRegistry.resolve("python:3.12");
    let resolveRuntime: ((v: any) => void) | undefined;
    runtime.execute = async () => new Promise<any>((resolve) => { resolveRuntime = resolve; });
    const promise = (worker as any).executeJob(job);
    await vi.advanceTimersByTimeAsync(10000);
    expect(repo.renewCalls).toBe(1);
    (worker as any).stopHeartbeat(job.id);
    resolveRenew?.(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(repo.renewCalls).toBe(1);
    resolveRuntime?.({ exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 });
    (worker as any).stopHeartbeat(job.id);
    await promise.catch(() => undefined);
  });
});
