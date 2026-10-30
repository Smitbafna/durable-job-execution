/** Storage abstraction for artifact bytes. */

export interface StoredArtifact {
  readonly storageKey: string;
}

export interface ArtifactStorage {
  store(artifactId: string, data: Buffer): Promise<StoredArtifact>;
  retrieve(storageKey: string): Promise<Buffer>;
  materialize(storageKey: string, destinationPath: string): Promise<void>;
  delete(storageKey: string): Promise<void>;
}