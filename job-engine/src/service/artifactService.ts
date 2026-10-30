import { randomUUID, createHash } from "node:crypto";
import { AppError, AppErrorCode } from "../errors.js";
import type { Artifact } from "../domain/artifact.js";
import { ArtifactRepository, type CreateArtifactInput } from "../db/artifactRepository.js";
import type { ArtifactStorage } from "../storage/artifactStorage.js";
import type { ArtifactConfig } from "../config.js";
import { validateZipArchive, isZipBuffer, toZipLimits } from "../zip/zipValidation.js";
import { sanitizeFilename } from "../util/sanitizeFilename.js";

export interface UploadArtifactCommand {
  readonly filename: string;
  readonly contentType: string;
  readonly data: Buffer;
}

export class ArtifactService {
  constructor(
    private readonly repo: ArtifactRepository,
    private readonly storage: ArtifactStorage,
    private readonly config: ArtifactConfig,
  ) {}

  private sha256(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
  }

  async uploadArtifact(cmd: UploadArtifactCommand): Promise<Artifact> {
    const { data } = cmd;

    if (!Buffer.isBuffer(data)) {
      throw new AppError(AppErrorCode.ValidationError, 400, "Uploaded file data is required");
    }

    if (data.length === 0) {
      throw new AppError(AppErrorCode.ValidationError, 400, "Uploaded file is empty");
    }
    if (data.length > this.config.maxCompressedBytes) {
      throw AppError.payloadTooLarge(
        `Uploaded file exceeds maximum compressed size of ${this.config.maxCompressedBytes} bytes`,
      );
    }

    if (!isZipBuffer(data)) {
      throw AppError.unsupportedMediaType("Uploaded file is not a ZIP archive");
    }

    await validateZipArchive(data, toZipLimits(this.config));

    const sha256 = this.sha256(data);
    const id = randomUUID();
    const filename = sanitizeFilename(cmd.filename);

    let stored;
    try {
      stored = await this.storage.store(id, data);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(AppErrorCode.Internal, 500, "Failed to store artifact");
    }

    try {
      const input: CreateArtifactInput = {
        id,
        filename,
        storageKey: stored.storageKey,
        sizeBytes: data.length,
        sha256,
        contentType: "application/zip",
      };
      return await this.repo.createArtifact(input);
    } catch (e) {
      try {
        await this.storage.delete(stored.storageKey);
      } catch (cleanupErr) {
        // eslint-disable-next-line no-console
        console.error(
          "[artifact-service] cleanup failed after metadata insert error:",
          cleanupErr,
        );
      }
      throw e;
    }
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    return this.repo.getArtifactById(id);
  }
}
