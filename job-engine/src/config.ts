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

export interface ServerConfig {
  readonly port: number;
  readonly db: DatabaseConfig;
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

export function loadServerConfig(): ServerConfig {
  return {
    port: asPort(process.env.PORT, 4700),
    db: loadDatabaseConfig(),
  };
}
