import { randomUUID } from "node:crypto";
import { AppError, AppErrorCode } from "../errors.js";
import { describeJobType } from "../domain/jobTypes.js";
import type { JobType, ValidatedPayload } from "../domain/jobTypes.js";
import { JobStatus, type Job } from "../domain/job.js";
import { JobRepository, type CreateJobInput } from "../db/repository.js";
import { ArtifactRepository } from "../db/artifactRepository.js";
import { validateExecutionSpec } from "../domain/executionSpec.js";
import type { ExecutionLimits } from "../domain/executionSpec.js";
import { DEFAULT_EXECUTION_LIMITS } from "../domain/executionSpec.js";

export interface SubmitJobCommand {
  readonly type: string;
  readonly payload: unknown;
  readonly maxAttempts?: number;
}

export class JobService {
  constructor(
    private readonly repo: JobRepository,
    private readonly artifactRepo?: ArtifactRepository,
    private readonly executionLimits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS,
  ) {}

  async submitJob(cmd: SubmitJobCommand): Promise<Job> {
    const def = describeJobType(cmd.type);
    let validated: ValidatedPayload | AppError;
    if (cmd.type === "execute_artifact") {
      validated = validateExecutionSpec(cmd.payload, this.executionLimits);
    } else {
      validated = def.validatePayload(cmd.payload);
    }
    if (validated instanceof AppError) {
      throw validated;
    }
    const payload: ValidatedPayload = validated;

    if (cmd.type === "execute_artifact") {
      if (!this.artifactRepo) {
        throw new AppError(
          AppErrorCode.Internal,
          503,
          "Artifact repository unavailable",
        );
      }
      const spec = validated as { artifactId: string };
      const artifact = await this.artifactRepo.getArtifactById(spec.artifactId);
      if (artifact === null) {
        throw new AppError(
          AppErrorCode.ValidationError,
          400,
          `Unknown artifact: ${spec.artifactId}`,
        );
      }
    }

    if (cmd.maxAttempts !== undefined) {
      if (
        typeof cmd.maxAttempts !== "number" ||
        !Number.isInteger(cmd.maxAttempts) ||
        cmd.maxAttempts < 1 ||
        cmd.maxAttempts > 100
      ) {
        throw new AppError(
          AppErrorCode.ValidationError,
          400,
          "maxAttempts must be a positive integer <= 100",
        );
      }
    }

    const id = randomUUID();
    const input: CreateJobInput = {
      id,
      type: cmd.type as JobType,
      payload,
      maxAttempts: cmd.maxAttempts,
    };
    return this.repo.createJob(input);
  }

  async getJob(id: string): Promise<Job | null> {
    return this.repo.getJobById(id);
  }

  static readonly INITIAL_STATUS: JobStatus = JobStatus.Queued;
}
