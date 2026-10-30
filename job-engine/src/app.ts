/**
 * Job Engine — Express application assembly.
 *
 * Wires middleware, routes, and the centralized error handler. Accepts an
 * optional `pool` so tests can inject an isolated database (including a
 * deliberately-broken one) without touching production credentials.
 */

import express from "express";
import type { Express, Request, Response } from "express";
import { getPool } from "./db/pool.js";
import type { Pool } from "pg";
import { JobRepository } from "./db/repository.js";
import { JobService } from "./service/jobService.js";
import { jobRoutes } from "./http/routes.js";
import { errorHandler } from "./http/errorHandler.js";
import { ArtifactRepository } from "./db/artifactRepository.js";
import { ArtifactService } from "./service/artifactService.js";
import { LocalArtifactStorage } from "./storage/localArtifactStorage.js";
import type { ArtifactStorage } from "./storage/artifactStorage.js";
import { loadArtifactConfig, type ArtifactConfig } from "./config.js";
import { artifactRoutes } from "./http/artifactRoutes.js";

export interface CreateAppOptions {
  /** Inject a database pool (e.g. a test pool). Defaults to the env singleton. */
  readonly pool?: Pool;
  /** Inject an artifact storage backend. Defaults to a local filesystem backend. */
  readonly artifactStorage?: ArtifactStorage;
  /** Inject artifact configuration. Defaults to env-derived configuration. */
  readonly artifactConfig?: ArtifactConfig;
}

export interface AppContainer {
  readonly app: Express;
  readonly service: JobService;
  readonly repository: JobRepository;
  readonly pool: Pool;
  readonly artifactService: ArtifactService;
  readonly artifactRepository: ArtifactRepository;
  readonly artifactStorage: ArtifactStorage;
}

export function createApp(opts: CreateAppOptions = {}): AppContainer {
  const app = express();
  app.use(express.json({ limit: "1mb", strict: true }));

  const pool = opts.pool ?? getPool();
  // A dropped connection (e.g. the database restarting) makes pg.Pool emit an
  // 'error' event on its idle clients. With no listener that is fatal to the
  // process — which would defeat /health's per-request availability check — so we
  // attach a handler that keeps the process alive and logs server-side only.
  // eslint-disable-next-line no-console
  pool.on("error", (err) => console.error("[job-engine] database pool error:", err));
  const repository = new JobRepository(pool);
  const service = new JobService(repository);

  const artifactConfig = opts.artifactConfig ?? loadArtifactConfig();
  const artifactStorage =
    opts.artifactStorage ?? new LocalArtifactStorage(artifactConfig.storageDir);
  const artifactRepository = new ArtifactRepository(pool);
  const artifactService = new ArtifactService(
    artifactRepository,
    artifactStorage,
    artifactConfig,
  );

  /**
   * `/health` distinguishes process liveness from database readiness. The
   * process is up (this handler ran); the database is reported separately and
   * the endpoint fails (503) when the DB check fails.
   */
  app.get("/health", async (_req: Request, res: Response) => {
    let databaseOk = false;
    try {
      await pool.query("SELECT 1");
      databaseOk = true;
    } catch {
      databaseOk = false;
    }
    if (!databaseOk) {
      res.status(503).json({ status: "unhealthy", database: "down" });
      return;
    }
    res.json({
      status: "ok",
      database: "up",
      uptime: process.uptime(),
    });
  });

  app.get("/", (_req: Request, res: Response) => {
    res.json({ name: "job-engine", version: "0.1.0" });
  });

  app.use("/jobs", jobRoutes(service));
  app.use("/artifacts", artifactRoutes(artifactService, artifactConfig));
  app.use(errorHandler);

  return {
    app,
    service,
    repository,
    pool,
    artifactService,
    artifactRepository,
    artifactStorage,
  };
}
