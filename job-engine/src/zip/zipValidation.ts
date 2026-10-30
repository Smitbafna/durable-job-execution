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
  if (/^[a-zA-Z]:[\\/]/.test(name)) return true;
  if (name.startsWith("/") || name.startsWith("\\")) return true;

  const slashName = name.replace(/\\/g, "/");
  let normalized: string;
  try {
    normalized = path.posix.normalize(slashName);
  } catch {
    return true;
  }
  if (normalized === "" || normalized === "." || normalized === "..") return true;
  if (normalized.startsWith("../")) return true;
  const segments = slashName.split("/");
  if (segments.some((s) => s === "..")) return true;
  if (path.posix.isAbsolute(normalized)) return true;
  return false;
}

function normalizeEntryPath(name: string): string {
  const slashName = name.replace(/\\/g, "/");
  let normalized = path.posix.normalize(slashName);
  // Strip trailing slashes so directory entries and file entries share one form.
  normalized = normalized.replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") {
    throw new Error("invalid path");
  }
  return normalized;
}

function classifyEntry(entry: yauzl.Entry): "directory" | "file" {
  const name = entry.fileName;
  if (name.endsWith("/") || name.endsWith("\\")) {
    return "directory";
  }

  const creatorPlatform = entry.versionMadeBy >> 8;
  if (creatorPlatform === 3) {
    const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
    const type = mode & 0o170000;
    if (type === 0o040000) return "directory";
    // Type 0 means "not specified" (common for many creators). Treat as a
    // regular file. S_IFREG is explicitly a regular file. Everything else
    // (symlink, block/char device, FIFO, socket) is rejected.
    if (type === 0 || type === 0o100000) return "file";
    fail("Unsupported or unsafe ZIP entry type");
  }

  // Non-Unix creators (DOS/Windows): external attributes are DOS attributes.
  // No Unix-style special files are representable here.
  const dosAttrs = entry.externalFileAttributes & 0xffff;
  if (dosAttrs & 0x10) return "directory";
  return "file";
}

export async function validateZipArchive(
  buffer: Buffer,
  limits: ZipLimits,
): Promise<void> {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail("Uploaded file is empty");
  }

  let zip: yauzl.ZipFile | undefined;
  try {
    zip = await yauzl.fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });

    const seenPaths: { path: string; type: "directory" | "file" }[] = [];
    let entryCount = 0;
    let declaredTotal = 0n;
    let actualTotal = 0;

    for await (const entry of zip.eachEntry()) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        fail(`ZIP archive exceeds maximum entry count of ${limits.maxEntries}`);
      }

      if (isUnsafeEntryName(entry.fileName)) {
        fail(`Unsafe ZIP entry path: ${entry.fileName}`);
      }

      if (typeof entry.isEncrypted === "function" && entry.isEncrypted()) {
        fail("Encrypted ZIP entries are not supported");
      }

      if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
        fail(`Unsupported ZIP compression method: ${entry.compressionMethod}`);
      }

      if (typeof entry.canDecodeFileData === "function" && !entry.canDecodeFileData()) {
        fail("ZIP entry cannot be decoded");
      }

      let normalized: string;
      try {
        normalized = normalizeEntryPath(entry.fileName);
      } catch {
        fail(`Unsafe ZIP entry path: ${entry.fileName}`);
      }

      const entryType = classifyEntry(entry);

      // Duplicate and file/directory conflict detection (case-insensitive).
      const lower = normalized.toLowerCase();
      for (const existing of seenPaths) {
        const existingLower = existing.path.toLowerCase();
        if (lower === existingLower) {
          fail(`Duplicate ZIP entry path: ${entry.fileName}`);
        }
        const fileParentConflict =
          (existing.type === "file" &&
            lower.startsWith(existingLower + "/")) ||
          (entryType === "file" &&
            existingLower.startsWith(lower + "/"));
        if (fileParentConflict) {
          fail(`Conflicting ZIP entry paths: ${entry.fileName}`);
        }
      }
      seenPaths.push({ path: normalized, type: entryType });

      const uncompressed = entry.uncompressedSize;
      if (
        typeof uncompressed !== "number" ||
        !Number.isFinite(uncompressed) ||
        uncompressed < 0
      ) {
        fail("Invalid ZIP entry size");
      }
      if (uncompressed > limits.maxIndividualUncompressedBytes) {
        fail(
          `ZIP entry exceeds maximum uncompressed size of ${limits.maxIndividualUncompressedBytes} bytes`,
        );
      }

      declaredTotal += BigInt(uncompressed);
      if (declaredTotal > BigInt(limits.maxTotalUncompressedBytes)) {
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

      // Directories carry no decompressed payload.
      if (entryType === "directory") {
        if (uncompressed !== 0) {
          fail("ZIP directory entry has unexpected data");
        }
        continue;
      }

      // Stream the entry to count actual decompressed bytes. This does not write
      // to disk and does not retain the full decompressed archive in memory.
      let stream: ReturnType<yauzl.ZipFile["openReadStreamPromise"]> extends Promise<infer S>
        ? S
        : never;
      try {
        stream = await zip.openReadStreamPromise(entry);
      } catch (e) {
        fail(`Invalid ZIP archive: ${(e as Error).message}`);
      }

      let entryActual = 0;
      try {
        for await (const chunk of stream) {
          entryActual += chunk.length;
          if (entryActual > limits.maxIndividualUncompressedBytes) {
            fail(
              `ZIP entry exceeds maximum uncompressed size of ${limits.maxIndividualUncompressedBytes} bytes`,
            );
          }
          actualTotal += chunk.length;
          if (actualTotal > limits.maxTotalUncompressedBytes) {
            fail(
              `ZIP archive exceeds maximum total uncompressed size of ${limits.maxTotalUncompressedBytes} bytes`,
            );
          }
        }
      } catch (e) {
        if (e instanceof AppError) throw e;
        fail(`Invalid ZIP archive: ${(e as Error).message}`);
      } finally {
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
      }

      if (entryActual !== uncompressed) {
        fail(
          `ZIP entry decompressed size mismatch: declared ${uncompressed}, actual ${entryActual}`,
        );
      }
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    fail(`Invalid ZIP archive: ${(e as Error).message}`);
  } finally {
    try {
      zip?.close();
    } catch {
      /* ignore */
    }
  }
}

export function isZipBuffer(buffer: Buffer): boolean {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return false;
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) return false;
  const sig = (buffer[2] << 8) | buffer[3];
  return sig === 0x0304 || sig === 0x0506 || sig === 0x0708;
}
