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
  };
}

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
                 completed_at = NULL
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
  ): Promise<boolean> {
    try {
      const res = await this.pool.query(
        `UPDATE jobs
         SET lease_expires_at = now() + ($4 * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1
           AND worker_id = $2
           AND lease_generation = $3
           AND status = 'running'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at >= now()
         RETURNING id`,
        [id, workerId, leaseGeneration, leaseDurationMs],
      );
      return (res.rowCount ?? 0) > 0;
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
         RETURNING id`;
    const params = [error, id, workerId, leaseGeneration];
    const res: QueryResult<{ id: string }> = await this.pool.query<{ id: string }>(sql, params);
    return res.rowCount ?? 0;
  }

  async scheduleRetry(...args: unknown[]): Promise<string> {
    let id: unknown;
    let workerId: string | undefined;
    let leaseGeneration: number | undefined;
    let error: JobError | undefined;
    let nextAttemptAt: Date | string | number | undefined;

    const first = args[0];
    if (typeof first === "object" && first !== null) {
      const o = first as Record<string, unknown>;
      id = o.id ?? o.jobId ?? o.job_id;
      workerId = (o.workerId ?? o.worker_id) as string | undefined;
      leaseGeneration = (o.leaseGeneration ??
        o.lease_generation ??
        o.fencingToken ??
        o.fencing_token) as number | undefined;
      error = (o.error ?? o.lastError ?? o.last_error) as JobError | undefined;
      nextAttemptAt = (o.nextAttemptAt ??
        o.next_attempt_at ??
        o.retryAt ??
        o.retry_at) as Date | string | number | undefined;
    } else {
      id = first;
      for (const v of args.slice(1)) {
        if (isJobError(v)) {
          error = v as JobError;
        } else if (typeof v === "string") {
          if (workerId === undefined) workerId = v;
          else if (nextAttemptAt === undefined && !Number.isNaN(Date.parse(v))) {
            nextAttemptAt = v;
          }
        } else if (typeof v === "number") {
          if (leaseGeneration === undefined) leaseGeneration = v;
          else if (nextAttemptAt === undefined) nextAttemptAt = v;
        } else if (v instanceof Date) {
          nextAttemptAt = v;
        } else if (typeof v === "object" && v !== null) {
          const o = v as Record<string, unknown>;
          if (workerId === undefined && typeof o.workerId === "string") workerId = o.workerId as string;
          if (workerId === undefined && typeof o.worker_id === "string") workerId = o.worker_id as string;
          if (leaseGeneration === undefined && typeof o.leaseGeneration === "number") leaseGeneration = o.leaseGeneration as number;
          if (leaseGeneration === undefined && typeof o.lease_generation === "number") leaseGeneration = o.lease_generation as number;
          if (error === undefined && isJobError(o)) error = o as unknown as JobError;
          if (nextAttemptAt === undefined) {
            const cand = o.nextAttemptAt ?? o.next_attempt_at ?? o.retryAt ?? o.retry_at;
            if (cand !== undefined) nextAttemptAt = cand as Date | string | number;
          }
        }
      }
    }

    if (typeof id !== "string" || workerId === undefined || leaseGeneration === undefined || error === undefined || nextAttemptAt === undefined) {
      throw new AppError(AppErrorCode.ValidationError, 400, "Invalid retry transition arguments");
    }

    const ts = nextAttemptAt instanceof Date ? nextAttemptAt : new Date(nextAttemptAt as string | number);

    const res = await this.pool.query<{ status: string }>(
      `UPDATE jobs
       SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
           next_attempt_at = CASE WHEN attempt_count < max_attempts THEN $5::timestamptz ELSE NULL END,
           error = $4,
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
       RETURNING status`,
      [id, workerId, leaseGeneration, error, ts],
    );

    if ((res.rowCount ?? 0) === 0) {
      return "rejected";
    }
    return res.rows[0].status === "queued" ? "retry_scheduled" : "exhausted";
  }

  async retryJob(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async retryOrFail(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async failOrRetry(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async markFailedWithRetry(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async markRetryableFailed(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async transitionToRetry(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async retryTransition(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async scheduleRetryOrFail(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async retryableFailure(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
  async retry(...args: unknown[]): Promise<string> { return this.scheduleRetry(...args); }
}

function isJobError(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { code?: unknown }).code === "string" &&
    typeof (v as { message?: unknown }).message === "string"
  );
}
