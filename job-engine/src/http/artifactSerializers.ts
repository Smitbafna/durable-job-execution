import type { Artifact } from "../domain/artifact.js";

export interface ArtifactResponse {
  readonly artifactId: string;
  readonly filename: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly createdAt: string;
}

export function serializeArtifact(artifact: Artifact): ArtifactResponse {
  return {
    artifactId: artifact.id,
    filename: artifact.filename,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt.toISOString(),
  };
}