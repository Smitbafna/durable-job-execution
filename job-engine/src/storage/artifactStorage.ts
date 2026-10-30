/** Storage abstraction for artifact bytes. */

export interface StoredArtifact {
  readonly storageKey: string;
}

export interface ArtifactStorage {
  store(artifactId: string, data: Buffer): Promise<StoredArtifact>;
  retrieve(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
}