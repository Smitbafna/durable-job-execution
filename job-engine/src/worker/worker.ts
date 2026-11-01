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
import { performance } from "node:perf_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JobRepository } from "../db/repository.js";
import type { Job } from "../domain/job.js";
import { lookupHandler } from "./handlers/registry.js";
import { AppError, AppErrorCode } from "../errors.js";
import type { WorkerConfig, LeaseConfig } from "../config.js";
import type { ArtifactService } from "../service/artifactService.js";
import { RuntimeRegistry, PlaceholderRuntime } from "../runtime/executionRuntime.js";
import { validateExecutionSpec } from "../domain/executionSpec.js";
import { classifyFailure } from "../domain/failureClassification.js";
import { decideRetry, DEFAULT_RETRY_POLICY_CONFIG } from "../domain/retryPolicy.js";
import type { RetryPolicyConfig } from "../domain/retryPolicy.js";
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
  private leaseConfig: LeaseConfig = { leaseDurationMs: 30000, heartbeatIntervalMs: 10000 };
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly heartbeatStates = new Map<string, any>();
  private readonly ownershipLost = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly cancelledJobs = new Set<string>();
  private retryPolicyConfig: RetryPolicyConfig = DEFAULT_RETRY_POLICY_CONFIG;

  constructor(
    private readonly config: WorkerConfig,
    private readonly logger: WorkerLogger,
    private readonly repo: JobRepository,
    private readonly pool?: Pool,
    runtimeRegistryOrOptions?: RuntimeRegistry | {
      runtimeRegistry?: RuntimeRegistry;
      artifactService?: ArtifactService;
      executionLimits?: ExecutionLimits;
      leaseConfig?: LeaseConfig;
    },
    artifactService?: ArtifactService,
    executionLimits?: ExecutionLimits,
    leaseConfig?: LeaseConfig,
    retryPolicyConfig?: RetryPolicyConfig,
  ) {
    if (runtimeRegistryOrOptions instanceof RuntimeRegistry) {
      this.runtimeRegistry = runtimeRegistryOrOptions;
      this.artifactService = artifactService;
      this.executionLimits = executionLimits ?? DEFAULT_EXECUTION_LIMITS;
      this.leaseConfig = leaseConfig ?? this.leaseConfig;
    } else if (runtimeRegistryOrOptions) {
      this.runtimeRegistry = runtimeRegistryOrOptions.runtimeRegistry;
      this.artifactService =
        runtimeRegistryOrOptions.artifactService ?? artifactService;
      this.executionLimits =
        runtimeRegistryOrOptions.executionLimits ?? executionLimits ?? DEFAULT_EXECUTION_LIMITS;
      this.leaseConfig =
        runtimeRegistryOrOptions.leaseConfig ?? leaseConfig ?? this.leaseConfig;
    } else if (leaseConfig) {
      this.leaseConfig = leaseConfig;
    }
    this.retryPolicyConfig = retryPolicyConfig ?? DEFAULT_RETRY_POLICY_CONFIG;
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
    await this.runtimeRegistry?.shutdown?.();
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      const claimStartedAt = performance.now();
      const job = await this.claimNextJob();
      if (job === null) {
        await this.sleep(this.config.pollIntervalMs);
        continue;
      }

      // Keep executing on the same slot — do not spawn child loops.
      try {
        await this.executeJob(job, claimStartedAt);
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
          }, this.config.workerId, job.leaseGeneration)
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
      .claimNextJob(this.config.workerId, this.leaseConfig.leaseDurationMs)
      .catch((err) => {
        this.logger.error(
          `claimNextJob failed; will retry on the next poll.`,
          { error: (err as Error).message },
        );
        return null;
      });
  }

  private async executeJob(job: Job, claimStartedAt: number = performance.now()): Promise<void> {
    const abortController = new AbortController();
    this.startHeartbeat(job, abortController, claimStartedAt);
    try {
      await this.executeJobImpl(job, abortController);
    } finally {
      this.stopHeartbeat(job.id);
      this.abortControllers.delete(job.id);
    }
  }

  private async executeJobImpl(job: Job, abortController: AbortController): Promise<void> {
    if (job.type === "execute_artifact") {
      await this.executeArtifactJob(job, abortController);
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
        }, this.config.workerId, job.leaseGeneration);
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    try {
      const result = await handler(job.payload);
      if (this.cancelledJobs.has(job.id)) {
        const affected = await this.repo.markCancelled(
          job.id,
          this.config.workerId,
          job.leaseGeneration,
        );
        this.maybeLogConsistencyError("markCancelled", job.id, affected);
        return;
      }
      if (this.ownershipLost.has(job.id)) return;
      const affected = await this.repo.markSucceeded(
        job.id,
        result,
        this.config.workerId,
        job.leaseGeneration,
      );
      this.maybeLogConsistencyError("markSucceeded", job.id, affected);
    } catch (err) {
      if (this.cancelledJobs.has(job.id)) {
        const affected = await this.repo.markCancelled(
          job.id,
          this.config.workerId,
          job.leaseGeneration,
        );
        this.maybeLogConsistencyError("markCancelled", job.id, affected);
        return;
      }
      if (this.ownershipLost.has(job.id)) return;
      await this.persistFailure(job, err);
    }
  }

  /**
   * A conditional UPDATE affecting 0 rows means the job was no longer
   * `running` — it was already completed, terminal, or picked up by another
   * worker. This is a consistency/log event, not a fatal error.
   */
  private async executeArtifactJob(job: Job, abortController: AbortController): Promise<void> {

    const specResult = validateExecutionSpec(job.payload, this.executionLimits);
    if (specResult instanceof AppError) {
      const affected = await this.repo.markFailed(job.id, {
        code: specResult.code,
        message: specResult.message,
      }, this.config.workerId, job.leaseGeneration);
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    const spec = specResult;
    const runtime = this.runtimeRegistry?.resolve(spec.runtime);
    if (!runtime) {
      const affected = await this.repo.markFailed(job.id, {
        code: AppErrorCode.UnsupportedJobType,
        message: `Unsupported runtime: ${spec.runtime}`,
      }, this.config.workerId, job.leaseGeneration);
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    if (!this.artifactService) {
      const affected = await this.repo.markFailed(job.id, {
        code: AppErrorCode.Internal,
        message: "Artifact service unavailable",
      }, this.config.workerId, job.leaseGeneration);
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    const artifact = await this.artifactService.getArtifact(spec.artifactId);
    if (artifact === null) {
      const affected = await this.repo.markFailed(job.id, {
        code: AppErrorCode.NotFound,
        message: `Artifact not found: ${spec.artifactId}`,
      }, this.config.workerId, job.leaseGeneration);
      this.maybeLogConsistencyError("markFailed", job.id, affected);
      return;
    }

    let tempDir: string | undefined;
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "job-engine-artifact-"));
      const artifactPath = path.join(tempDir, "artifact.zip");
      await this.artifactService.materializeArtifact(spec.artifactId, artifactPath);
      if (this.cancelledJobs.has(job.id)) {
        const affected = await this.repo.markCancelled(
          job.id,
          this.config.workerId,
          job.leaseGeneration,
        );
        this.maybeLogConsistencyError("markCancelled", job.id, affected);
        return;
      }
      const result = await runtime.execute(spec, artifactPath, {
        signal: abortController.signal,
      });
      if (this.cancelledJobs.has(job.id)) {
        const affected = await this.repo.markCancelled(
          job.id,
          this.config.workerId,
          job.leaseGeneration,
        );
        this.maybeLogConsistencyError("markCancelled", job.id, affected);
        return;
      }
      if (this.ownershipLost.has(job.id)) return;
      const affected = await this.repo.markSucceeded(
        job.id,
        result,
        this.config.workerId,
        job.leaseGeneration,
      );
      this.maybeLogConsistencyError("markSucceeded", job.id, affected);
    } catch (err) {
      if (this.cancelledJobs.has(job.id)) {
        const affected = await this.repo.markCancelled(
          job.id,
          this.config.workerId,
          job.leaseGeneration,
        );
        this.maybeLogConsistencyError("markCancelled", job.id, affected);
        return;
      }
      if (this.ownershipLost.has(job.id)) return;
      await this.persistFailure(job, err);
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private startHeartbeat(job: Job, abortController: AbortController, claimStartedAt: number = performance.now()): void {
    if (this.heartbeats.has(job.id)) return;
    this.abortControllers.set(job.id, abortController);
    const state = {
      timer: undefined as NodeJS.Timeout | undefined,
      inFlight: false,
      stopped: false,
      consecutiveFailures: 0,
      lastRenewalStartedAt: claimStartedAt,
      maxRetries: Math.max(1, Math.floor(this.leaseConfig.leaseDurationMs / this.leaseConfig.heartbeatIntervalMs)),
    };
    const safetyMarginMs = Math.min(5000, this.leaseConfig.heartbeatIntervalMs);
    const safetyWindowMs = this.leaseConfig.leaseDurationMs - safetyMarginMs;

    const schedule = (delayMs: number) => {
      if (state.stopped) return;
      if (state.timer) return;
      const remainingMs = safetyWindowMs - (performance.now() - state.lastRenewalStartedAt);
      if (remainingMs <= 0) {
        this.failHeartbeat(job, state, "lease safety deadline reached");
        return;
      }
      const actualDelay = Math.min(Math.max(1, delayMs), remainingMs);
      state.timer = setTimeout(() => {
        state.timer = undefined;
        void this.runHeartbeat(job, state, abortController, safetyWindowMs);
      }, actualDelay);
      this.heartbeats.set(job.id, state.timer);
    };

    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.runHeartbeat(job, state, abortController, safetyWindowMs);
    }, this.leaseConfig.heartbeatIntervalMs);
    this.heartbeats.set(job.id, state.timer);
    // Store state on a map by using a parallel map.
    this.heartbeatStates.set(job.id, state);
  }

  private async runHeartbeat(
    job: Job,
    state: {
      timer: NodeJS.Timeout | undefined;
      inFlight: boolean;
      stopped: boolean;
      consecutiveFailures: number;
      lastRenewalStartedAt: number;
      maxRetries: number;
    },
    abortController: AbortController,
    safetyWindowMs: number,
  ): Promise<void> {
    if (state.stopped || state.inFlight) return;
    state.inFlight = true;
    const renewalStartedAt = performance.now();
    try {
      if (performance.now() - state.lastRenewalStartedAt >= safetyWindowMs) {
        this.failHeartbeat(job, state, "lease safety deadline reached");
        return;
      }
      const renewal = await this.repo.renewLease(
        job.id,
        this.config.workerId,
        job.leaseGeneration,
        this.leaseConfig.leaseDurationMs,
      );
      if (state.stopped) return;
      const cancelled = this.isRenewalCancelled(renewal);
      const renewed = this.isRenewalOk(renewal);
      if (cancelled) {
        if (!state.stopped) {
          state.stopped = true;
          if (state.timer) clearTimeout(state.timer);
          state.timer = undefined;
          this.heartbeats.delete(job.id);
          this.cancelledJobs.add(job.id);
          this.abortControllers.get(job.id)?.abort();
          void this.repo
            .markCancelled(job.id, this.config.workerId, job.leaseGeneration)
            .catch(() => undefined);
        }
        return;
      }
      if (renewed) {
        state.consecutiveFailures = 0;
        state.lastRenewalStartedAt = renewalStartedAt;
        this.scheduleHeartbeat(job, state, this.leaseConfig.heartbeatIntervalMs, safetyWindowMs, abortController);
        return;
      }
      this.failHeartbeat(job, state, "lease renewal returned false");
    } catch (err) {
      if (state.stopped) return;
      state.consecutiveFailures += 1;
      this.logger.error(
        `Heartbeat failed for job ${job.id}`,
        { jobId: job.id, workerId: this.config.workerId, attempt: state.consecutiveFailures, error: (err as Error).message },
        err,
      );
      const elapsed = performance.now() - state.lastRenewalStartedAt;
      if (
        elapsed >= safetyWindowMs ||
        state.consecutiveFailures >= state.maxRetries
      ) {
        this.failHeartbeat(job, state, "heartbeat safety deadline reached");
        return;
      }
      const backoffMs = Math.min(
        this.leaseConfig.heartbeatIntervalMs,
        1000 * 2 ** (state.consecutiveFailures - 1),
      );
      const remainingMs = safetyWindowMs - elapsed;
      if (backoffMs >= remainingMs) {
        this.failHeartbeat(job, state, "heartbeat safety deadline reached");
        return;
      }
      this.scheduleHeartbeat(job, state, backoffMs, safetyWindowMs, abortController);
    } finally {
      state.inFlight = false;
    }
  }

  private scheduleHeartbeat(
    job: Job,
    state: {
      timer: NodeJS.Timeout | undefined;
      inFlight: boolean;
      stopped: boolean;
      consecutiveFailures: number;
      lastRenewalStartedAt: number;
      maxRetries: number;
    },
    delayMs: number,
    safetyWindowMs: number,
    abortController: AbortController,
  ): void {
    if (state.stopped) return;
    const remainingMs = safetyWindowMs - (performance.now() - state.lastRenewalStartedAt);
    if (remainingMs <= 0) {
      this.failHeartbeat(job, state, "lease safety deadline reached");
      return;
    }
    const delay = Math.min(Math.max(1, delayMs), remainingMs);
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void this.runHeartbeat(job, state, abortController, safetyWindowMs);
    }, delay);
    this.heartbeats.set(job.id, state.timer);
  }

  private failHeartbeat(job: Job, state: { stopped: boolean; timer?: NodeJS.Timeout }, reason: string): void {
    if (state.stopped) return;
    state.stopped = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = undefined;
    this.heartbeats.delete(job.id);
    this.ownershipLost.add(job.id);
    this.abortControllers.get(job.id)?.abort();
    this.logger.error(`Heartbeat failed for job ${job.id}: ${reason}`, { jobId: job.id });
  }

  private isRenewalCancelled(value: unknown): boolean {
    if (value && typeof value === "object") {
      const r = value as Record<string, unknown>;
      return r.cancellationRequested === true || r.cancelled === true;
    }
    return false;
  }

  private isRenewalOk(value: unknown): boolean {
    if (typeof value === "boolean") return value;
    if (value && typeof value === "object") {
      const r = value as Record<string, unknown>;
      if (typeof r.renewed === "boolean") return r.renewed;
      if (typeof r.ok === "boolean") return r.ok;
      if (typeof r.success === "boolean") return r.success;
    }
    return !!value;
  }

  private stopHeartbeat(jobId: string): void {
    const state = this.heartbeatStates.get(jobId);
    if (state) {
      state.stopped = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.heartbeats.delete(jobId);
    this.heartbeatStates.delete(jobId);
    this.abortControllers.delete(jobId);
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
  private async persistFailure(job: Job, err: unknown): Promise<void> {
    if (this.cancelledJobs.has(job.id)) {
      const affected = await this.repo.markCancelled(
        job.id,
        this.config.workerId,
        job.leaseGeneration,
      );
      this.maybeLogConsistencyError("markCancelled", job.id, affected);
      return;
    }
    if (this.ownershipLost.has(job.id)) return;
    const appError = err instanceof AppError ? err : this.sanitizeError(err);

    this.logger.error(
      `Job id ${job.id} (${job.type}) failed; persisting error.`,
      {
        jobId: job.id,
        type: job.type,
        code: appError.code,
        error: appError.message,
      },
      err,
    );

    const classification = classifyFailure(err);
    const decision = decideRetry({
      classification,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      config: this.retryPolicyConfig,
    });

    if (decision.decision === "retry") {
      const affected = await this.repo.scheduleRetry(
        job.id,
        this.config.workerId,
        job.leaseGeneration,
        {
          code: appError.code,
          message: appError.message,
          details: appError.details,
        },
        decision.nextAttemptAt,
      );
      if (affected.status === "ownership_lost") {
        // Stale worker or already terminal; do not treat as fatal.
      }
      return;
    }

    const affected = await this.repo.markFailed(
      job.id,
      {
        code: appError.code,
        message: appError.message,
        details: appError.details,
      },
      this.config.workerId,
      job.leaseGeneration,
    );
    this.maybeLogConsistencyError("markFailed", job.id, affected);
  }
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
