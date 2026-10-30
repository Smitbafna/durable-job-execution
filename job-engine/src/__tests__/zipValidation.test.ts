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
describe("validateZipArchive hardening", () => {
  const limits = {
    maxEntries: 10,
    maxTotalUncompressedBytes: 1024,
    maxIndividualUncompressedBytes: 512,
  };

  it("rejects truncated compressed stream", async () => {
    const buf = await makeZip([{ name: "a.txt", content: "hello world" }]);
    const truncated = buf.subarray(0, buf.length - 5);
    await expect(validateZipArchive(truncated, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects malformed compressed data", async () => {
    // A truncated compressed stream exercises the streaming failure path.
    const buf = await makeZip([{ name: "a.txt", content: "hello world" }]);
    const truncated = buf.subarray(0, buf.length - 10);
    await expect(validateZipArchive(truncated, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects exact duplicate entries", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { execFileSync } = await import("node:child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zip-"));
    const zipPath = path.join(tmpDir, "dup.zip");
    const py = [
      "import zipfile",
      "z = zipfile.ZipFile('" + zipPath + "', 'w')",
      "z.writestr('dup.txt', 'a')",
      "z.writestr('dup.txt', 'b')",
      "z.close()",
    ].join(String.fromCharCode(10));
    execFileSync("python3", ["-c", py]);
    const buf = fs.readFileSync(zipPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects slash/backslash duplicate entries", async () => {
    const zip = new JSZip();
    zip.file("folder/file.txt", "a");
    zip.file("folder\\file.txt", "b");
    const buf = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects file/directory conflicts", async () => {
    const zip = new JSZip();
    zip.file("folder", "x");
    zip.file("folder/child.txt", "y");
    const buf = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects case-variation conflicts", async () => {
    const zip = new JSZip();
    zip.file("File.txt", "a");
    zip.file("file.txt", "b");
    const buf = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects unix symlink entries", async () => {
    const tmpDir = (await import("node:fs")).mkdtempSync(
      (await import("node:os")).tmpdir() + "/zip-",
    );
    const zipPath = tmpDir + "/sym.zip";
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    const py = [
      "import zipfile",
      "z = zipfile.ZipFile(\"" + zipPath + "\", \"w\")",
      "info = zipfile.ZipInfo(\"link.txt\")",
      "info.external_attr = (0o120777 & 0xFFFF) << 16",
      "z.writestr(info, \"target\")",
      "z.close()",
    ].join("\n");
    execFileSync("python3", ["-c", py]);
    const buf = fs.readFileSync(zipPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });

  it("accepts directory entries", async () => {
    const zip = new JSZip();
    zip.folder("dir");
    zip.file("dir/a.txt", "hi");
    const buf = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    await expect(validateZipArchive(buf, limits)).resolves.toBeUndefined();
  });

  it("rejects special file types", async () => {
    const tmpDir = (await import("node:fs")).mkdtempSync(
      (await import("node:os")).tmpdir() + "/zip-",
    );
    const zipPath = tmpDir + "/special.zip";
    const { execFileSync } = await import("node:child_process");
    const fs = await import("node:fs");
    // FIFO mode
    const py = [
      "import zipfile",
      "z = zipfile.ZipFile(\"" + zipPath + "\", \"w\")",
      "info = zipfile.ZipInfo(\"fifo\")",
      "info.external_attr = (0o010644 & 0xFFFF) << 16",
      "z.writestr(info, \"\")",
      "z.close()",
    ].join("\n");
    execFileSync("python3", ["-c", py]);
    const buf = fs.readFileSync(zipPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await expect(validateZipArchive(buf, limits)).rejects.toBeInstanceOf(AppError);
  });
});
