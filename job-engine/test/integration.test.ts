/**
 * Job Engine — PostgreSQL integration tests.
 *
 * Each test exercises the full stack (HTTP → service → repository → PostgreSQL)
 * against the dedicated `job_engine_test` database that the global setup
 * provisions and migrates. The shared pool is truncated between tests and
 * closed once at the end.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { Pool } from "pg";
import type { PoolConfig } from "pg";
import { randomUUID } from "node:crypto";
import { createTestApp, truncateJobs } from "./helpers.js";
import { createApp } from "../src/app.js";
import { JobRepository } from "../src/db/repository.js";

async function countJobs(pool: Pool): Promise<number> {
  const res = await pool.query<{ c: string }>(
    "SELECT count(*)::text AS c FROM jobs",
  );
  return Number(res.rows[0]?.c ?? 0);
}

/** Derives a PoolOptions pointed at the same server as the given pool. */
function configFor(source: Pool): PoolConfig {
  const o = source.options;
  return {
    host: o.host,
    port: o.port,
    user: o.user,
    password: o.password,
    database: o.database,
    connectionTimeoutMillis: 3000,
  };
}

const { app, pool } = createTestApp();

beforeEach(async () => {
  await truncateJobs(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("job engine (PostgreSQL integration)", () => {
  it("POST /jobs persists a job and returns 201 with status queued", async () => {
    const res = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: [1, 2, 3] } })
      .set("Accept", "application/json");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      type: "sum_numbers",
      status: "queued",
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
    });
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(res.body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.payload).toEqual({ numbers: [1, 2, 3] });
  });

  it("GET /jobs/:id returns the persisted job", async () => {
    const created = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: [4, 5] } })
      .set("Accept", "application/json");
    const id = created.body.id;

    const fetched = await request(app).get(`/jobs/${id}`);

    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({
      id,
      type: "sum_numbers",
      status: "queued",
      payload: { numbers: [4, 5] },
    });
    expect(fetched.body.createdAt).toBe(created.body.createdAt);
  });

  it("GET /jobs/:id returns 404 for a valid-but-absent id", async () => {
    const res = await request(app).get(`/jobs/${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: { code: "NOT_FOUND", message: expect.any(String) },
    });
  });

  it("rejects an unsupported job type without creating a row", async () => {
    const res = await request(app)
      .post("/jobs")
      .send({ type: "unknown_type", payload: { numbers: [1] } })
      .set("Accept", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("UNSUPPORTED_JOB_TYPE");
    expect(await countJobs(pool)).toBe(0);
  });

  it("rejects an invalid payload without creating a row", async () => {
    const res = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: ["not-a-number"] } })
      .set("Accept", "application/json");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await countJobs(pool)).toBe(0);
  });

  it("rejects missing type/payload, wrong shape, and non-object bodies", async () => {
    const noType = await request(app).post("/jobs").send({ payload: { numbers: [1] } });
    expect(noType.status).toBe(400);

    const noPayload = await request(app).post("/jobs").send({ type: "sum_numbers" });
    expect(noPayload.status).toBe(400);

    const notObject = await request(app).post("/jobs").send("nope");
    expect(notObject.status).toBe(400);

    expect(await countJobs(pool)).toBe(0);
  });

  it("rejects malformed JSON without creating a row", async () => {
    const res = await request(app)
      .post("/jobs")
      .set("Content-Type", "application/json")
      .send("{{{invalid json");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(await countJobs(pool)).toBe(0);
  });

  it("JSON payloads survive a full database round trip", async () => {
    const numbers = [0, 1.5, -7, 1e6, 2 ** 53];
    const res = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers } })
      .set("Accept", "application/json");

    expect(res.status).toBe(201);
    expect(res.body.payload).toEqual({ numbers });

    const fetched = await request(app).get(`/jobs/${res.body.id}`);
    expect(fetched.body.payload).toEqual({ numbers });

    const col = await pool.query<{ udt_name: string }>(
      "SELECT udt_name FROM information_schema.columns WHERE table_name = 'jobs' AND column_name = 'payload'",
    );
    expect(col.rows[0].udt_name).toBe("jsonb");
  });

  it("the returned id identifies the correct DB record", async () => {
    const submitted = await request(app)
      .post("/jobs")
      .send({ type: "sum_numbers", payload: { numbers: [1, 2, 3] } })
      .set("Accept", "application/json");
    const id = submitted.body.id;

    const direct = await pool.query(
      "SELECT id, type, status, payload FROM jobs WHERE id = $1",
      [id],
    );
    expect(direct.rows).toHaveLength(1);
    expect(direct.rows[0].id).toBe(id);
    expect(direct.rows[0].status).toBe("queued");
    expect(direct.rows[0].payload).toEqual({ numbers: [1, 2, 3] });
  });

  it("database CHECK constraints reject invalid status and type", async () => {
    const badStatus = pool.query(
      "INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, NULL, now(), now())",
      [randomUUID(), "sum_numbers", "bogus_status", {}],
    );
    await expect(badStatus).rejects.toThrow();
    try {
      await badStatus;
    } catch (e) {
      expect((e as Error).message).toMatch(/jobs_status_valid/);
    }

    const badType = pool.query(
      "INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at) VALUES ($1, $2, $3, $4, NULL, NULL, now(), now())",
      [randomUUID(), "bogus_type", "queued", {}],
    );
    await expect(badType).rejects.toThrow();
    try {
      await badType;
    } catch (e) {
      expect((e as Error).message).toMatch(/jobs_type_valid/);
    }

    expect(await countJobs(pool)).toBe(0);
  });

  it("committed jobs survive a connection close and re-open", async () => {
    const cfg = configFor(pool);
    const poolA = new Pool(cfg);
    const repoA = new JobRepository(poolA);
    const direct = new Pool(cfg);
    const id = randomUUID();

    const created = await repoA.createJob({
      id,
      type: "sum_numbers",
      payload: { numbers: [1, 2, 3] },
    });
    expect(created.status).toBe("queued");

    // A separate client sees the committed row immediately.
    const check = await direct.query("SELECT status FROM jobs WHERE id = $1", [id]);
    expect(check.rows[0].status).toBe("queued");
    await direct.end();

    // Now close the repository's pool, reopen with a brand-new pool, read back.
    await poolA.end();
    const reopened = new Pool(cfg);
    const repoB = new JobRepository(reopened);
    try {
      const got = await repoB.getJobById(id);
      expect(got).not.toBeNull();
      expect(got?.status).toBe("queued");
      expect(got?.payload).toEqual({ numbers: [1, 2, 3] });
    } finally {
      await reopened.end();
    }
  });

  it("database failure yields an honest error instead of a fabricated job", async () => {
    const broken = new Pool({
      host: "127.0.0.1",
      port: 1,
      user: "jobeng",
      password: "jobeng-secret",
      database: "job_engine_test",
      connectionTimeoutMillis: 500,
      max: 1,
    });
    try {
      const { app: app2 } = createApp({ pool: broken });
      const res = await request(app2)
        .post("/jobs")
        .send({ type: "sum_numbers", payload: { numbers: [1, 2, 3] } })
        .set("Accept", "application/json");

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("DB_ERROR");
      expect(await countJobs(pool)).toBe(0);
    } finally {
      await broken.end();
    }
  });

  it("/health reports database readiness and 503 when the DB is down", async () => {
    const ok = await request(app).get("/health");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "ok", database: "up" });

    const broken = new Pool({
      host: "127.0.0.1",
      port: 1,
      user: "jobeng",
      password: "jobeng-secret",
      database: "job_engine_test",
      connectionTimeoutMillis: 500,
      max: 1,
    });
    try {
      const { app: app2 } = createApp({ pool: broken });
      const down = await request(app2).get("/health");
      expect(down.status).toBe(503);
      expect(down.body).toMatchObject({ status: "unhealthy", database: "down" });
    } finally {
      await broken.end();
    }
  });

  it("GET / on an unknown route yields a 404", async () => {
    const res = await request(app).get("/totally-unknown");
    expect(res.status).toBe(404);
  });
});
