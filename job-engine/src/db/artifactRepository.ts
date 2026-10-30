import type { Pool, QueryResult } from "pg";
import { AppError, AppErrorCode, toAppError } from "../errors.js";
import type { Artifact } from "../domain/artifact.js";

export interface CreateArtifactInput {
  readonly id: string;
  readonly filename: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentType: string;
}

interface ArtifactRow {
  id: string;
  filename: string;
  storage_key: string;
  size_bytes: string | number;
  sha256: string;
  content_type: string;
  created_at: Date;
}

function mapRow(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    filename: row.filename,
    storageKey: row.storage_key,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    contentType: row.content_type,
    createdAt: row.created_at,
  };
}

export class ArtifactRepository {
  constructor(private readonly pool: Pool) {}

  async createArtifact(input: CreateArtifactInput): Promise<Artifact> {
    try {
      const res: QueryResult<ArtifactRow> = await this.pool.query<ArtifactRow>(
        `INSERT INTO artifacts (id, filename, storage_key, size_bytes, sha256, content_type)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          input.id,
          input.filename,
          input.storageKey,
          input.sizeBytes,
          input.sha256,
          input.contentType,
        ],
      );
      const row = res.rows[0];
      if (row === undefined) {
        throw new AppError(AppErrorCode.DbError, 500, "Artifact creation returned no row");
      }
      return mapRow(row);
    } catch (e) {
      throw toAppError(e);
    }
  }

  async getArtifactById(id: string): Promise<Artifact | null> {
    try {
      const res: QueryResult<ArtifactRow> = await this.pool.query<ArtifactRow>(
        `SELECT * FROM artifacts WHERE id = $1`,
        [id],
      );
      if (res.rows.length === 0) return null;
      return mapRow(res.rows[0]);
    } catch (e) {
      throw toAppError(e);
    }
  }
}