-- Migration 0005: promote bibliographic fields without changing resource identity,
-- content versions, fingerprints or revision history. Apply after migrations 0001-0004.
SELECT 'NON_TEXT_BIBLIOGRAPHIC_FIELD' AS cycle
WHERE EXISTS (
  SELECT 1 FROM knowledge_resources
  WHERE coalesce(json_type(metadata_json, '$.fields.publicationTitle'), 'null') NOT IN ('text', 'null')
     OR coalesce(json_type(metadata_json, '$.fields.volume'), 'null') NOT IN ('text', 'null')
     OR coalesce(json_type(metadata_json, '$.fields.issue'), 'null') NOT IN ('text', 'null')
     OR coalesce(json_type(metadata_json, '$.fields.DOI'), 'null') NOT IN ('text', 'null')
);

ALTER TABLE knowledge_resources ADD COLUMN publication_title TEXT;
ALTER TABLE knowledge_resources ADD COLUMN volume TEXT;
ALTER TABLE knowledge_resources ADD COLUMN issue TEXT;
ALTER TABLE knowledge_resources ADD COLUMN doi TEXT;

UPDATE knowledge_resources
SET publication_title = nullif(json_extract(metadata_json, '$.fields.publicationTitle'), ''),
    volume = nullif(json_extract(metadata_json, '$.fields.volume'), ''),
    issue = nullif(json_extract(metadata_json, '$.fields.issue'), ''),
    doi = nullif(json_extract(metadata_json, '$.fields.DOI'), ''),
    metadata_json = json_remove(metadata_json, '$.fields.publicationTitle', '$.fields.volume', '$.fields.issue', '$.fields.DOI'),
    metadata_schema_version = 2;
