/** Artifact domain model. */

export interface Artifact {
  readonly id: string;
  readonly filename: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly createdAt: Date;
}