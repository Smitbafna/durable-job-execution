/**
 * Job Engine — HTTP routes for jobs.
 *
 * Handlers are deliberately thin: they validate input at the boundary, delegate
 * to the service, and serialize the result. Errors flow to the centralized
 * error handler via `next`.
 */

import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import {
  validateJobId,
  validateSubmitJobRequest,
} from "./validate.js";
import { serializeJob } from "./serializers.js";
import { AppError } from "../errors.js";
import { JobService } from "../service/jobService.js";

export function jobRoutes(service: JobService): Router {
  const router = Router();
  router.post("/", createJobHandler(service));
  router.get("/:id", getJobHandler(service));
  return router;
}

function createJobHandler(service: JobService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = validateSubmitJobRequest(req.body);
      if (parsed instanceof AppError) return next(parsed);

      const job = await service.submitJob(parsed);
      res.status(201).json(serializeJob(job));
    } catch (e) {
      next(e);
    }
  };
}

function getJobHandler(service: JobService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const idOrErr = validateJobId(req.params.id);
      if (idOrErr instanceof AppError) return next(idOrErr);

      const job = await service.getJob(idOrErr);
      if (job === null) {
        return next(AppError.notFound(`Job not found: ${idOrErr}`));
      }
      res.json(serializeJob(job));
    } catch (e) {
      next(e);
    }
  };
}
