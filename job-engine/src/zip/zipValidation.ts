import yauzl from "yauzl";
import path from "node:path";
import { AppError, AppErrorCode } from "../errors.js";
import type { ArtifactConfig } from "../config.js";

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxTotalUncompressedBytes: number;
  readonly maxIndividualUncompressedBytes: number;
}

export function toZipLimits(cfg: ArtifactConfig): ZipLimits {
  return {
    maxEntries: cfg.maxEntries,
    maxTotalUncompressedBytes: cfg.maxTotalUncompressedBytes,
    maxIndividualUncompressedBytes: cfg.maxIndividualUncompressedBytes,
  };
}

function fail(message: string): never {
  throw new AppError(AppErrorCode.ValidationError, 400, message);
}

function isUnsafeEntryName(name: string): boolean {
  if (typeof name !== "string" || name === "") return true;
  if (name.includes("\0")) return true;
  // Windows drive-prefixed paths.
  if (/^[a-zA-Z]:[\\/]/.test(name)) return true;
  // Absolute paths.
  if (name.startsWith("/") || name.startsWith("\\")) return true;

  // Normalize separators for traversal checks.
  const slashName = name.replace(/\\/g, "/");
  let normalized: string;
  try {
    normalized = path.posix.normalize(slashName);
  } catch {
    return true;
  }
  if (normalized === ".." || normalized.startsWith("../")) return true;
  // Also reject any raw segment that is ".." (catches weird encodings).
  const segments = slashName.split("/");
  if (segments.some((s) => s === "..")) return true;
  // Reject entries that normalize to an absolute path.
  if (path.posix.isAbsolute(normalized)) return true;
  return false;
}

/**
 * Validates the structure and metadata of a ZIP archive contained in `buffer`
 * without extracting it. Throws an `AppError` (400) on any validation failure.
 */
export async function validateZipArchive(
  buffer: Buffer,
  limits: ZipLimits,
): Promise<void> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail("Uploaded file is empty");
  }

  let zip: yauzl.ZipFile;
  try {
    zip = await yauzl.fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
  } catch (e) {
    fail(`Invalid ZIP archive: ${(e as Error).message}`);
  }

  try {
    let entryCount = 0;
    let totalUncompressed = 0n;
    const maxTotal = BigInt(limits.maxTotalUncompressedBytes);
    const maxIndividual = limits.maxIndividualUncompressedBytes;
    const maxEntries = limits.maxEntries;

    // yauzl with lazyEntries requires readEntry() after each entry; using
    // the async iterable handles that internally.
    for await (const entry of zip.eachEntry()) {
      entryCount += 1;
      if (entryCount > maxEntries) {
        fail(`ZIP archive exceeds maximum entry count of ${maxEntries}`);
      }

      if (isUnsafeEntryName(entry.fileName)) {
        fail(`Unsafe ZIP entry path: ${entry.fileName}`);
      }

      // Reject encrypted entries.
      if (typeof entry.isEncrypted === "function" && entry.isEncrypted()) {
        fail("Encrypted ZIP entries are not supported");
      }

      // Only stored (0) and deflate (8) are supported by the parser.
      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        fail(
          `Unsupported ZIP compression method: ${entry.compressionMethod}`,
        );
      }

      if (typeof entry.canDecodeFileData === "function" && !entry.canDecodeFileData()) {
        fail("ZIP entry cannot be decoded");
      }

      // Symlink detection via Unix file mode in external attributes.
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & 0xf000) === 0xa000) {
        fail("Unsafe symlink entry in ZIP archive");
      }

      const uncompressed = entry.uncompressedSize;
      if (
        typeof uncompressed !== "number" ||
        !Number.isFinite(uncompressed) ||
        uncompressed < 0
      ) {
        fail("Invalid ZIP entry size");
      }
      if (uncompressed > maxIndividual) {
        fail(
          `ZIP entry exceeds maximum uncompressed size of ${maxIndividual} bytes`,
        );
      }

      // Integer-overflow-safe accumulation.
      totalUncompressed += BigInt(uncompressed);
      if (totalUncompressed > maxTotal) {
        fail(
          `ZIP archive exceeds maximum total uncompressed size of ${limits.maxTotalUncompressedBytes} bytes`,
        );
      }

      const compressed = entry.compressedSize;
      if (
        typeof compressed !== "number" ||
        !Number.isFinite(compressed) ||
        compressed < 0
      ) {
        fail("Invalid ZIP entry compressed size");
      }
    }

    if (entryCount === 0) {
      // An empty archive is structurally valid but useless; allow it.
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    fail(`Invalid ZIP archive: ${(e as Error).message}`);
  } finally {
    try {
      zip.close();
    } catch {
      /* ignore */
    }
  }
}

export function isZipBuffer(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  // Local file header, empty archive, or spanned archive signatures.
  const sig = (buffer[2] << 8) | buffer[3];
  return sig === 0x0304 || sig === 0x0506 || sig === 0x0708;
}