/**
 * Job Engine — PostgreSQL job repository.
 *
 * Owns all SQL for jobs. Uses parameterized queries exclusively and maps rows
 * to the domain `Job` type. Connection/driver errors are normalized into
 * `AppError` (`DB_ERROR`, 503) so callers never see raw driver internals.
 */

import type { Pool, QueryResult } from "pg";
import { AppError, AppErrorCode, toAppError } from "../errors.js";
import type { Job, JobError } from "../domain/job.js";
import type { JobType } from "../domain/jobTypes.js";
import { JobStatus } from "../domain/job.js";

export interface CreateJobInput {
  readonly id: string;
  readonly type: JobType;
  readonly payload: unknown;
  readonly maxAttempts?: number;
}

/** Raw DB row (snake_case) produced by `SELECT * FROM jobs`. */
interface JobRow {
  id: string;
  type: string;
  status: string;
  payload: unknown;
  result: unknown | null;
  error: JobError | null;
  worker_id: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  lease_expires_at: Date | null;
  lease_generation: string | number;
  attempt_count: string | number;
  max_attempts: string | number;
  next_attempt_at: Date | null;
  cancellation_requested_at: Date | null;
}

/** Maps a raw DB row to the domain `Job` type. */
function mapRow(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type as JobType,
    status: row.status as JobStatus,
    payload: row.payload,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseGeneration: Number(row.lease_generation),
    fencingToken: Number(row.lease_generation),
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at,
    cancellationRequestedAt: row.cancellation_requested_at,
  };
}

export type RetryTransitionResult =
  | { status: "retry_scheduled" }
  | { status: "exhausted" }
  | { status: "ownership_lost" };

export class JobRepository {
  /** The PostgreSQL pool backing this repository (injected for tests). */
  private readonly _pool: Pool;

  constructor(private readonly pool: Pool) {
    this._pool = pool;
  }

  /** The PostgreSQL pool backing this repository (injected for tests). */
  get poolConnection(): Pool {
    return this._pool;
  }

  /** Persists a new job with status `queued`. Returns the stored job. */
  async createJob(input: CreateJobInput): Promise<Job> {
    try {
      const maxAttempts = input.maxAttempts ?? 3;
      const res: QueryResult<JobRow> = await this.pool.query<JobRow>(
        `INSERT INTO jobs (id, type, status, payload, result, error, attempt_count, max_attempts, next_attempt_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, 0, $5, NULL)
         RETURNING *`,
        [input.id, input.type, JobStatus.Queued, input.payload, maxAttempts],
      );
      const row = res.rows[0];
      if (row === undefined) {
        // Should be unreachable for a RETURNING insert.
        throw new AppError(AppErrorCode.DbError, 500, "Job creation returned no row");
      }
      return mapRow(row);
    } catch (e) {
      throw toAppError(e);
    }
  }

  /** Loads a job by id, or `null` when none exists. */
  async getJobById(id: string): Promise<Job | null> {
    try {
      const res: QueryResult<JobRow> = await this.pool.query<JobRow>(
        `SELECT * FROM jobs WHERE id = $1`,
        [id],
      );
      if (res.rows.length === 0) return null;
      return mapRow(res.rows[0]);
    } catch (e) {
      throw toAppError(e);
    }
  }

  /**
   * Atomically claims the next eligible job for a worker.
   *
   * Eligibility:
   *   - queued jobs with (next_attempt_at IS NULL OR next_attempt_at <= now())
   *     and attempt_count < max_attempts;
   *   - expired running jobs (lease_expires_at <= now()), which are either
   *     reclaimed as a new attempt or, when attempts are exhausted, marked failed.
   *
   * Claiming increments attempt_count exactly once in the same transaction as
   * ownership, lease, fencing-token, and status changes.
   */
  async claimNextJob(
    workerId: string,
    leaseDurationMs: number = 30000,
  ): Promise<Job | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Loop so that exhausted/queued-unrunnable rows can be finalized without
      // handing a non-executable job back to the caller.
      while (true) {
        const picked = await client.query<JobRow>(
          `SELECT *
           FROM jobs
           WHERE (status = 'queued'
                  AND (next_attempt_at IS NULL OR next_attempt_at <= now())
                  AND attempt_count < max_attempts)
              OR (status = 'running'
                  AND lease_expires_at IS NOT NULL
                  AND lease_expires_at <= now())
           ORDER BY created_at ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED`,
        );
        const row = picked.rows[0];
        if (row === undefined) {
          await client.query("COMMIT");
          return null;
        }

        // Expired running job.
        if (row.status === "running") {
          // A cancellation request on an expired lease must never be reclaimed
          // for execution; finalize it as cancelled instead.
          if (row.cancellation_requested_at !== null) {
            await client.query(
              `UPDATE jobs
               SET status = 'cancelled',
                   completed_at = now(),
                   updated_at = now(),
                   worker_id = NULL,
                   lease_expires_at = NULL,
                   next_attempt_at = NULL,
                   cancellation_requested_at = COALESCE(cancellation_requested_at, now())
               WHERE id = $1
                 AND status = 'running'
                 AND cancellation_requested_at IS NOT NULL`,
              [row.id],
            );
            continue;
          }
          if (Number(row.attempt_count) >= Number(row.max_attempts)) {
            // Exhausted: mark failed, clear ownership/lease, no execution.
            await client.query(
              `UPDATE jobs
               SET status = 'failed',
                   error = $2,
                   completed_at = now(),
                   updated_at = now(),
                   worker_id = NULL,
                   lease_expires_at = NULL
               WHERE id = $1`,
              [
                row.id,
                { code: "LEASE_EXPIRED", message: "Lease expired after maximum attempts" },
              ],
            );
            continue;
          }

          const updated = await client.query<JobRow>(
            `UPDATE jobs
             SET status = 'running',
                 started_at = COALESCE(started_at, now()),
                 worker_id = $1,
                 lease_expires_at = now() + ($3 * interval '1 millisecond'),
                 lease_generation = lease_generation + 1,
                 attempt_count = attempt_count + 1,
                 updated_at = now(),
                 completed_at = NULL,
                 next_attempt_at = NULL
             WHERE id = $2
               AND status = 'running'
               AND lease_expires_at IS NOT NULL
               AND lease_expires_at <= now()
             RETURNING *`,
            [workerId, row.id, leaseDurationMs],
          );
          const updatedRow = updated.rows[0];
          if (updatedRow === undefined) {
            continue;
          }
          await client.query("COMMIT");
          return mapRow(updatedRow);
        }

        // Queued job.
        const updated = await client.query<JobRow>(
          `UPDATE jobs
           SET status = 'running',
               started_at = COALESCE(started_at, now()),
               worker_id = $1,
               lease_expires_at = now() + ($3 * interval '1 millisecond'),
               lease_generation = lease_generation + 1,
               attempt_count = attempt_count + 1,
               updated_at = now(),
               completed_at = NULL,
               next_attempt_at = NULL
           WHERE id = $2
             AND status = 'queued'
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             AND attempt_count < max_attempts
             AND cancellation_requested_at IS NULL
           RETURNING *`,
          [workerId, row.id, leaseDurationMs],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow === undefined) {
          continue;
        }
        await client.query("COMMIT");
        return mapRow(updatedRow);
      }
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback errors.
      }
      throw toAppError(e);
    } finally {
      client.release();
    }
  }

  async renewLease(
    id: string,
    workerId: string,
    leaseGeneration: number,
    leaseDurationMs: number,
  ): Promise<{
    renewed: boolean;
    cancellationRequested: boolean;
    cancelled: boolean;
    ok: boolean;
    success: boolean;
  }> {
    try {
      const res = await this.pool.query<{ cancellation_requested_at: Date | null }>(
        `UPDATE jobs
         SET lease_expires_at = now() + ($4 * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1
           AND worker_id = $2
           AND lease_generation = $3
           AND status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at >= now()
         RETURNING cancellation_requested_at`,
        [id, workerId, leaseGeneration, leaseDurationMs],
      );
      if ((res.rowCount ?? 0) === 0) {
        return {
          renewed: false,
          cancellationRequested: false,
          cancelled: false,
          ok: false,
          success: false,
        };
      }
      const requested = res.rows[0]?.cancellation_requested_at !== null;
      return {
        renewed: true,
        cancellationRequested: requested,
        cancelled: requested,
        ok: true,
        success: true,
      };
    } catch (e) {
      throw toAppError(e);
    }
  }

  async markSucceeded(
    id: string,
    result: unknown,
    workerId: string,
    leaseGeneration: number,
  ): Promise<number> {
    const sql = `UPDATE jobs
         SET status = 'succeeded',
             result = $1,
             error = NULL,
             completed_at = now(),
             updated_at = now(),
             worker_id = NULL,
             lease_expires_at = NULL
         WHERE id = $2
           AND status = 'running'
           AND worker_id = $3
           AND lease_generation = $4
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at >= now()
            AND cancellation_requested_at IS NULL
         RETURNING id`;
    const params = [result, id, workerId, leaseGeneration];
    const res: QueryResult<{ id: string }> = await this.pool.query<{ id: string }>(sql, params);
    return res.rowCount ?? 0;
  }

  /**
   * Marks a claimed job as failed, persisting structured error information.
   *
   * The conditional `WHERE id = $1 AND status = 'running'` enforces the same
   * invariants as `markSucceeded`. Structured `error` is stored JSONB so it can
   * be returned safely to clients without raw stack traces or secrets.
   */
  async markFailed(
    id: string,
    error: JobError,
    workerId: string,
    leaseGeneration: number,
  ): Promise<number> {
    const sql = `UPDATE jobs
         SET status = 'failed',
             error = $1,
             result = NULL,
             completed_at = now(),
             updated_at = now(),
             worker_id = NULL,
             lease_expires_at = NULL
         WHERE id = $2
           AND status = 'running'
           AND worker_id = $3
           AND lease_generation = $4
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at >= now()
           AND cancellation_requested_at IS NULL
         RETURNING id`;
    const params = [error, id, workerId, leaseGeneration];
    const res: QueryResult<{ id: string }> = await this.pool.query<{ id: string }>(sql, params);
    return res.rowCount ?? 0;
  }

  /**
   * Canonical retry transition.
   *
   * Returns:
   * - `retry_scheduled`: ownership was valid and another attempt was available;
   *   the job is queued for a later attempt.
   * - `exhausted`: ownership was valid but no attempts remained; the job is
   *   terminally failed.
   * - `ownership_lost`: job ID, worker, generation, running status, or lease
   *   validity did not match, so no transition occurred.
   */
  /**
   * Requests cancellation of a queued job, transitioning it directly to the
   * terminal `cancelled` state. Attempt count is left untouched.
   */
  async cancelQueuedJob(id: string): Promise<number> {
    const sql = `UPDATE jobs
         SET status = 'cancelled',
             completed_at = now(),
             updated_at = now(),
             worker_id = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             cancellation_requested_at = COALESCE(cancellation_requested_at, now())
         WHERE id = $1
           AND status = 'queued'
         RETURNING id`;
    const res: QueryResult<{ id: string }> = await this.pool.query<{ id: string }>(sql, [id]);
    return res.rowCount ?? 0;
  }

  /**
   * Records a durable cancellation request on a running job without altering
   * ownership, lease, or attempt tracking.
   */
  async requestCancellation(id: string): Promise<number> {
    const sql = `UPDATE jobs
         SET cancellation_requested_at = COALESCE(cancellation_requested_at, now()),
             updated_at = now()
         WHERE id = $1
           AND status = 'running'
         RETURNING id`;
    const res: QueryResult<{ id: string }> = await this.pool.query<{ id: string }>(sql, [id]);
    return res.rowCount ?? 0;
  }

  /**
   * Fenced terminal cancellation transition performed by the owning worker.
   */
  async markCancelled(
    id: string,
    workerId: string,
    leaseGeneration: number,
  ): Promise<number> {
    const sql = `UPDATE jobs
         SET status = 'cancelled',
             completed_at = now(),
             updated_at = now(),
             worker_id = NULL,
             lease_expires_at = NULL,
             next_attempt_at = NULL,
             cancellation_requested_at = COALESCE(cancellation_requested_at, now())
         WHERE id = $1
           AND status = 'running'
           AND worker_id = $2
           AND lease_generation = $3
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at >= now()
           AND cancellation_requested_at IS NOT NULL
         RETURNING id`;
    const params = [id, workerId, leaseGeneration];
    const res: QueryResult<{ id: string }> = await this.pool.query<{ id: string }>(sql, params);
    return res.rowCount ?? 0;
  }


  async scheduleRetry(
    id: string,
    workerId: string,
    leaseGeneration: number,
    error: JobError,
    nextAttemptAt: Date,
  ): Promise<RetryTransitionResult> {
    if (
      typeof id !== "string" ||
      typeof workerId !== "string" ||
      !Number.isInteger(leaseGeneration) ||
      !isJobError(error) ||
      !(nextAttemptAt instanceof Date) ||
      Number.isNaN(nextAttemptAt.getTime())
    ) {
      throw new AppError(AppErrorCode.ValidationError, 400, "Invalid retry transition arguments");
    }

    const res = await this.pool.query<{ status: string }>(
      `UPDATE jobs
       SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
           next_attempt_at = CASE WHEN attempt_count < max_attempts THEN $5::timestamptz ELSE NULL END,
           error = $4,
           result = NULL,
           completed_at = CASE WHEN attempt_count < max_attempts THEN NULL ELSE now() END,
           started_at = CASE WHEN attempt_count < max_attempts THEN NULL ELSE started_at END,
           worker_id = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1
         AND status = 'running'
         AND worker_id = $2
         AND lease_generation = $3
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at >= now()
         AND cancellation_requested_at IS NULL
       RETURNING status`,
      [id, workerId, leaseGeneration, error, nextAttemptAt],
    );

    if ((res.rowCount ?? 0) === 0) {
      return { status: "ownership_lost" };
    }
    return res.rows[0].status === "queued"
      ? { status: "retry_scheduled" }
      : { status: "exhausted" };
  }
}

function isJobError(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { code?: unknown }).code === "string" &&
    typeof (v as { message?: unknown }).message === "string"
  );
}
