-- Derived visual relationships leave published canonical blocks immutable.
CREATE TABLE content_visual_projections (
  generation_id TEXT PRIMARY KEY NOT NULL REFERENCES content_generations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  completed_at INTEGER NOT NULL
) STRICT;

CREATE TABLE content_visual_links (
  id TEXT PRIMARY KEY NOT NULL,
  generation_id TEXT NOT NULL REFERENCES content_generations(id) ON DELETE CASCADE,
  visual_block_id TEXT NOT NULL,
  related_block_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('caption', 'note', 'body')),
  position TEXT NOT NULL CHECK (position IN ('before', 'after', 'content')),
  evidence TEXT NOT NULL CHECK (evidence IN ('provider', 'layout', 'adjacency')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content_markdown TEXT,
  created_at INTEGER NOT NULL,
  CHECK ((related_block_id IS NOT NULL AND content_markdown IS NULL AND role <> 'body') OR
         (related_block_id IS NULL AND content_markdown IS NOT NULL AND evidence = 'provider')),
  CHECK ((role = 'body' AND position = 'content') OR (role <> 'body' AND position <> 'content')),
  CHECK (related_block_id IS NULL OR related_block_id <> visual_block_id),
  UNIQUE (related_block_id),
  UNIQUE (visual_block_id, role, ordinal),
  FOREIGN KEY (visual_block_id, generation_id) REFERENCES content_blocks(id, generation_id) ON DELETE CASCADE,
  FOREIGN KEY (related_block_id, generation_id) REFERENCES content_blocks(id, generation_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX ix_visual_link_generation ON content_visual_links(generation_id, visual_block_id);
