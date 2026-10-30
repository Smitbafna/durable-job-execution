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
  constructor(private readonly pool: Pool) {}

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

}
