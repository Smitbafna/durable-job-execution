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
import { JobRepository } from "../db/repository.js";
import type { Job } from "../domain/job.js";
import { lookupHandler } from "./handlers/registry.js";
import { AppError, AppErrorCode } from "../errors.js";
import type { WorkerConfig } from "../config.js";

export interface WorkerLogger {
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown, error?: unknown): void;
}

export class Worker {
  private readonly loops: Promise<void>[] = [];
  private stopping = false;
  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: WorkerLogger,
    private readonly repo: JobRepository,
    private readonly pool?: Pool,
  ) {
    // The pool parameter is injected for tests so each worker slot owns its
    // own database connection; in production the singleton pool is used.
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
