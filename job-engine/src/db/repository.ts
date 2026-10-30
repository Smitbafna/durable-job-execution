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
      const res: QueryResult<JobRow> = await this.pool.query<JobRow>(
        `INSERT INTO jobs (id, type, status, payload, result, error)
         VALUES ($1, $2, $3, $4, NULL, NULL)
         RETURNING *`,
        [input.id, input.type, JobStatus.Queued, input.payload],
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
   * Atomically claims the next eligible queued job for a worker.
   *
   * Atomicity is guaranteed by wrapping the SELECT ... FOR UPDATE SKIP LOCKED
   * and the succeeding UPDATE in one transaction. No other worker (or
   * transaction) can change or lock that row until this transaction commits, so
   * a claim and its status flip to `running` happen as one unit. The
   * transaction commits before the job body executes, so it is never held open
   * while the job runs.
   *
   * Selection rule:
   *   - only `queued` jobs are eligible,
   *   - ordered by creation time (oldest first),
   *   - rows locked by other in-flight transactions are skipped (`SKIP LOCKED`),
   *   - the chosen row is locked by this transaction (`FOR UPDATE`),
   *   - the row is flipped to `running` within the same transaction, with
   *     `started_at`, `worker_id`, and `updated_at` populated.
   *
   * Returns the claimed job (status `running`) or `null` when no queued job is
   * available.
   */
  async claimNextJob(workerId: string): Promise<Job | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const picked = await client.query<{ id: string }>(
        `SELECT id
         FROM jobs
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const row = picked.rows[0];
      if (row === undefined) {
        await client.query("COMMIT");
        return null;
      }

      const updated = await client.query<JobRow>(
        `UPDATE jobs
         SET status = 'running',
             started_at = now(),
             worker_id = $1,
             updated_at = now()
         WHERE id = $2 AND status = 'queued'
         RETURNING *`,
        [workerId, row.id],
      );

      await client.query("COMMIT");

      const updatedRow = updated.rows[0];
      if (updatedRow === undefined) {
        // Should never happen: we hold the lock on a row we just verified was
        // `queued`, so the conditional UPDATE must match. Fail loudly instead
        // of returning a corrupted job.
        throw new AppError(
          AppErrorCode.DbError,
          503,
          `Claim failed: row ${row.id} changed under our lock`,
        );
      }

      return mapRow(updatedRow);
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

  /**
   * Marks a claimed job as succeeded.
   *
   * The conditional `WHERE id = $1 AND status = 'running'` enforces every
   * invariant below: it can only be applied to a job that is currently
   * `running`, so it can never be applied twice or overwrite a terminal job.
   *
   * Returns the number of rows affected so callers can detect a consistency
   * violation (0 rows => the job was not `running`).
   */
  async markSucceeded(id: string, result: unknown): Promise<number> {
    const res: QueryResult<{ id: string }> = await this.pool.query<{
      id: string;
    }>(
      `UPDATE jobs
       SET status = 'succeeded',
           result = $1,
           completed_at = now(),
           updated_at = now()
       WHERE id = $2 AND status = 'running'
       RETURNING id`,
      [result, id],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Marks a claimed job as failed, persisting structured error information.
   *
   * The conditional `WHERE id = $1 AND status = 'running'` enforces the same
   * invariants as `markSucceeded`. Structured `error` is stored JSONB so it can
   * be returned safely to clients without raw stack traces or secrets.
   */
  async markFailed(id: string, error: JobError): Promise<number> {
    const res: QueryResult<{ id: string }> = await this.pool.query<{
      id: string;
    }>(
      `UPDATE jobs
       SET status = 'failed',
           error = $1,
           completed_at = now(),
           updated_at = now()
       WHERE id = $2 AND status = 'running'
       RETURNING id`,
      [error, id],
    );
    return res.rowCount ?? 0;
  }
}
