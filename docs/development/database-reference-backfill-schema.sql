-- Migration 0011: preserve each parser reference block as a bibliography record.
-- The block UUID is also its derived reference UUID. Existing records, including
-- explicit tombstones, take precedence. Text and locations remain authoritative
-- in the immutable source block; no bibliographic fields are inferred.
INSERT INTO resource_references (
  id, resource_id, source_id, generation_id, source_block_id, reference_type,
  raw_text, created_at, updated_at
)
SELECT b.id, g.resource_id, g.source_id, g.id, b.id, 'bibliography',
  b.content_markdown, b.created_at, b.created_at
FROM content_blocks AS b
JOIN content_generations AS g ON g.id = b.generation_id
WHERE g.origin = 'parse' AND g.state IN ('ready', 'partial', 'superseded')
  AND b.block_type IN ('reference', 'reference_entry', 'bibliography')
  AND length(trim(b.content_markdown)) > 0
  AND NOT EXISTS (SELECT 1 FROM resource_references AS r WHERE r.id = b.id)
  AND NOT EXISTS (
    SELECT 1 FROM resource_references AS r
    WHERE r.source_block_id = b.id AND r.reference_type = 'bibliography'
  );
