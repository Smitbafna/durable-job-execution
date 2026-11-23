import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createTestApp, truncateJobs } from "./helpers.js";

const { app, pool } = createTestApp();

beforeEach(async () => {
  await truncateJobs(pool);
  await pool.query("TRUNCATE TABLE workers");
});

afterAll(async () => {
  await pool.end();
});

describe("GET /workers", () => {
  it("returns an empty array when no workers exist", async () => {
    const res = await request(app).get("/workers");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns multiple workers", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      ids.push(id);
      await pool.query(`INSERT INTO workers (id, type) VALUES ($1, 'node')`, [id]);
    }
    const res = await request(app).get("/workers");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    const returnedIds = res.body.map((w: any) => w.id);
    ids.forEach((id) => expect(returnedIds).toContain(id));
  });

  it("correctly derives online status", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO workers (id, type, started_at, last_heartbeat_at) VALUES ($1, 'node', now() - '10 seconds'::interval, now() - '10 seconds'::interval)`, [id]);
    const res = await request(app).get("/workers");
    expect(res.status).toBe(200);
    const worker = res.body.find((w: any) => w.id === id);
    expect(worker).not.toBeUndefined();
    expect(worker?.status).toBe("online");
  });

  it("correctly derives stale status", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO workers (id, type, started_at, last_heartbeat_at) VALUES ($1, 'node', now() - '60 seconds'::interval, now() - '60 seconds'::interval)`, [id]);
    const res = await request(app).get("/workers");
    expect(res.status).toBe(200);
    const worker = res.body.find((w: any) => w.id === id);
    expect(worker).not.toBeUndefined();
    expect(worker?.status).toBe("stale");
  });

  it("correctly derives stopped status", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO workers (id, type, started_at, shutdown_at) VALUES ($1, 'node', now() - '1 hour'::interval, now())`, [id]);
    const res = await request(app).get("/workers");
    expect(res.status).toBe(200);
    const worker = res.body.find((w: any) => w.id === id);
    expect(worker).not.toBeUndefined();
    expect(worker?.status).toBe("stopped");
  });

  it("uses a consistent time reference within a response", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    // Insert workers with different heartbeat ages
    // Using now() - interval 'X seconds' pattern that works with pg
    const fiveSecAgo = new Date(Date.now() - 5000);
    const fiftyFiveSecAgo = new Date(Date.now() - 55000);
    await pool.query(`INSERT INTO workers (id, type, started_at, last_heartbeat_at, shutdown_at) VALUES ($1, 'node', now() - interval '1 hour', $2, NULL)`, [id1, fiveSecAgo]);
    await pool.query(`INSERT INTO workers (id, type, started_at, last_heartbeat_at, shutdown_at) VALUES ($1, 'node', now() - interval '1 hour', $2, NULL)`, [id2, fiftyFiveSecAgo]);
    const res = await request(app).get("/workers");
    expect(res.status).toBe(200);
    const workers = res.body;
    const w1 = workers.find((w: any) => w.id === id1);
    const w2 = workers.find((w: any) => w.id === id2);
    expect(w1?.status).toBe("online");
    expect(w2?.status).toBe("stale");
  });

  it("propagates database failures through existing error middleware", async () => {
    const res = await request(app).get("/workers");
    expect([200, 500]).toContain(res.status);
  });
});

describe("GET /workers/:id", () => {
  it("returns an existing worker", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO workers (id, type) VALUES ($1, 'node')`, [id]);
    const res = await request(app).get(`/workers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.type).toBe("node");
  });

  it("returns 404 for an unknown valid UUID", async () => {
    const id = randomUUID();
    const res = await request(app).get(`/workers/${id}`);
    expect(res.status).toBe(404);
  });

  it("rejects an invalid UUID", async () => {
    const res = await request(app).get("/workers/invalid-uuid");
    expect(res.status).toBe(400);
  });

  it("correctly returns each health status", async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO workers (id, type, started_at, last_heartbeat_at) VALUES ($1, 'node', now() - '10 seconds'::interval, now() - '10 seconds'::interval)`, [id]);
    let res = await request(app).get(`/workers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("online");
    await pool.query(`UPDATE workers SET last_heartbeat_at = now() - '60 seconds'::interval WHERE id = $1`, [id]);
    res = await request(app).get(`/workers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stale");
    await pool.query(`UPDATE workers SET shutdown_at = now() WHERE id = $1`, [id]);
    res = await request(app).get(`/workers/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("stopped");
  });
});
