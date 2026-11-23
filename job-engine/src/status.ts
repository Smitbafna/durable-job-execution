/** Job Engine — Worker health status derivation.
 *
 * Derives status from persisted timestamps in the workers table:
 *   - online:   shutdownAt IS NULL AND lastHeartbeatAt within stale threshold
 *   - stale:    shutdownAt IS NULL AND lastHeartbeatAt exceeds stale threshold
 *   - stopped:  shutdownAt IS NOT NULL
 *
 * Uses a configurable stale-heartbeat threshold. Defaults to 30000ms (30 seconds).
 *
 * All timestamps within one response use a consistent time reference (now).
 */

import type { Pool, QueryResult } from "pg";
import { AppError, AppErrorCode } from "./errors.js";

/** Default stale heartbeat threshold: 30 seconds. */
const DEFAULT_STALE_THRESHOLD_MS = 30000;

/** Environment variable for overriding the stale heartbeat threshold (in ms). */
const STALE_THRESHOLD_MS_ENV = "WORKER_STALE_THRESHOLD_MS";

/** Loads the stale heartbeat threshold from the environment. */
export function loadStaleThresholdMs(): number {
  const v = process.env[STALE_THRESHOLD_MS_ENV];
  if (v === undefined || v.trim() === "") return DEFAULT_STALE_THRESHOLD_MS;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `Invalid ${STALE_THRESHOLD_MS_ENV}: must be a finite positive number, got "${v}"`,
    );
  }
  return n;
}

/** Worker status shape returned to the API client. */
export interface WorkerStatus {
  id: string;
  type: string;
  startedAt: string;
  lastHeartbeatAt: string;
  shutdownAt: string | null;
  status: "online" | "stale" | "stopped";
}

/**
 * Derive health status for a single worker.
 * @param worker - The worker row from the database (partial shape)
 * @param now - Optional reference time; defaults to Date.now()
 */
export function getWorkerStatus(
  worker: { id: string; type: string; started_at: Date | null; last_heartbeat_at: Date | null; shutdown_at: Date | null },
  now: number = Date.now()
): WorkerStatus {
  const shutdownAt = worker.shutdown_at?.getTime() ?? Infinity;
  const lastHB = worker.last_heartbeat_at?.getTime() ?? 0;
  const isStopped = shutdownAt < Infinity;

  if (isStopped) {
    return {
      id: worker.id,
      type: worker.type,
      startedAt: worker.started_at?.toISOString() ?? "",
      lastHeartbeatAt: worker.last_heartbeat_at?.toISOString() ?? "",
      shutdownAt: worker.shutdown_at?.toISOString() ?? null,
      status: "stopped",
    };
  }

  // Worker is still running (no shutdown)
  const age = now - lastHB;
  const threshold = loadStaleThresholdMs();

  if (age > threshold) {
    return {
      id: worker.id,
      type: worker.type,
      startedAt: worker.started_at?.toISOString() ?? "",
      lastHeartbeatAt: worker.last_heartbeat_at?.toISOString() ?? "",
      shutdownAt: worker.shutdown_at?.toISOString() ?? null,
      status: "stale",
    };
  }

  return {
    id: worker.id,
    type: worker.type,
    startedAt: worker.started_at?.toISOString() ?? "",
    lastHeartbeatAt: worker.last_heartbeat_at?.toISOString() ?? "",
    shutdownAt: worker.shutdown_at?.toISOString() ?? null,
    status: "online",
  };
}

/** Derive health status for all workers. */
export function listWorkersStatus(
  workers: { id: string; type: string; started_at: Date | null; last_heartbeat_at: Date | null; shutdown_at: Date | null }[]
): WorkerStatus[] {
  const now = Date.now();
  return workers.map((worker) => getWorkerStatus(worker, now));
}