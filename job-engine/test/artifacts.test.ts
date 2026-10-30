import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { Pool } from "pg";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import JSZip from "jszip";
import { createTestPool, truncateArtifacts, truncateJobs } from "./helpers.js";
import { createApp } from "../src/app.js";
import { LocalArtifactStorage } from "../src/storage/localArtifactStorage.js";
import type { ArtifactConfig } from "../src/config.js";

const storageDir = path.join(os.tmpdir(), "job-engine-artifacts-integration");

async function makeZipBuffer(content = "hello"): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("hello.txt", content);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return buf as Buffer;
}

describe("artifacts (PostgreSQL + filesystem integration)", () => {
  let pool: Pool;
  let app: any;
  let storage: LocalArtifactStorage;
  const config: ArtifactConfig = {
    storageDir,
    maxCompressedBytes: 1024,
    maxEntries: 10,
    maxTotalUncompressedBytes: 4096,
    maxIndividualUncompressedBytes: 2048,
  };

  beforeEach(async () => {
    await fs.rm(storageDir, { recursive: true, force: true });
    await fs.mkdir(storageDir, { recursive: true });
    storage = new LocalArtifactStorage(storageDir);
    pool = createTestPool();
    const container = createApp({ pool, artifactStorage: storage, artifactConfig: config });
    app = container.app;
    await truncateJobs(pool);
    await truncateArtifacts(pool);
  });

  afterAll(async () => {
    await pool?.end().catch(() => undefined);
    await fs.rm(storageDir, { recursive: true, force: true });
  });

  it("uploads a valid ZIP and returns 201 with metadata", async () => {
    const buf = await makeZipBuffer();
    const res = await request(app).post("/artifacts").attach("file", buf, "my_program.zip");
    expect(res.status).toBe(201);
    expect(res.body.artifactId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(res.body.filename).toBe("my_program.zip");
    expect(res.body.sizeBytes).toBe(buf.length);
    expect(res.body.sha256).toBe(crypto.createHash("sha256").update(buf).digest("hex"));
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("stores the archive on the local filesystem", async () => {
    const buf = await makeZipBuffer();
    const res = await request(app).post("/artifacts").attach("file", buf, "a.zip");
    expect(res.status).toBe(201);
    const id = res.body.artifactId;
    const filePath = path.join(storageDir, id);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
    const stored = await fs.readFile(filePath);
    expect(stored.equals(buf)).toBe(true);
  });

  it("persists metadata in PostgreSQL", async () => {
    const buf = await makeZipBuffer();
    const res = await request(app).post("/artifacts").attach("file", buf, "a.zip");
    expect(res.status).toBe(201);
    const id = res.body.artifactId;
    const db = await pool.query("SELECT * FROM artifacts WHERE id = $1", [id]);
    expect(db.rows.length).toBe(1);
    expect(db.rows[0].filename).toBe("a.zip");
    expect(Number(db.rows[0].size_bytes)).toBe(buf.length);
  });

  it("GET /artifacts/:id returns metadata", async () => {
    const buf = await makeZipBuffer();
    const created = await request(app).post("/artifacts").attach("file", buf, "a.zip");
    const id = created.body.artifactId;
    const fetched = await request(app).get(`/artifacts/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.artifactId).toBe(id);
    expect(fetched.body.filename).toBe("a.zip");
    expect(fetched.body.sizeBytes).toBe(buf.length);
  });

  it("returns 404 for unknown artifact id", async () => {
    const res = await request(app).get(`/artifacts/${crypto.randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it("rejects malformed ZIP", async () => {
    const res = await request(app).post("/artifacts").attach("file", Buffer.from("not a zip"), "bad.zip");
    expect(res.status).not.toBe(201);
    const count = await pool.query("SELECT count(*)::text AS c FROM artifacts");
    expect(Number(count.rows[0].c)).toBe(0);
  });

  it("rejects corrupt ZIP with PK signature", async () => {
    const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff, 0xff]);
    const res = await request(app).post("/artifacts").attach("file", buf, "corrupt.zip");
    expect(res.status).not.toBe(201);
    const count = await pool.query("SELECT count(*)::text AS c FROM artifacts");
    expect(Number(count.rows[0].c)).toBe(0);
  });

  it("rejects oversized uploads with 413", async () => {
    const big = Buffer.alloc(2048, 0);
    big[0] = 0x50;
    big[1] = 0x4b;
    big[2] = 0x03;
    big[3] = 0x04;
    const res = await request(app).post("/artifacts").attach("file", big, "big.zip");
    expect(res.status).toBe(413);
    const count = await pool.query("SELECT count(*)::text AS c FROM artifacts");
    expect(Number(count.rows[0].c)).toBe(0);
  });

  it("rejects missing file with 400", async () => {
    const res = await request(app).post("/artifacts");
    expect(res.status).toBe(400);
  });

  it("rejects multiple files", async () => {
    const buf = await makeZipBuffer();
    const res = await request(app).post("/artifacts").attach("file", buf, "a.zip").attach("file", buf, "b.zip");
    expect(res.status).toBe(400);
  });

  it("database failure triggers filesystem cleanup", async () => {
    const buf = await makeZipBuffer();
    const brokenPool = new Pool({
      host: "127.0.0.1",
      port: 1,
      user: "jobeng",
      password: "jobeng-secret",
      database: "job_engine_test",
      connectionTimeoutMillis: 500,
      max: 1,
    });
    const brokenApp = createApp({ pool: brokenPool, artifactStorage: storage, artifactConfig: config }).app;
    const res = await request(brokenApp).post("/artifacts").attach("file", buf, "a.zip");
    expect(res.status).toBeGreaterThanOrEqual(400);
    const files = await fs.readdir(storageDir);
    expect(files.length).toBe(0);
    const count = await pool.query("SELECT count(*)::text AS c FROM artifacts");
    expect(Number(count.rows[0].c)).toBe(0);
    await brokenPool.end().catch(() => undefined);
  });

  it("duplicate artifact ids cannot overwrite existing files", async () => {
    await storage.store("dup-id", Buffer.from("first"));
    await expect(storage.store("dup-id", Buffer.from("second"))).rejects.toBeTruthy();
    const got = await storage.retrieve("dup-id");
    expect(got.toString()).toBe("first");
  });

  it("enforces path traversal rejection", async () => {
    const zip = new JSZip();
    zip.file("../escape.txt", "x");
    const buf = (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
    const res = await request(app).post("/artifacts").attach("file", buf, "bad.zip");
    expect(res.status).not.toBe(201);
    const count = await pool.query("SELECT count(*)::text AS c FROM artifacts");
    expect(Number(count.rows[0].c)).toBe(0);
  });
});
