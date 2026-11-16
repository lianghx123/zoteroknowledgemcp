-- Derived bibliography numbering and multi-block entry provenance.
ALTER TABLE resource_references ADD COLUMN reference_number INTEGER
  CHECK (reference_number IS NULL OR reference_number >= 0);
ALTER TABLE resource_references ADD COLUMN entry_order INTEGER
  CHECK (entry_order IS NULL OR entry_order >= 0);
CREATE UNIQUE INDEX uq_reference_generation ON resource_references(id, generation_id);
CREATE TABLE content_reference_projections (
  generation_id TEXT PRIMARY KEY NOT NULL REFERENCES content_generations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  completed_at INTEGER NOT NULL
) STRICT;
CREATE TABLE reference_source_blocks (
  reference_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (reference_id, block_id),
  UNIQUE (reference_id, ordinal),
  FOREIGN KEY (reference_id, generation_id) REFERENCES resource_references(id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (block_id, generation_id) REFERENCES content_blocks(id, generation_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX ix_reference_source_generation ON reference_source_blocks(generation_id, block_id);
