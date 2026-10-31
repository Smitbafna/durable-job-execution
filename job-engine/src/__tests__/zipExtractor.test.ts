import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { execFileSync } from "node:child_process";
import { extractZipToWorkspace } from "../zip/zipExtractor.js";
import { toZipLimits } from "../zip/zipValidation.js";
import type { ArtifactConfig } from "../config.js";

const cfg: ArtifactConfig = {
  storageDir: "/tmp/x",
  maxCompressedBytes: 1024,
  maxEntries: 10,
  maxTotalUncompressedBytes: 4096,
  maxIndividualUncompressedBytes: 2048,
};
const limits = toZipLimits(cfg);

async function makeZip(entries: { name: string; content?: string }[]): Promise<Buffer> {
  const zip = new JSZip();
  for (const e of entries) zip.file(e.name, e.content ?? "hi");
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

describe("extractZipToWorkspace", () => {
  it("extracts valid nested archive", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-"));
    const buf = await makeZip([{ name: "dir/a.txt", content: "hi" }]);
    await extractZipToWorkspace(buf, dir, limits);
    const data = await fs.readFile(path.join(dir, "dir", "a.txt"), "utf8");
    expect(data).toBe("hi");
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects path traversal", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-"));
    const py = [
      "import zipfile",
      "z = zipfile.ZipFile('" + path.join(dir, "bad.zip") + "', 'w')",
      "z.writestr('../escape.txt', 'x')",
      "z.close()",
    ].join(String.fromCharCode(10));
    execFileSync("python3", ["-c", py]);
    const buf = await fs.readFile(path.join(dir, "bad.zip"));
    await expect(extractZipToWorkspace(buf, path.join(dir, "out"), limits)).rejects.toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects duplicate entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-"));
    const py = [
      "import zipfile",
      "z = zipfile.ZipFile('" + path.join(dir, "dup.zip") + "', 'w')",
      "z.writestr('dup.txt', 'a')",
      "z.writestr('dup.txt', 'b')",
      "z.close()",
    ].join(String.fromCharCode(10));
    execFileSync("python3", ["-c", py]);
    const buf = await fs.readFile(path.join(dir, "dup.zip"));
    await expect(extractZipToWorkspace(buf, path.join(dir, "out"), limits)).rejects.toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("rejects symlink entries", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-"));
    const zipPath = path.join(dir, "sym.zip");
    const py = [
      "import zipfile",
      "z = zipfile.ZipFile('" + zipPath + "', 'w')",
      "info = zipfile.ZipInfo('link.txt')",
      "info.external_attr = (0o120777 & 0xFFFF) << 16",
      "z.writestr(info, 'target')",
      "z.close()",
    ].join(String.fromCharCode(10));
    execFileSync("python3", ["-c", py]);
    const buf = await fs.readFile(zipPath);
    await expect(extractZipToWorkspace(buf, path.join(dir, "out"), limits)).rejects.toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("cleans partial extraction on failure", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-"));
    const out = path.join(dir, "out");
    const py = [
      "import zipfile",
      "z = zipfile.ZipFile('" + path.join(dir, "bad.zip") + "', 'w')",
      "z.writestr('../escape.txt', 'x')",
      "z.close()",
    ].join(String.fromCharCode(10));
    execFileSync("python3", ["-c", py]);
    const buf = await fs.readFile(path.join(dir, "bad.zip"));
    await expect(extractZipToWorkspace(buf, out, limits)).rejects.toBeTruthy();
    await expect(fs.access(out)).rejects.toBeTruthy();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe("extraction cancellation", () => {
  it("aborted signal prevents extraction", async () => {
    const dir = await (await import("node:fs/promises")).mkdtemp((await import("node:os")).tmpdir() + "/ws-");
    const JSZip = (await import("jszip")).default;
    const zip = new JSZip();
    zip.file("a.txt", "hi");
    const buf = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    const controller = new AbortController();
    controller.abort();
    await expect(
      (await import("../zip/zipExtractor.js")).extractZipToWorkspace(buf, dir, limits, controller.signal),
    ).rejects.toBeTruthy();
    await (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });
  });
});
