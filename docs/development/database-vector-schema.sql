-- Migration 0009. Derived embedding segments preserve published content unchanged.
CREATE TABLE embedding_segments (
  id TEXT PRIMARY KEY NOT NULL,
  block_id TEXT NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL REFERENCES embedding_profiles(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset >= start_offset),
  overlap INTEGER NOT NULL CHECK (overlap >= 0),
  input_text TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  skip_reason TEXT,
  embedding_id TEXT REFERENCES block_embeddings(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (block_id, profile_id, ordinal)
) STRICT;
CREATE INDEX ix_segment_embedding ON embedding_segments(embedding_id);
CREATE INDEX ix_segment_profile ON embedding_segments(profile_id, block_id);
CREATE TABLE vector_snapshot_state (
  profile_id TEXT PRIMARY KEY NOT NULL REFERENCES embedding_profiles(id),
  build_id TEXT REFERENCES search_index_builds(id) ON DELETE SET NULL,
  format_version INTEGER NOT NULL DEFAULT 1,
  mode TEXT NOT NULL CHECK (mode IN ('f32', 'i8')),
  snapshot_path TEXT,
  snapshot_hash TEXT,
  snapshot_bytes INTEGER,
  corpus_hash TEXT,
  mutations INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
) STRICT;
