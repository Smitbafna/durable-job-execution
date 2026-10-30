-- Job Engine — M1: artifact metadata.
--
-- Stores metadata for uploaded ZIP artifacts. Binary contents live on the local
-- filesystem under ARTIFACT_STORAGE_DIR; only metadata and a generated storage
-- key are persisted here.

CREATE TABLE artifacts (
  id             UUID PRIMARY KEY,
  filename       TEXT NOT NULL CHECK (length(filename) > 0 AND length(filename) <= 255),
  storage_key    TEXT NOT NULL UNIQUE,
  size_bytes     BIGINT NOT NULL CHECK (size_bytes >= 0),
  sha256         TEXT NOT NULL CHECK (length(sha256) = 64),
  content_type   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_artifacts_created_at ON artifacts (created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_sha256 ON artifacts (sha256);