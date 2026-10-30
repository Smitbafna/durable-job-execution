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

export interface CreateAppOptions {
  /** Inject a database pool (e.g. a test pool). Defaults to the env singleton. */
  readonly pool?: Pool;
}

export interface AppContainer {
  readonly app: Express;
  readonly service: JobService;
  readonly repository: JobRepository;
  readonly pool: Pool;
}

export function createApp(opts: CreateAppOptions = {}): AppContainer {
  const app = express();
  app.use(express.json({ limit: "1mb", strict: true }));

  const pool = opts.pool ?? getPool();
  const repository = new JobRepository(pool);
  const service = new JobService(repository);

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
  app.use(errorHandler);

  return { app, service, repository, pool };
}
