import { describe, it, expect } from "vitest";
import { getWorkerStatus, listWorkersStatus, loadStaleThresholdMs } from "../src/status.js";

describe("stale threshold configuration", () => {
  const defaultWorker = {
    id: "test-worker-id",
    type: "node",
    started_at: new Date(),
    last_heartbeat_at: new Date(Date.now() - 1000),
    shutdown_at: null,
  };

  const staleWorker = {
    id: "test-worker-id",
    type: "node",
    started_at: new Date(),
    last_heartbeat_at: new Date(Date.now() - 60000),
    shutdown_at: null,
  };

  const stoppedWorker = {
    id: "test-worker-id",
    type: "node",
    started_at: new Date(),
    last_heartbeat_at: new Date(Date.now() - 1000),
    shutdown_at: new Date(Date.now() - 5000),
  };

  it("getWorkerStatus uses the default threshold of 30000ms when env var is not set", () => {
    const result = getWorkerStatus(defaultWorker);
    expect(result.status).toBe("online");
  });

  it("getWorkerStatus marks worker as stale when heartbeat exceeds default threshold", () => {
    const result = getWorkerStatus(staleWorker);
    expect(result.status).toBe("stale");
  });

  it("getWorkerStatus marks stopped worker correctly regardless of threshold", () => {
    const result = getWorkerStatus(stoppedWorker);
    expect(result.status).toBe("stopped");
  });

  it("listWorkersStatus uses consistent time reference within a response", () => {
    const workers = [defaultWorker, staleWorker, stoppedWorker];
    const statuses = listWorkersStatus(workers);
    expect(statuses).toHaveLength(3);
    expect(statuses[0].status).toBe("online");
    expect(statuses[1].status).toBe("stale");
    expect(statuses[2].status).toBe("stopped");
  });

  it("accepts custom threshold via environment variable", () => {
    const originalEnv = process.env.WORKER_STALE_THRESHOLD_MS;
    try {
      process.env.WORKER_STALE_THRESHOLD_MS = "5000";
      const result = getWorkerStatus(staleWorker);
      expect(result.status).toBe("stale");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.WORKER_STALE_THRESHOLD_MS;
      } else {
        process.env.WORKER_STALE_THRESHOLD_MS = originalEnv;
      }
    }
  });

  it("loadStaleThresholdMs returns default when env var is unset", () => {
    const result = loadStaleThresholdMs();
    expect(result).toBe(30000);
  });
});
