-- Step 4 design fixture. Apply after database-schema.sql in a disposable database.
-- FTS5 and the tokenizer must be verified in Zotero before an installed migration.
-- unicode61 is the pilot baseline, not a claim of Chinese tokenizer parity.
CREATE VIRTUAL TABLE search_fts USING fts5(
  title,
  contributors,
  body,
  search_text,
  content = 'search_documents',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER search_document_insert AFTER INSERT ON search_documents
BEGIN
  INSERT INTO search_fts(rowid, title, contributors, body, search_text)
  VALUES (NEW.rowid, NEW.title, NEW.contributors, NEW.body, NEW.search_text);
END;
CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents
BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, contributors, body, search_text)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.contributors, OLD.body, OLD.search_text);
END;
CREATE TRIGGER search_document_update AFTER UPDATE ON search_documents
BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, contributors, body, search_text)
  VALUES ('delete', OLD.rowid, OLD.title, OLD.contributors, OLD.body, OLD.search_text);
  INSERT INTO search_fts(rowid, title, contributors, body, search_text)
  VALUES (NEW.rowid, NEW.title, NEW.contributors, NEW.body, NEW.search_text);
END;

-- Required when existing projection rows predate installation of this index.
INSERT INTO search_fts(search_fts) VALUES ('rebuild');
