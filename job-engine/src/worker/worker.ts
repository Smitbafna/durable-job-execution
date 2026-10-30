/**
 * Job Engine — worker process.
 *
 * A worker claims jobs from PostgreSQL, dispatches each to a registered handler,
 * and persists the outcome. Claiming is atomic (see `JobRepository.claimNextJob`
 * using `FOR UPDATE SKIP LOCKED`); this module only orchestrates the loop.
 *
 * Concurrency model: every "slot" below is its own async loop that runs on its
 * own database connection. Two different slots of the same worker, and two
 * different worker processes, therefore issue *separate* `claimNextJob`
 * transactions that compete via PostgreSQL row locking — never an in-process
 * mutex and never a shared JS queue.
 */

import { Pool } from "pg";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobRepository } from "../db/repository.js";
import type { Job } from "../domain/job.js";
import { lookupHandler } from "./handlers/registry.js";
import { AppError, AppErrorCode } from "../errors.js";
import type { WorkerConfig } from "../config.js";
import type { ArtifactService } from "../service/artifactService.js";
import { RuntimeRegistry, PlaceholderRuntime } from "../runtime/executionRuntime.js";
import { validateExecutionSpec } from "../domain/executionSpec.js";
import type { ExecutionLimits } from "../domain/executionSpec.js";
import { DEFAULT_EXECUTION_LIMITS } from "../domain/executionSpec.js";

export interface WorkerLogger {
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown, error?: unknown): void;
}

export class Worker {
  private readonly loops: Promise<void>[] = [];
  private stopping = false;
  private runtimeRegistry?: RuntimeRegistry;
  private artifactService?: ArtifactService;
  private executionLimits: ExecutionLimits = DEFAULT_EXECUTION_LIMITS;

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: WorkerLogger,
    private readonly repo: JobRepository,
    private readonly pool?: Pool,
    runtimeRegistryOrOptions?: RuntimeRegistry | {
      runtimeRegistry?: RuntimeRegistry;
      artifactService?: ArtifactService;
      executionLimits?: ExecutionLimits;
    },
    artifactService?: ArtifactService,
    executionLimits?: ExecutionLimits,
  ) {
    if (runtimeRegistryOrOptions instanceof RuntimeRegistry) {
      this.runtimeRegistry = runtimeRegistryOrOptions;
      this.artifactService = artifactService;
      this.executionLimits = executionLimits ?? DEFAULT_EXECUTION_LIMITS;
    } else if (runtimeRegistryOrOptions) {
      this.runtimeRegistry = runtimeRegistryOrOptions.runtimeRegistry;
      this.artifactService =
        runtimeRegistryOrOptions.artifactService ?? artifactService;
      this.executionLimits =
        runtimeRegistryOrOptions.executionLimits ?? executionLimits ?? DEFAULT_EXECUTION_LIMITS;
    }
  }


  /**
   * Starts all worker slots. Each slot is an independent polling loop. This
   * returns immediately; callers must await the `stopped` promise to wait for
   * graceful shutdown.
   */
  start(): void {
    // Lazily remember whichever connection is handed in first (only one
    // connection is needed unless a test wants per-slot isolation).
  
    const concurrency = Math.max(1, Math.min(this.config.concurrency, 32));
    for (let i = 0; i < concurrency; i += 1) {
      this.loops.push(this.runLoop());
    }
  }

  /**
   * Stops accepting new jobs and waits for every in-flight job to finish.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    await Promise.allSettled(this.loops);
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const job = await this.claimNextJob();
      if (job === null) {
        await this.sleep(this.config.pollIntervalMs);
        continue;
      }

      // Keep executing on the same slot — do not spawn child loops.
      try {
        await this.executeJob(job);
      } catch (err) {
        this.logger.error(
          `Unexpected error during job id ${job.id}; marking failed.`,
          { jobId: job.id, type: job.type },
          err,
        );
        await this.repo
          .markFailed(job.id, {
            code: AppErrorCode.Internal,
            message: "Internal worker error",
          })
          .catch(() => undefined);
      }
    }
  }

  private async claimNextJob(): Promise<Job | null> {
    // A fresh repository backed by the injected pool (or the repo's shared
    // pool) keeps each loop on its own database connection.
    // The repo owns its own connection. When a pool is injected, wrap the
    // repo in a new repository that uses that pool so each loop has a
    // dedicated connection.
    const repo = new JobRepository(this.pool ?? this.repo.poolConnection);
    return repo
      .claimNextJob(this.config.workerId)
      .catch((err) => {
        this.logger.error(
          `claimNextJob failed; will retry on the next poll.`,
          { error: (err as Error).message },
        );
        return null;
      });
  }

  private async executeJob(job: Job): Promise<void> {
    if (job.type === "execute_artifact") {
      await this.executeArtifactJob(job);
      return;
    }
    const handler = lookupHandler(job.type);

    if (!handler) {
      this.logger.warn(
        `No handler registered for job type "${job.type}" (id ${job.id}); marking failed.`,
        { jobId: job.id, type: job.type },
      );
      const affected = await this.repo.markFailed(
        job.id,
        {
          code: AppErrorCode.UnsupportedJobType,
          message: `No handler registered for job type "${job.type}".`,
        },
      );
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    try {
      const result = await handler(job.payload);
      const affected = await this.repo.markSucceeded(job.id, result);
      this.maybeLogConsistencyError("markSucceeded", job.id, affected);
    } catch (err) {
      const appError = err instanceof AppError ? err : this.sanitizeError(err);

      this.logger.error(
        `Job id ${job.id} (${job.type}) failed; persisting error.`,
        {
          jobId: job.id,
          type: job.type,
          code: appError.code,
          error: appError.message,
        },
      );

      const affected = await this.repo.markFailed(job.id, {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      });
      this.maybeLogConsistencyError("markFailed", job.id, affected);
    }
  }

  /**
   * A conditional UPDATE affecting 0 rows means the job was no longer
   * `running` — it was already completed, terminal, or picked up by another
   * worker. This is a consistency/log event, not a fatal error.
   */
  private async executeArtifactJob(job: Job): Promise<void> {
    const specResult = validateExecutionSpec(job.payload, this.executionLimits);
    if (specResult instanceof AppError) {
      const affected = await this.repo.markFailed(job.id, {
        code: specResult.code,
        message: specResult.message,
      });
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    const spec = specResult;
    const runtime = this.runtimeRegistry?.resolve(spec.runtime);
    if (!runtime) {
      const affected = await this.repo.markFailed(job.id, {
        code: AppErrorCode.UnsupportedJobType,
        message: `Unsupported runtime: ${spec.runtime}`,
      });
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    if (!this.artifactService) {
      const affected = await this.repo.markFailed(job.id, {
        code: AppErrorCode.Internal,
        message: "Artifact service unavailable",
      });
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    const artifact = await this.artifactService.getArtifact(spec.artifactId);
    if (artifact === null) {
      const affected = await this.repo.markFailed(job.id, {
        code: AppErrorCode.NotFound,
        message: `Artifact not found: ${spec.artifactId}`,
      });
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    let tempDir: string | undefined;
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-engine-artifact-"));
      const artifactPath = path.join(tempDir, "artifact.zip");
      await this.artifactService.materializeArtifact(spec.artifactId, artifactPath);
      const result = await runtime.execute(spec, artifactPath);
      const affected = await this.repo.markSucceeded(job.id, result);
      this.maybeLogConsistencyError("markSucceeded", job.id, affected);
    } catch (err) {
      const appError = err instanceof AppError ? err : this.sanitizeError(err);
      this.logger.error(
        `Job id ${job.id} (execute_artifact) failed; persisting error.`,
        { jobId: job.id, type: job.type, code: appError.code },
        err,
      );
      const affected = await this.repo.markFailed(job.id, {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      });
      this.maybeLogConsistencyError("markFailed", job.id, affected);
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private maybeLogConsistencyError(
    op: string,
    jobId: string,
    affected: number,
  ): void {
    if (affected === 0) {
      this.logger.error(
        `Outcome persistence for job id ${jobId} affected 0 rows; job is not ` +
          `in running state. (op=${op})`,
        { jobId, op },
      );
    }
  }

  /**
   * Strips anything non-public from an unexpected error before it is persisted.
   * Stack traces, SQL, credentials, and internal details never leave the
   * process; only a sanitized message is stored.
   */
  private sanitizeError(err: unknown): AppError {
    const message =
      err instanceof Error
        ? err.message
        : (typeof err === "string" ? err : "unknown error");

    this.logger.error(`Unexpected error during job execution`, {
      error: message,
      stack: err instanceof Error ? err.stack : undefined,
    });

    return AppError.dbError("Job execution failed");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, ms);
    });
  }
}
