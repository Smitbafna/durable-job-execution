/**
 * Job Engine — application service (use cases).
 *
 * Orchestrates validation and persistence without performing any job execution.
 * The only thing a submitted job ever is, in Week 1, a persisted `queued` record.
 */

import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import { describeJobType } from "../domain/jobTypes.js";
import type { JobType, ValidatedPayload } from "../domain/jobTypes.js";
import { JobStatus, type Job } from "../domain/job.js";
import { JobRepository, type CreateJobInput } from "../db/repository.js";

export interface SubmitJobCommand {
  readonly type: string; // untrusted; validated here
  readonly payload: unknown;
}

export class JobService {
  constructor(private readonly repo: JobRepository) {}

  /**
   * Validates the request (supported type + per-type payload) and persists a
   * new `queued` job. The generated id is a v4 UUID. The job is durable after
   * this returns — **no execution happens here** (Week 2 adds the worker).
   */
  async submitJob(cmd: SubmitJobCommand): Promise<Job> {
    const def = describeJobType(cmd.type); // throws UnsupportedJobType (400)
    const validated = def.validatePayload(cmd.payload);
    if (validated instanceof AppError) {
      throw validated; // 400 ValidationError
    }
    const payload: ValidatedPayload = validated;

    const id = randomUUID();
    const input: CreateJobInput = { id, type: cmd.type as JobType, payload };
    return this.repo.createJob(input);
  }

  /** Retrieves a job by id. Missing ids resolve to `null` (route maps to 404). */
  async getJob(id: string): Promise<Job | null> {
    return this.repo.getJobById(id);
  }

  /** The only status a freshly created job ever has in Week 1. */
  static readonly INITIAL_STATUS: JobStatus = JobStatus.Queued;
}
