import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { validateZipArchive, isZipBuffer } from "../zip/zipValidation.js";
import { AppError } from "../errors.js";

async function makeZip(
  entries: { name: string; content?: string; size?: number }[],
): Promise<Buffer> {
  const zip = new JSZip();
  for (const e of entries) {
    if (e.size !== undefined) {
      zip.file(e.name, "a".repeat(e.size));
    } else {
      zip.file(e.name, e.content ?? "hello");
    }
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf as Buffer;
}

const limits = {
  maxEntries: 10,
  maxTotalUncompressedBytes: 1024,
  maxIndividualUncompressedBytes: 512,
};

describe("isZipBuffer", () => {
  it("detects ZIP magic", async () => {
    const buf = await makeZip([{ name: "a.txt", content: "x" }]);
    expect(isZipBuffer(buf)).toBe(true);
  });
  it("rejects non-ZIP", () => {
    expect(isZipBuffer(Buffer.from("hello"))).toBe(false);
    expect(isZipBuffer(Buffer.alloc(0))).toBe(false);
  });
});

describe("validateZipArchive", () => {
  it("accepts a valid archive", async () => {
    const buf = await makeZip([{ name: "dir/a.txt", content: "hi" }]);
    await expect(validateZipArchive(buf, limits)).resolves.toBeUndefined();
  });

  it("rejects invalid bytes", async () => {
    await expect(
      validateZipArchive(Buffer.from("not a zip"), limits),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("enforces entry count", async () => {
    const entries = Array.from({ length: 11 }, (_, i) => ({
      name: `f${i}.txt`,
      content: "x",
    }));
    const buf = await makeZip(entries);
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("enforces total uncompressed size", async () => {
    const buf = await makeZip([
      { name: "a.txt", size: 600 },
      { name: "b.txt", size: 600 },
    ]);
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("enforces individual uncompressed size", async () => {
    const buf = await makeZip([{ name: "big.txt", size: 600 }]);
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects absolute paths", async () => {
    const buf = await makeZip([{ name: "/etc/passwd", content: "x" }]);
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects traversal paths", async () => {
    const buf = await makeZip([{ name: "../escape.txt", content: "x" }]);
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects windows drive paths", async () => {
    const buf = await makeZip([{ name: "C:\\\\windows\\\\system32.txt", content: "x" }]);
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

    it("rejects symlink entries", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));
    const zipPath = path.join(tmpDir, "symlink.zip");
    const py = [
      "import zipfile, os",
      "z = zipfile.ZipFile(os.sys.argv[1], 'w')",
      "info = zipfile.ZipInfo('link.txt')",
      "info.external_attr = (0o120777 & 0xFFFF) << 16",
      "z.writestr(info, 'target')",
      "z.close()",
    ].join("\n");
    execFileSync("python3", ["-c", py, zipPath]);
    const buf = fs.readFileSync(zipPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });
});