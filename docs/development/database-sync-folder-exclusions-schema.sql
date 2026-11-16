-- Explicit local folder exclusions survive physical folder removal.
CREATE TABLE sync_collection_exclusions (
  binding_id TEXT NOT NULL REFERENCES zotero_bindings(id),
  collection_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (binding_id, collection_key)
) STRICT;
