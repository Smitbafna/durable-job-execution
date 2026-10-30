import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { Pool } from "pg";
import JSZip from "jszip";
import { truncateJobs, truncateArtifacts, createTestPool } from "./helpers.js";
import { createApp } from "../src/app.js";
import { Worker } from "../src/worker/worker.js";
import { RuntimeRegistry } from "../src/runtime/executionRuntime.js";
import type { ExecutionRuntime, ExecutionResult } from "../src/runtime/executionRuntime.js";
import fs from "node:fs/promises";

async function makeZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("main.py", "print('hi')");
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

describe("execution spec jobs", () => {
  let pool: Pool;
  let app: any;
  let container: any;

  beforeEach(async () => {
    pool = createTestPool();
    container = createApp({ pool });
    app = container.app;
    await truncateJobs(pool);
    await truncateArtifacts(pool);
  });

  afterEach(async () => {
    await pool.end().catch(() => undefined);
  });

  it("submits and executes an execute_artifact job", async () => {
    const buf = await makeZip();
    const up = await request(app).post("/artifacts").attach("file", buf, "proj.zip");
    expect(up.status).toBe(201);
    const artifactId = up.body.artifactId;

    const jobRes = await request(app)
      .post("/jobs")
      .send({
        type: "execute_artifact",
        payload: {
          artifactId,
          runtime: "python:3.12",
          command: ["python", "main.py"],
          workingDirectory: ".",
          input: {},
          resources: { cpu: 1, memoryMb: 128, timeoutSeconds: 10 },
        },
      });
    expect(jobRes.status).toBe(201);
    const id = jobRes.body.id;

    class ReadingRuntime implements ExecutionRuntime {
      async execute(_spec: any, artifactPath: string): Promise<ExecutionResult> {
        const data = await fs.readFile(artifactPath);
        return { exitCode: 0, stdout: String(data.length), stderr: "", durationMs: 1 };
      }
    }
    const runtime = new ReadingRuntime();
    const registry = new RuntimeRegistry();
    registry.register("python:3.12", runtime);
    const worker = new Worker(
      { workerId: "t", pollIntervalMs: 50, concurrency: 1 } as any,
      { info() {}, warn() {}, error() {} },
      container.repository,
      pool,
      registry,
      container.artifactService,
    );
    worker.start();

    // poll
    const deadline = Date.now() + 5000;
    let final: any = null;
    while (Date.now() < deadline) {
      const r = await request(app).get(`/jobs/${id}`);
      if (r.body.status === "succeeded") {
        final = r.body;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    worker.stop();
    expect(final).not.toBeNull();
    expect(final.result.exitCode).toBe(0);
    expect(final.result.stdout).toBe(String(buf.length));
  });
});
