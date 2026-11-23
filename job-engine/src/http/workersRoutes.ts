/** Job Engine — Worker fleet API routes.
 *
 * Exposes the persistent worker registry through REST endpoints.
 * Health status is derived from persisted timestamps (online/stale/stopped).
 */

import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";
import { validateWorkerId } from "./validate.js";
import { JobRepository } from "../db/repository.js";
import { listWorkersStatus, getWorkerStatus } from "../status.js";

/** Returns all workers with derived health status. */
export function workerRoutes(repo: JobRepository): Router {
  const router = Router();
  router.get("/", listWorkersHandler(repo));
  router.get("/:id", getWorkerHandler(repo));
  return router;
}

/** GET /workers - list all workers with health status */
function listWorkersHandler(repo: JobRepository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const workers = await repo.listWorkers();
      const statuses = listWorkersStatus(workers);
      res.json(statuses);
    } catch (e) {
      next(e);
    }
  };
}

/** GET /workers/:id - retrieve one worker with health status */
function getWorkerHandler(repo: JobRepository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const idOrErr = validateWorkerId(req.params.id);
      if (idOrErr instanceof AppError) return next(idOrErr);

      const worker = await repo.getWorker(idOrErr);
      if (worker === null) return next(AppError.notFound(`Worker not found: ${idOrErr}`));

      const status = getWorkerStatus(worker);
      res.json(status);
    } catch (e) {
      next(e);
    }
  };
}