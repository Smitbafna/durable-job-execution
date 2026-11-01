/**
 * Job Engine — domain model for a job.
 *
 * A `Job` is the durable record of a unit of work. In Week 1 jobs are only ever
 * *created* (as `queued`) and later *read*; they are not executed here.
 */

import type { JobType } from "./jobTypes.js";

/** Lifecycle state of a job. See `jobTransitions.ts` for the allowed graph. */
export enum JobStatus {
  Queued = "queued",
  Running = "running",
  Succeeded = "succeeded",
  Failed = "failed",
  Cancelled = "cancelled",
}

export const ALL_JOB_STATUSES: readonly JobStatus[] = [
  JobStatus.Queued,
  JobStatus.Running,
  JobStatus.Succeeded,
  JobStatus.Failed,
  JobStatus.Cancelled,
] as const;

/** Structured error stored on a failed job (null until a job fails). */
export interface JobError {
  code: string;
  message: string;
  details?: unknown;
}

/** A persisted job. Timestamps are `Date` instances; `startedAt`/`completedAt` are
 * nulled until a worker advances the job (Week 2+). */
export interface Job {
  readonly id: string;
  readonly type: JobType;
  readonly payload: unknown;
  readonly status: JobStatus;
  readonly result: unknown | null;
  readonly error: JobError | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly leaseExpiresAt: Date | null;
  readonly leaseGeneration: number;
  readonly fencingToken: number;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date | null;
  readonly cancellationRequestedAt: Date | null;
}
