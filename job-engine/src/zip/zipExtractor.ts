import yauzl from "yauzl";
import fs from "node:fs/promises";
import path from "node:path";
import { validateZipArchive, isUnsafeEntryName, toZipLimits } from "./zipValidation.js";
import type { ArtifactConfig } from "../config.js";
import type { ZipLimits } from "./zipValidation.js";

export async function extractZipToWorkspace(
  buffer: Buffer,
  workspaceDir: string,
  limits: ZipLimits,
): Promise<void> {
  await validateZipArchive(buffer, limits);

  await fs.mkdir(workspaceDir, { recursive: true });
  let zip: yauzl.ZipFile | undefined;
  const seen = new Map<string, "file" | "directory">();
  let entryCount = 0;
  let totalActual = 0;
  try {
    zip = await yauzl.fromBufferPromise(buffer, {
      lazyEntries: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    for await (const entry of zip.eachEntry()) {
      entryCount += 1;
      if (entryCount > limits.maxEntries) {
        throw new Error("entry count exceeded");
      }
      if (isUnsafeEntryName(entry.fileName)) {
        throw new Error("unsafe entry path");
      }
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const type = mode & 0o170000;
      const creatorPlatform = entry.versionMadeBy >> 8;
      const isDir =
        entry.fileName.endsWith("/") ||
        entry.fileName.endsWith("\\\\") ||
        (creatorPlatform === 3 && type === 0o040000) ||
        (creatorPlatform !== 3 && (entry.externalFileAttributes & 0x10) !== 0);
      if (creatorPlatform === 3 && type !== 0 && type !== 0o100000 && type !== 0o040000) {
        throw new Error("unsupported entry type");
      }

      const normalized = entry.fileName.replace(/\\/g, "/").replace(/\/+$/, "");
      const lower = normalized.toLowerCase();
      if (seen.has(lower)) {
        throw new Error("duplicate entry");
      }
      const entryType = isDir ? "directory" : "file";
      for (const [existingPath, existingType] of seen) {
        if (existingType === "file" && lower.startsWith(existingPath + "/")) {
          throw new Error("conflicting entry paths");
        }
        if (entryType === "file" && existingPath.startsWith(lower + "/")) {
          throw new Error("conflicting entry paths");
        }
      }
      seen.set(lower, entryType);

      const target = path.resolve(workspaceDir, ...normalized.split("/"));
      const prefix = path.resolve(workspaceDir) + path.sep;
      if (target !== path.resolve(workspaceDir) && !target.startsWith(prefix)) {
        throw new Error("path traversal");
      }

      if (isDir) {
        await fs.mkdir(target, { recursive: true });
        continue;
      }

      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.access(target);
        throw new Error("target file already exists");
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e;
      }
      const stream = await zip.openReadStreamPromise(entry);
      const writeStream = (await import("node:fs")).createWriteStream(target);
      let entryBytes = 0;
      try {
        for await (const chunk of stream) {
          entryBytes += chunk.length;
          if (entryBytes > limits.maxIndividualUncompressedBytes) {
            throw new Error("individual size exceeded");
          }
          totalActual += chunk.length;
          if (totalActual > limits.maxTotalUncompressedBytes) {
            throw new Error("total size exceeded");
          }
          if (!writeStream.write(chunk)) {
            await new Promise((resolve) => writeStream.once("drain", resolve));
          }
        }
        writeStream.end();
        await new Promise((resolve, reject) => {
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });
      } catch (e) {
        writeStream.destroy();
        await fs.rm(target, { force: true }).catch(() => undefined);
        throw e;
      }
      if (entryBytes !== entry.uncompressedSize) {
        throw new Error("size mismatch");
      }
    }
  } catch (e) {
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  } finally {
    try {
      zip?.close();
    } catch {
      /* ignore */
    }
  }
}
