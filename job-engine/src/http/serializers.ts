/**
 * Job Engine — HTTP response serialization.
 *
 * Maps the domain `Job` to the JSON contract exposed over HTTP: snake_case DB
 * columns become camelCase, `Date` values become ISO strings, and `null`
 * timestamps stay `null`.
 */

import type { Job } from "../domain/job.js";

export interface JobResponse {
  readonly id: string;
  readonly type: string;
  readonly status: string;
  readonly payload: unknown;
  readonly result: unknown | null;
  readonly error: { code: string; message: string; details?: unknown } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string | null;
  readonly cancellationRequestedAt: string | null;
}

export function serializeJob(job: Job): JobResponse {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    payload: job.payload,
    result: job.result,
    error: job.error === null ? null : { ...job.error },
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
    attemptCount: job.attemptCount,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt ? job.nextAttemptAt.toISOString() : null,
    cancellationRequestedAt: job.cancellationRequestedAt
      ? job.cancellationRequestedAt.toISOString()
      : null,
  };
}

export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

export function serializeError(err: {
  code: string;
  message: string;
  details?: unknown;
}): ErrorResponse {
  const body: { code: string; message: string; details?: unknown } = {
    code: err.code,
    message: err.message,
  };
  if (err.details !== undefined) {
    body.details = err.details;
  }
  return { error: body };
}
