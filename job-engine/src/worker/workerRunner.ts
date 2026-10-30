/**
 * Job Engine — worker runner.
 *
 * CLI entry point for `npm run worker`. Loads worker configuration from the
 * environment, opens the PostgreSQL pool (the same singleton used by the HTTP
 * API), applies pending migrations, spins up a {@link Worker}, and registers
 * graceful shutdown for SIGINT/SIGTERM.
 *
 * The worker is deliberately NOT started by the HTTP server: it is a separate
 * process (`npm run worker`) that claims jobs from the same PostgreSQL
 * database.
 */

import path from "node:path";
import { getPool, closePool } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";
import { JobRepository } from "../db/repository.js";
import { ArtifactRepository } from "../db/artifactRepository.js";
import { ArtifactService } from "../service/artifactService.js";
import { LocalArtifactStorage } from "../storage/localArtifactStorage.js";
import { loadArtifactConfig, loadDockerConfig, loadExecutionConfig } from "../config.js";
import { RuntimeRegistry } from "../runtime/executionRuntime.js";
import { DockerRuntime } from "../runtime/dockerRuntime.js";
import { Worker, type WorkerLogger } from "./worker.js";
import { loadWorkerConfig } from "../config.js";

const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "migrations");

/**
 * The worker's logger. Wraps the Node console so every line carries the worker
 * identifier for observability. Satisfies the {@link WorkerLogger} contract.
 */
function logger(): WorkerLogger {
  const id = process.env.WORKER_ID ?? "unknown";
  return {
    info(message, context) {
      // eslint-disable-next-line no-console
      console.info(`[worker ${id}] ${message}`, context ?? "");
    },
    warn(message, context) {
      // eslint-disable-next-line no-console
      console.warn(`[worker ${id}] ${message}`, context ?? "");
    },
    error(message, context, error) {
      // eslint-disable-next-line no-console
      console.error(`[worker ${id}] ${message}`, context ?? "", error ?? "");
    },
  };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const pool = getPool();

  // Run pending migrations so the worker sees the latest schema (including any
  // `worker_id` column and indexes added by newer migration files).
  await runMigrations(pool, MIGRATIONS_DIR);
  logger().info("worker started", { workerId: config.workerId });

  const repository = new JobRepository(pool);
  const artifactConfig = loadArtifactConfig();
  const artifactStorage = new LocalArtifactStorage(artifactConfig.storageDir);
  const artifactRepository = new ArtifactRepository(pool);
  const artifactService = new ArtifactService(
    artifactRepository,
    artifactStorage,
    artifactConfig,
  );
  const runtimeRegistry = new RuntimeRegistry();
  runtimeRegistry.register(
    "python:3.12",
    new DockerRuntime(artifactConfig, loadDockerConfig(), loadExecutionConfig()),
  );
  const executionConfig = loadExecutionConfig();
  const worker = new Worker(
    config,
    logger(),
    repository,
    pool,
    runtimeRegistry,
    artifactService,
    {
      maxCpu: executionConfig.maxCpu,
      maxMemoryMb: executionConfig.maxMemoryMb,
      maxTimeoutSeconds: executionConfig.maxTimeoutSeconds,
      maxCommandLength: executionConfig.maxCommandLength,
      maxInputJsonBytes: executionConfig.maxInputJsonBytes,
      maxInputDepth: executionConfig.maxInputDepth,
    },
  );

  const quit = async (signal: string): Promise<void> => {
    logger().info("shutdown signal received", { signal });
    await worker.stop();
    await closePool();
    logger().info("worker stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void quit("SIGINT"));
  process.on("SIGTERM", () => void quit("SIGTERM"));

  worker.start();
  await worker.stop();
}

main().catch((err) => {
  logger().error(`worker fatal: ${(err as Error).message}`, undefined, err);
  process.exit(1);
});
