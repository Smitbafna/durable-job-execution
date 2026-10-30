# Job Engine

A durable job execution engine that persists jobs to PostgreSQL and executes them via
worker processes. The HTTP API and workers are **separate processes** that coordinate
purely through PostgreSQL — no Redis, Kafka, RabbitMQ, or other message brokers.

## Architecture Overview

```
┌──────────────┐     ┌──────────────────┐
│   HTTP API   │────▶│  PostgreSQL      │◀──────┐
│  (port 4700) │     │  (jobs table)    │      │
└──────────────┘     └──────┬───────────┘      │
                            │                    │
                            ▼                    │
                       ┌─────────┐               │
                       │ Workers │               │
                       │ (N procs)│               │
                       └─────────┘               │
                            │                    │
                            ▼                    │
                       ┌─────────┐               │
                       │Handlers │               │
                       │ Registry│               │
                       └─────────┘               │
                            │                    │
                            └─────────────────────┘
                         (claimNextJob via FOR UPDATE SKIP LOCKED)
```

### Core Concepts

- **Job**: A unit of work persisted in PostgreSQL with a lifecycle state.
- **Repository**: All SQL access goes through `JobRepository`, which owns the
  atomic claim/update operations.
- **Worker**: A process that polls PostgreSQL for queued jobs, claims them atomically,
  executes them, and persists the outcome.
- **Handler**: A function that implements the business logic for a specific job type.
  Registered in the handler registry.

## Getting Started

### Prerequisites

- Node.js 20+
- Docker (for PostgreSQL)

### 1. Start PostgreSQL

```bash
docker compose up -d
```

### 2. Set Up Environment

```bash
cp .env.example .env
# Edit .env if needed (defaults work for local dev with docker compose)
```

### 3. Start the API Server

```bash
npm run dev
```

The API listens on `http://127.0.0.1:4700`.

### 4. Start a Worker

```bash
# In a separate terminal:
npm run worker
```

### Running Multiple Workers

Open multiple terminals and run `npm run worker` in each. All workers share the same
PostgreSQL database and coordinate through `FOR UPDATE SKIP LOCKED`. No additional
configuration is needed — each worker gets a random UUID as its `workerId`.

To set a specific worker ID:
```bash
WORKER_ID=my-worker-1 npm run worker
```

### Submitting and Inspecting Jobs

```bash
# Submit a job:
curl -X POST http://127.0.0.1:4700/jobs \
  -H 'content-type: application/json' \
  -d '{"type":"sum_numbers","payload":{"numbers":[1,2,3]}}'

# Get a job by ID:
curl http://127.0.0.1:4700/jobs/<job-id>

# Health check:
curl http://127.0.0.1:4700/health
```

## Job Lifecycle

```
queued ──claim──> running ──success──> succeeded
                    │
                    └─failure───> failed
```

1. **queued**: A job is persisted via `POST /jobs` with status `queued`.
2. **running**: A worker atomically claims the job (flips `queued → running`),
   populates `started_at` and `worker_id`.
3. **succeeded** or **failed**: After execution, the worker updates the status
   and sets `completed_at`.

## Atomic Job Claiming

The critical guarantee is that **a job is never claimed by two workers simultaneously**.
This is achieved in `JobRepository.claimNextJob`:

```sql
BEGIN;

SELECT id FROM jobs
WHERE status = 'queued'
ORDER BY created_at ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

UPDATE jobs
SET status = 'running',
    started_at = now(),
    worker_id = $1,
    updated_at = now()
WHERE id = $2 AND status = 'queued'
RETURNING *;

COMMIT;
```

**Why `FOR UPDATE SKIP LOCKED`?**

- `FOR UPDATE` acquires a row-level lock on the selected job.
- `SKIP LOCKED` tells PostgreSQL to skip rows already locked by other transactions
  (other concurrent claimers) instead of blocking.
- The `SELECT` and `UPDATE` happen in the **same transaction**, so the claim and
  status flip are atomic.
- The transaction commits **before** the job body executes, so no database lock is
  held during job execution.

This means N concurrent workers can all issue `SELECT ... FOR UPDATE SKIP LOCKED`
This means N concurrent workers can all issue `SELECT ... FOR UPDATE SKIP LOCKED`
simultaneously — each gets a different job, and no two workers ever get the same row.

## Worker Configuration

| Variable | Default | Description |
|---|---|---|
| `WORKER_ID` | random UUID per launch | Identifier recorded on each claimed job |
| `WORKER_POLL_INTERVAL_MS` | `1000` | Milliseconds between claim attempts when queue is empty |
| `WORKER_CONCURRENCY` | `5` | Number of concurrent polling loops per worker process |

## Running Tests

```bash
# Unit tests (no database, fast):
npm run test:unit

# Integration + concurrency + e2e tests (requires PostgreSQL via docker compose):
npm run test:integration

# All tests:
npm test
```

## Project Structure

```
job-engine/
├── migrations/             # SQL migrations (applied in filename order)
│   ├── 0001_create_jobs_table.sql   # Initial schema
│   └── 0002_add_worker_id.sql       # Week 2: worker_id column + indexes
├── src/
│   ├── app.ts             # Express app assembly
│   ├── config.ts          # Environment-based configuration
│   ├── errors.ts          # Centralized AppError hierarchy
│   ├── index.ts           # API server entry point (npm run dev / start)
│   ├── domain/
│   │   ├── job.ts         # Job model & JobStatus enum
│   │   ├── jobTypes.ts    # Job type definitions + payload validators
│   │   └── jobTransitions.ts  # State transition rules
│   ├── db/
│   │   ├── pool.ts        # PostgreSQL singleton pool
│   │   ├── migrate.ts     # Dependency-free migration runner
│   │   ├── migrate.cli.ts # CLI entry point for running migrations
│   │   └── repository.ts  # All SQL access (claimNextJob, markSucceeded, etc.)
│   ├── http/
│   │   ├── routes.ts      # Express routes
│   │   ├── serializers.ts # Job → JSON serialization
│   │   ├── validate.ts    # Request validation
│   │   └── errorHandler.ts # Centralized error handler
│   ├── service/
│   │   └── jobService.ts  # Application service (submit + retrieve)
│   └── worker/
│       ├── worker.ts      # Worker class (polling loop, execution, shutdown)
│       ├── workerRunner.ts  # CLI entry point (npm run worker)
│       └── handlers/
│           ├── registry.ts  # Job type → handler dispatch table
│           └── sumNumbersHandler.ts  # sum_numbers implementation
├── test/                   # Integration tests (against real PostgreSQL)
│   ├── helpers.ts          # Test pool + app factory
│   ├── globalSetup.ts      # DB provisioning + migration + teardown
│   ├── claim.test.ts       # Atomic claiming tests
│   ├── concurrency.test.ts # Concurrent claiming tests
│   ├── execution.test.ts   # Execution outcome tests
│   ├── integration.test.ts # Week-1 regression tests
│   └── e2e.test.ts         # End-to-end HTTP → worker → DB tests
└── src/__tests__/          # Unit tests (no database)
    ├── errorHandler.test.ts
    ├── httpValidation.test.ts
    ├── jobTransitions.test.ts
    ├── jobTypes.test.ts
    └── workerHandlers.test.ts
```

## Known Limitations (Week 2)

- **No crash recovery**: If a worker process crashes after claiming a job, that job
  remains in `running` state and is never reprocessed. It will not be auto-recovered.
- **No retries**: Failed jobs are not retried automatically.
- **No leases/heartbeats**: A worker does not renew its claim. If a worker hangs during
  job execution, the job stays `running` indefinitely.
- **Not exactly-once**: Jobs are processed at-least-once by the claiming mechanism,
  but there is no idempotency for handler execution.
- **No job cancellation**: Jobs cannot be cancelled or interrupted once started.

These are future milestones (Week 3 and beyond).

## Artifact Subsystem (M1)

Users can upload source-code ZIP archives through the HTTP API. Artifacts are
validated, checksummed, stored on the local filesystem, and their metadata is
persisted in PostgreSQL.

### Upload API

```bash
curl -X POST http://127.0.0.1:4700/artifacts \\
  -F "file=@my_program.zip"
```

Success (HTTP 201):

```json
{
  "artifactId": "generated-uuid",
  "filename": "my_program.zip",
  "sizeBytes": 2048,
  "sha256": "checksum",
  "createdAt": "timestamp"
}
```

Retrieve metadata:

```bash
curl http://127.0.0.1:4700/artifacts/<artifact-id>
```

### Metadata model

`artifacts` table:

- `id` UUID (primary key)
- `filename` TEXT (sanitized client filename)
- `storage_key` TEXT (unique, generated by the application)
- `size_bytes` BIGINT
- `sha256` TEXT
- `content_type` TEXT
- `created_at` TIMESTAMPTZ

Binary contents are stored on the filesystem, never in PostgreSQL.

### Filesystem storage

- Default directory: `./data/artifacts` (configurable via `ARTIFACT_STORAGE_DIR`).
- Storage lives outside the public/frontend directory.
- Storage keys are generated UUIDs; untrusted filenames are never used as paths.
- Writes use a temporary file plus an exclusive link to avoid overwriting.
- The directory is gitignored (`job-engine/data`).

Artifacts are currently stored on the API host's local filesystem. This is not
shared across multiple machines; distributed/shared storage is a later milestone.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `ARTIFACT_STORAGE_DIR` | `./data/artifacts` | Local storage directory |
| `ARTIFACT_MAX_COMPRESSED_BYTES` | `10485760` | Max compressed upload size |
| `ARTIFACT_MAX_ENTRIES` | `1000` | Max ZIP entries |
| `ARTIFACT_MAX_TOTAL_UNCOMPRESSED_BYTES` | `104857600` | Max total uncompressed size |
| `ARTIFACT_MAX_INDIVIDUAL_UNCOMPRESSED_BYTES` | `52428800` | Max per-entry uncompressed size |

### Validation and security

- Content-based ZIP detection (magic bytes), not extension/MIME alone.
- Structural validation with `yauzl` without extracting.
- Rejects invalid archives, unsupported compression methods, encrypted entries.
- Rejects absolute paths, Windows drive paths, `../` traversal, symlink entries.
- Enforces entry-count and decompressed-size limits (ZIP-bomb mitigation).
- Integer-overflow-safe size accumulation.
- Storage path traversal is prevented; storage keys are application-generated.

Limitations: validation relies on declared sizes and parser metadata; it does not
guarantee protection against every possible malicious archive. Archives are not
executed or extracted in this milestone.

### Integration tests

Run PostgreSQL and tests:

```bash
npm run test:integration
```

Artifact tests use real PostgreSQL and real filesystem storage under a temporary
directory.

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the HTTP API server (with hot-reload via tsx) |
| `npm run worker` | Start a worker process |
| `npm run start` | Start the HTTP API server (compiled JS) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run typecheck` | Type-check all source + tests |
| `npm run migrate` | Apply pending migrations to the configured database |
| `npm run test:unit` | Run unit tests |
| `npm run test:integration` | Start PostgreSQL and run integration tests |
| `npm test` | Run all tests |
simultaneously — each gets a different job, and no two workers ever get the same row.