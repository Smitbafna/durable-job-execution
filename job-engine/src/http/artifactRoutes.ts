import { Router } from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { AppError, AppErrorCode } from "../errors.js";
import { ArtifactService } from "../service/artifactService.js";
import type { ArtifactConfig } from "../config.js";
import { serializeArtifact } from "./artifactSerializers.js";
import { validateJobId } from "./validate.js";

export function artifactRoutes(
  service: ArtifactService,
  config: ArtifactConfig,
): Router {
  const router = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.maxCompressedBytes, files: 1 },
  });

  router.post("/", (req: Request, res: Response, next: NextFunction) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return next(
              AppError.payloadTooLarge(
                `Uploaded file exceeds maximum compressed size of ${config.maxCompressedBytes} bytes`,
              ),
            );
          }
          if (err.code === "LIMIT_UNEXPECTED_FILE") {
            return next(
              AppError.badRequest(
                AppErrorCode.ValidationError,
                "Only one file is allowed per request",
              ),
            );
          }
          return next(
            AppError.badRequest(AppErrorCode.ValidationError, err.message),
          );
        }
        return next(err);
      }
      next();
    });
  }, createArtifactHandler(service));

  router.get("/:id", getArtifactHandler(service));

  return router;
}

function createArtifactHandler(service: ArtifactService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const file = req.file as
        | { originalname: string; mimetype: string; buffer: Buffer }
        | undefined;
      if (!file) {
        return next(
          AppError.badRequest(AppErrorCode.ValidationError, "Missing file upload"),
        );
      }
      // Only one file is enforced by multer limits; defensive check.
      // (multer already rejects unexpected files)

      const artifact = await service.uploadArtifact({
        filename: file.originalname,
        contentType: file.mimetype,
        data: file.buffer,
      });
      res.status(201).json(serializeArtifact(artifact));
    } catch (e) {
      next(e);
    }
  };
}

function getArtifactHandler(service: ArtifactService) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const idOrErr = validateJobId(req.params.id);
      if (idOrErr instanceof AppError) return next(idOrErr);

      const artifact = await service.getArtifact(idOrErr);
      if (artifact === null) {
        return next(AppError.notFound(`Artifact not found: ${idOrErr}`));
      }
      res.json(serializeArtifact(artifact));
    } catch (e) {
      next(e);
    }
  };
}