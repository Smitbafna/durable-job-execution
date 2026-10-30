import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalArtifactStorage } from "../storage/localArtifactStorage.js";
import { AppError } from "../errors.js";

describe("LocalArtifactStorage", () => {
  let dir: string;
  let storage: LocalArtifactStorage;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "art-"));
    storage = new LocalArtifactStorage(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("stores and retrieves bytes", async () => {
    const data = Buffer.from("hello zip");
    const stored = await storage.store("abc", data);
    expect(stored.storageKey).toBe("abc");
    const got = await storage.retrieve("abc");
    expect(got.equals(data)).toBe(true);
  });

  it("creates directory safely", async () => {
    const nested = path.join(dir, "nested", "deep");
    const s = new LocalArtifactStorage(nested);
    await s.store("x", Buffer.from("y"));
    const got = await s.retrieve("x");
    expect(got.toString()).toBe("y");
  });

  it("prevents overwrite of existing artifact", async () => {
    await storage.store("dup", Buffer.from("first"));
    await expect(storage.store("dup", Buffer.from("second"))).rejects.toBeInstanceOf(AppError);
    const got = await storage.retrieve("dup");
    expect(got.toString()).toBe("first");
  });

  it("delete is idempotent", async () => {
    await storage.store("t", Buffer.from("x"));
    await storage.delete("t");
    await storage.delete("t");
    await expect(storage.retrieve("t")).rejects.toBeTruthy();
  });

  it("rejects unsafe keys", async () => {
    await expect(storage.store("../escape", Buffer.from("x"))).rejects.toBeTruthy();
    await expect(storage.retrieve("a/b")).rejects.toBeTruthy();
  });
});