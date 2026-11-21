/**
 * Job Engine — HTTP routes for jobs.
 *
 * Handlers are deliberately thin: they validate input at the boundary, delegate
 * to the service, and serialize the result. Errors flow to the centralized
 * error handler via `next`.
 */

import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import { JobStatus } from "../domain/job.js";
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
  router.get("/:id/result", getJobResultHandler(service));
  router.get("/:id/logs", getJobLogsHandler(service));
  router.post("/:id/cancel", cancelJobHandler(service));
  return router;
}

function cancelJobHandler(service: JobService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const idOrErr = validateJobId(req.params.id);
      if (idOrErr instanceof AppError) return next(idOrErr);

      const job = await service.cancelJob(idOrErr);
      res.json(serializeJob(job));
    } catch (e) {
      next(e);
    }
  };
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

function getJobResultHandler(service: JobService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const idOrErr = validateJobId(req.params.id);
      if (idOrErr instanceof AppError) return next(idOrErr);

      const job = await service.getJob(idOrErr);
      if (job === null) {
        return next(AppError.notFound(`Job not found: ${idOrErr}`));
      }

      if (job.status === JobStatus.Queued || job.status === JobStatus.Running || job.status === JobStatus.WaitingForRetry) {
        res.status(202).json({ message: "Result not available, job is still in progress" });
        return;
      }

      if (job.status === JobStatus.Succeeded) {
        res.json({
          id: job.id,
          type: job.type,
          status: job.status,
          result: job.result,
          exitCode: job.exitCode,
        });
        return;
      }

      if (job.status === JobStatus.Failed) {
        res.status(200).json({
          id: job.id,
          type: job.type,
          status: job.status,
          error: job.error,
          exitCode: job.exitCode,
        });
        return;
      }

      if (job.status === JobStatus.Cancelled) {
        res.status(200).json({
          id: job.id,
          type: job.type,
          status: job.status,
          result: null,
        });
        return;
      }

      res.status(202).json({ message: "Result unavailable" });
    } catch (e) {
      next(e);
    }
  };
}

function getJobLogsHandler(service: JobService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const idOrErr = validateJobId(req.params.id);
      if (idOrErr instanceof AppError) return next(idOrErr);

      const job = await service.getJob(idOrErr);
      if (job === null) {
        return next(AppError.notFound(`Job not found: ${idOrErr}`));
      }

      res.json({
        stdout: job.stdout ?? "",
        stderr: job.stderr ?? "",
      });
      return;
    } catch (e) {
      next(e);
    }
  };
}
