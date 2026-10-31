/**
 * Job Engine — environment configuration.
 *
 * Reads deployment-independent settings from the environment. **No credentials
 * are hardcoded in source**: the database user and password MUST be supplied via
 * environment variables (see `.env.example`). Non-secret defaults (host, port,
 * database name) exist only for local development convenience.
 */

export interface DatabaseConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: boolean;
  readonly connectionTimeoutMillis: number;
}

import { randomUUID } from "node:crypto";

export interface WorkerConfig {
  // Unique identifier for this worker process (generated per launch if unset).
  readonly workerId: string;
  // How often the worker polls PostgreSQL for the next queued job.
  readonly pollIntervalMs: number;
  // Number of jobs executed concurrently within this worker process.
  readonly concurrency: number;
}

export interface ArtifactConfig {
  readonly storageDir: string;
  readonly maxCompressedBytes: number;
  readonly maxEntries: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxIndividualUncompressedBytes: number;
}

export interface LeaseConfig {
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
}

export interface ExecutionConfig {
  readonly maxCpu: number;
  readonly maxMemoryMb: number;
  readonly maxTimeoutSeconds: number;
  readonly maxCommandLength: number;
  readonly maxInputJsonBytes: number;
  readonly maxInputDepth: number;
}

export interface DockerConfig {
  readonly pidLimit: number;
  readonly maxOutputBytes: number;
  readonly tmpfsSizeMb: number;
}

export interface ServerConfig {
  readonly port: number;
  readonly db: DatabaseConfig;
  readonly artifacts: ArtifactConfig;
  readonly execution: ExecutionConfig;
  readonly docker: DockerConfig;
  readonly lease: LeaseConfig;
}

function asPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 65535 || !Number.isInteger(n)) {
    throw new Error(`Invalid port env var: ${value}`);
  }
  return n;
}

function asInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid integer env var: ${value}`);
  }
  return n;
}

function asPositiveInt(value: string | undefined, fallback: number, name: string): number {
  const n = asInt(value, fallback);
  if (n <= 0) {
    throw new Error(`Invalid ${name}: must be a positive integer, got ${n}`);
  }
  return n;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and set it.`,
    );
  }
  return v;
}

/** Loads the database configuration strictly from the environment. */
export function loadDatabaseConfig(): DatabaseConfig {
  // Credentials are never defaulted in source — they must come from the env.
  const user = requireEnv("DB_USER");
  const password = requireEnv("DB_PASSWORD");
  return {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: asPort(process.env.DB_PORT, 15432),
    database: process.env.DB_NAME ?? "job_engine",
    user,
    password,
    ssl: (process.env.DB_SSL ?? "false").toLowerCase() === "true",
    connectionTimeoutMillis: asInt(process.env.DB_CONNECT_TIMEOUT_MS, 3000),
  };
}

export function loadWorkerConfig(): WorkerConfig {
  return {
    workerId: process.env.WORKER_ID ?? randomUUID(),
    pollIntervalMs: asInt(process.env.WORKER_POLL_INTERVAL_MS, 1000),
    concurrency: asInt(process.env.WORKER_CONCURRENCY, 5),
  };
}

export function loadArtifactConfig(): ArtifactConfig {
  const storageDir = (process.env.ARTIFACT_STORAGE_DIR ?? "./data/artifacts").trim();
  if (storageDir === "") {
    throw new Error("ARTIFACT_STORAGE_DIR must not be empty");
  }
  return {
    storageDir,
    maxCompressedBytes: asPositiveInt(
      process.env.ARTIFACT_MAX_COMPRESSED_BYTES,
      10 * 1024 * 1024,
      "ARTIFACT_MAX_COMPRESSED_BYTES",
    ),
    maxEntries: asPositiveInt(
      process.env.ARTIFACT_MAX_ENTRIES,
      1000,
      "ARTIFACT_MAX_ENTRIES",
    ),
    maxTotalUncompressedBytes: asPositiveInt(
      process.env.ARTIFACT_MAX_TOTAL_UNCOMPRESSED_BYTES,
      100 * 1024 * 1024,
      "ARTIFACT_MAX_TOTAL_UNCOMPRESSED_BYTES",
    ),
    maxIndividualUncompressedBytes: asPositiveInt(
      process.env.ARTIFACT_MAX_INDIVIDUAL_UNCOMPRESSED_BYTES,
      50 * 1024 * 1024,
      "ARTIFACT_MAX_INDIVIDUAL_UNCOMPRESSED_BYTES",
    ),
  };
}

export function loadExecutionConfig(): ExecutionConfig {
  return {
    maxCpu: asPositiveInt(process.env.EXECUTION_MAX_CPU, 4, "EXECUTION_MAX_CPU"),
    maxMemoryMb: asPositiveInt(process.env.EXECUTION_MAX_MEMORY_MB, 1024, "EXECUTION_MAX_MEMORY_MB"),
    maxTimeoutSeconds: asPositiveInt(process.env.EXECUTION_MAX_TIMEOUT_SECONDS, 300, "EXECUTION_MAX_TIMEOUT_SECONDS"),
    maxCommandLength: asPositiveInt(process.env.EXECUTION_MAX_COMMAND_LENGTH, 64, "EXECUTION_MAX_COMMAND_LENGTH"),
    maxInputJsonBytes: asPositiveInt(process.env.EXECUTION_MAX_INPUT_JSON_BYTES, 65536, "EXECUTION_MAX_INPUT_JSON_BYTES"),
    maxInputDepth: asPositiveInt(process.env.EXECUTION_MAX_INPUT_DEPTH, 8, "EXECUTION_MAX_INPUT_DEPTH"),
  };
}

export function loadDockerConfig(): DockerConfig {
  return {
    pidLimit: asPositiveInt(process.env.DOCKER_PID_LIMIT, 64, "DOCKER_PID_LIMIT"),
    maxOutputBytes: asPositiveInt(process.env.DOCKER_MAX_OUTPUT_BYTES, 1024 * 1024, "DOCKER_MAX_OUTPUT_BYTES"),
    tmpfsSizeMb: asPositiveInt(process.env.DOCKER_TMPFS_SIZE_MB, 64, "DOCKER_TMPFS_SIZE_MB"),
  };
}

export function loadLeaseConfig(): LeaseConfig {
  const leaseDurationMs = asPositiveInt(process.env.LEASE_DURATION_MS, 30000, "LEASE_DURATION_MS");
  const heartbeatIntervalMs = asPositiveInt(process.env.HEARTBEAT_INTERVAL_MS, 10000, "HEARTBEAT_INTERVAL_MS");
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new Error("HEARTBEAT_INTERVAL_MS must be less than LEASE_DURATION_MS");
  }
  return { leaseDurationMs, heartbeatIntervalMs };
}

export function loadServerConfig(): ServerConfig {
  return {
    port: asPort(process.env.PORT, 4700),
    db: loadDatabaseConfig(),
    artifacts: loadArtifactConfig(),
    execution: loadExecutionConfig(),
    docker: loadDockerConfig(),
    lease: loadLeaseConfig(),
  };
}
