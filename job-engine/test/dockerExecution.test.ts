import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { Pool } from "pg";
import JSZip from "jszip";
import { truncateJobs, truncateArtifacts, createTestPool } from "./helpers.js";
import { createApp } from "../src/app.js";
import { Worker } from "../src/worker/worker.js";
import { RuntimeRegistry } from "../src/runtime/executionRuntime.js";
import { DockerRuntime } from "../src/runtime/dockerRuntime.js";
import { loadArtifactConfig, loadDockerConfig, loadExecutionConfig } from "../src/config.js";

async function makeZip(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("main.py", "import sys\nprint('hello from docker')\nprint('err', file=sys.stderr)\n");
  return (await zip.generateAsync({ type: "nodebuffer" })) as Buffer;
}

describe("docker execution", () => {
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

  it("executes uploaded python in docker", async () => {
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
          resources: { cpu: 1, memoryMb: 128, timeoutSeconds: 30 },
        },
      });
    expect(jobRes.status).toBe(201);
    const id = jobRes.body.id;

    const artifactConfig = loadArtifactConfig();
    const registry = new RuntimeRegistry();
    registry.register(
      "python:3.12",
      new DockerRuntime(artifactConfig, loadDockerConfig(), loadExecutionConfig()),
    );
    const worker = new Worker(
      { workerId: "d", pollIntervalMs: 50, concurrency: 1 } as any,
      { info() {}, warn() {}, error() {} },
      container.repository,
      pool,
      registry,
      container.artifactService,
    );
    worker.start();

    const deadline = Date.now() + 120000;
    let final: any = null;
    while (Date.now() < deadline) {
      const r = await request(app).get(`/jobs/${id}`);
      if (r.body.status === "succeeded" || r.body.status === "failed") {
        final = r.body;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    worker.stop();
    expect(final).not.toBeNull();
    console.log("FINAL:", JSON.stringify(final));
    expect(final.status).toBe("succeeded");
    expect(final.result.exitCode).toBe(0);
    expect(final.result.stdout).toContain("hello from docker");
    expect(final.result.stderr).toContain("err");
  }, 180000);
});
