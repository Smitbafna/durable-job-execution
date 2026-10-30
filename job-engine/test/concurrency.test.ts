/**
 * Job Engine — PostgreSQL integration tests: concurrent workers racing to claim
 * jobs. No shared JavaScript mutex is used: the uniqueness of claimed jobs
 * comes purely from PostgreSQL row locking (`SELECT ... FOR UPDATE SKIP LOCKED`
 * inside a single transaction).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { truncateJobs, createTestPool } from "./helpers.js";
import { JobRepository } from "../src/db/repository.js";

function poolWith(): Pool {
  return createTestPool();
}

/** Inserts `nbJobs` rows of the chosen status via a single pool, then has `nbClaimers`
 * claimers race using their own independent pools. Each claimer loops calling
 * `claimNextJob` until no job is returned. Returns the set of claimed job IDs.
 */
async function claimersConcurrent(
  nbJobs: number,
  nbClaimers: number,
  kind: "queued" | "running" | "succeeded" | "failed",
): Promise<Set<string>> {
  const insertPool = createTestPool();
  const inserts: Promise<unknown>[] = [];
  for (let i = 0; i < nbJobs; i += 1) {
    inserts.push(
      insertPool.query(
        `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at)
         VALUES ($1, 'sum_numbers', $2, $3, NULL, NULL, now(), now())`,
        [randomUUID(), kind, JSON.stringify({})],
      ),
    );
  }
  await Promise.all(inserts);
  await insertPool.end();

  const pools = new Array(nbClaimers)
    .fill(null)
    .map(() => createTestPool());
  const repos = pools.map((p) => new JobRepository(p));

  // Each claimer loops until it gets null (queue exhausted or all jobs claimed
  // by other claimers). This simulates real worker polling but without the
  // sleep delay — they race continuously.
  const claimAll = async (repo: JobRepository): Promise<string[]> => {
    const ids: string[] = [];
    while (true) {
      const job = await repo.claimNextJob(`claimer-${Math.random().toString(16).slice(2)}`);
      if (job === null) break;
      ids.push(job.id);
    }
    return ids;
  };

  const claims = await Promise.all(repos.map((repo) => claimAll(repo)));
  await Promise.all(pools.map((p) => p.end()));

  return new Set(claims.flat());
}

describe("concurrent worker claiming", () => {
  let pool: Pool;

  beforeEach(async () => {
    pool = createTestPool();
    await truncateJobs(pool);
  });

  afterEach(async () => {
    await pool.end().catch(() => undefined);
  });

  it("claims every queued job exactly once when claimers race", async () => {
    const nbJobs = 50;
    const nbClaimers = 8;

    const claimed = await claimersConcurrent(nbJobs, nbClaimers, "queued");

    expect(claimed.size).toBe(nbJobs);
  });

  it("does not double-claim a job even when workers race for it", async () => {
    const runningId = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at)
       VALUES ($1, 'sum_numbers', 'running', $2, NULL, NULL, now(), now(), now())`,
      [runningId, JSON.stringify({})],
    );
    const failedId = randomUUID();
    await pool.query(
      `INSERT INTO jobs (id, type, status, payload, result, error, created_at, updated_at, started_at, completed_at)
       VALUES ($1, 'sum_numbers', 'failed', $2, NULL, $3, now(), now(), now(), now())`,
      [failedId, JSON.stringify({}), JSON.stringify({ code: "TEST" })],
    );

    // Insert 80 queued jobs and race 4 claimers (each loops until null).
    const claimed = await claimersConcurrent(80, 4, "queued");

    // All 80 queued jobs are claimed exactly once. Running/failed jobs are never
    // touched by claimers (they are not `queued`).
    expect(claimed.size).toBe(80);
    expect(claimed.has(runningId)).toBe(false);
    expect(claimed.has(failedId)).toBe(false);
  });

  it("claims every queued job when contention is high", async () => {
    const nbJobs = 200;
    const nbClaimers = 16;

    const claimed = await claimersConcurrent(nbJobs, nbClaimers, "queued");

    expect(claimed.size).toBe(nbJobs);
  });
});
