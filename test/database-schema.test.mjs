// Development-only SQLite design validation. Never imported by the Zotero bundle.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { treeFixture, treeTables } from "./helpers/tree-integrity.mjs";

const fixtureNames = ["database-schema.sql", "database-search-schema.sql", "database-mcp-schema.sql", "database-tree-integrity-schema.sql", "database-bibliographic-schema.sql", "database-trash-schema.sql"];
const fixtures = fixtureNames.map(name => readFileSync(new URL(`../docs/development/${name}`, import.meta.url), "utf8"));
const now = 1792368000000;
const hash = "a".repeat(64);

function database(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const sql of fixtures) db.exec(sql);
  return db;
}

function insert(db, table, values) {
  const fields = Object.keys(values);
  db.prepare(`INSERT INTO ${table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`)
    .run(...Object.values(values));
  return values;
}

function resource(db) {
  return insert(db, "knowledge_resources", {
    id: randomUUID(), title: "Fixture paper", resource_type: "journalArticle",
    metadata_authority: "zotero", created_at: now, updated_at: now,
  });
}

function source(db, parent, overrides = {}) {
  return insert(db, "resource_sources", {
    id: randomUUID(), resource_id: parent.id, source_type: "imported_text",
    source_role: "primary_document", availability: "available", text_content: "Fixture input",
    source_fingerprint: hash, fingerprint_algorithm: "sha256:text-v1",
    created_at: now, updated_at: now, ...overrides,
  });
}

function generation(db, input, overrides = {}) {
  return insert(db, "content_generations", {
    id: randomUUID(), resource_id: input.resource_id, source_id: input.id,
    base_content_version: 0, content_version: 1, source_version: 1,
    source_fingerprint: hash, origin: "import", normalizer_version: "fixture-v1",
    created_by_type: "system", created_at: now, ...overrides,
  });
}

function block(db, gen, overrides = {}) {
  return insert(db, "content_blocks", {
    id: randomUUID(), generation_id: gen.id, block_type: "text", canonical_order: 0,
    content_markdown: "Structured fixture text", content_hash: hash, source_type: "import",
    created_at: now, ...overrides,
  });
}

function publish(db, gen) {
  db.prepare("UPDATE content_generations SET state = 'ready', content_fingerprint = ?, published_at = ? WHERE id = ?")
    .run(hash, now, gen.id);
  db.prepare("UPDATE resource_sources SET active_generation_id = ?, content_version = ? WHERE id = ?")
    .run(gen.id, gen.content_version, gen.source_id);
}

function library(db, name = randomUUID()) {
  return insert(db, "knowledge_libraries", { id: randomUUID(), name, created_at: now, updated_at: now });
}

function folder(db, lib, overrides = {}) {
  return insert(db, "library_nodes", {
    id: randomUUID(), library_id: lib.id, node_type: "folder", name: randomUUID(),
    sort_order: 0, created_at: now, updated_at: now, ...overrides,
  });
}

function job(db, input, overrides = {}) {
  return insert(db, "processing_jobs", {
    id: randomUUID(), kind: "parse", dedup_key: randomUUID(), resource_id: input.resource_id,
    source_id: input.id, expected_source_version: 1, input_fingerprint: hash,
    next_run_at: now, created_at: now, updated_at: now, ...overrides,
  });
}

function claim(db, id, token, time = now) {
  return db.prepare(`UPDATE processing_jobs SET state = 'running', lease_owner = 'fixture',
    execution_token = ?, lease_expires_at = ?, started_at = coalesce(started_at, ?),
    heartbeat_at = ?, attempt_count = attempt_count + 1
    WHERE id = ? AND state IN ('pending', 'waiting', 'retry_wait')
      AND next_run_at <= ? AND cancel_requested_at IS NULL`)
    .run(token, time + 1000, time, time, id, time).changes;
}

function profile(db, dimensions = 2) {
  const provider = insert(db, "provider_profiles", {
    id: randomUUID(), name: "Fixture provider", kind: "embedding", adapter_key: "fixture",
    adapter_version: "1", endpoint_url: "https://provider.invalid/v1",
    configuration_hash: hash, created_at: now,
  });
  return insert(db, "embedding_profiles", {
    id: randomUUID(), profile_key: randomUUID(), provider_profile_id: provider.id,
    model: "fixture", dimensions, input_template_version: "1", admission_version: "1",
    configuration_hash: hash, created_at: now,
  });
}

test("database design fixtures create a strict isolated schema with valid foreign keys", t => {
  const db = database(t);
  assert.equal(db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.throws(() => insert(db, "plugin_state", { key: "bad", value_json: "not JSON", updated_at: now }));
});

test("schema fixtures reserve standard Kysely metadata without claiming installed migrations", t => {
  const db = database(t);
  assert.equal(db.prepare("SELECT count(*) AS total FROM kysely_migration").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) AS total FROM kysely_migration_lock").get().total, 0);
  assert.equal(db.prepare("SELECT count(*) AS total FROM sqlite_schema WHERE name = 'schema_migrations'").get().total, 0);
  assert.deepEqual(db.prepare("PRAGMA table_info(kysely_migration)").all().map(column => column.name), ["name", "timestamp"]);
  insert(db, "kysely_migration", { name: "0001-fixture-only", timestamp: "2026-10-19T00:00:00.000Z" });
  assert.throws(() => insert(db, "kysely_migration", { name: "0001-fixture-only", timestamp: "2026-10-19T01:00:00.000Z" }), /UNIQUE/);
  insert(db, "kysely_migration_lock", { id: "migration_lock" });
  assert.equal(db.prepare("SELECT is_locked FROM kysely_migration_lock WHERE id = 'migration_lock'").get().is_locked, 0);
});

test("timestamps, categories and boolean flags enforce SQLite types and allowed values", t => {
  const db = database(t);
  const paper = resource(db);
  assert.throws(() => db.prepare("UPDATE knowledge_resources SET created_at='not a timestamp' WHERE id=?").run(paper.id), /INTEGER/);
  assert.throws(() => db.prepare("UPDATE knowledge_resources SET status='anything' WHERE id=?").run(paper.id), /CHECK/);
  const lib = library(db);
  assert.throws(() => db.prepare("UPDATE knowledge_libraries SET is_default=2 WHERE id=?").run(lib.id), /CHECK/);
  db.prepare("UPDATE knowledge_resources SET publication_date='Spring 2026',volume='S1',issue='3–4' WHERE id=?").run(paper.id);
  assert.equal(db.prepare("SELECT typeof(created_at) value FROM knowledge_resources WHERE id=?").get(paper.id).value, "integer");
});

test("one resource retains separate attachment sources and rejects a foreign canonical source", t => {
  const db = database(t);
  const paper = resource(db);
  const first = source(db, paper, { source_type: "zotero_attachment", text_content: null });
  const second = source(db, paper, { source_type: "zotero_attachment", text_content: null });
  db.prepare("UPDATE knowledge_resources SET canonical_source_id = ? WHERE id = ?").run(first.id, paper.id);
  assert.equal(db.prepare("SELECT count(*) AS total FROM resource_sources WHERE resource_id = ?").get(paper.id).total, 2);
  assert.notEqual(first.id, second.id);
  const foreign = source(db, resource(db));
  assert.throws(() => db.prepare("UPDATE knowledge_resources SET canonical_source_id = ? WHERE id = ?").run(foreign.id, paper.id), /FOREIGN KEY/);
});

test("active generation must be published and scoped to the source at its content version", t => {
  const db = database(t);
  const input = source(db, resource(db));
  const gen = generation(db, input);
  assert.throws(() => db.prepare("UPDATE resource_sources SET active_generation_id = ?, content_version = 1 WHERE id = ?").run(gen.id, input.id), /INVALID_ACTIVE_GENERATION/);
  block(db, gen);
  publish(db, gen);
  assert.equal(db.prepare("SELECT active_generation_id FROM resource_sources WHERE id = ?").get(input.id).active_generation_id, gen.id);
  assert.throws(() => db.prepare("UPDATE resource_sources SET content_version = 2 WHERE id = ?").run(input.id), /INVALID_ACTIVE_GENERATION|INVALID_CONTENT_VERSION_ADVANCE/);
  assert.throws(() => db.prepare("UPDATE content_generations SET state = 'superseded' WHERE id = ?").run(gen.id), /ACTIVE_GENERATION/);
});

test("a rolled-back publication preserves the readable generation and does not enqueue work", t => {
  const db = database(t);
  const input = source(db, resource(db));
  const original = generation(db, input);
  block(db, original);
  publish(db, original);
  const replacement = generation(db, input, { base_generation_id: original.id, base_content_version: 1, content_version: 2 });
  block(db, replacement);
  db.exec("BEGIN");
  try {
    publish(db, replacement);
    job(db, input, { kind: "index", dedup_key: "atomic-publication" });
    throw new Error("Injected failure before commit");
  } catch {
    db.exec("ROLLBACK");
  }
  assert.equal(db.prepare("SELECT active_generation_id FROM resource_sources WHERE id = ?").get(input.id).active_generation_id, original.id);
  assert.equal(db.prepare("SELECT state FROM content_generations WHERE id = ?").get(replacement.id).state, "staging");
  assert.equal(db.prepare("SELECT count(*) AS total FROM processing_jobs").get().total, 0);
});

test("published content is immutable and a new edit generation can supersede it", t => {
  const db = database(t);
  const input = source(db, resource(db));
  const original = generation(db, input);
  const originalBlock = block(db, original);
  publish(db, original);
  assert.throws(() => db.prepare("UPDATE content_blocks SET content_markdown = 'overwrite' WHERE id = ?").run(originalBlock.id), /GENERATION_NOT_STAGING/);
  const edit = generation(db, input, { origin: "edit", base_generation_id: original.id, base_content_version: 1, content_version: 2 });
  block(db, edit, { supersedes_block_id: originalBlock.id, content_markdown: "Edited text" });
  publish(db, edit);
  db.prepare("UPDATE content_generations SET state = 'superseded' WHERE id = ?").run(original.id);
  assert.throws(() => db.prepare("UPDATE content_generations SET state = 'staging' WHERE id = ?").run(original.id), /INVALID_GENERATION_TRANSITION/);
  assert.throws(() => db.prepare("UPDATE content_generations SET page_manifest_json = '[{}]' WHERE id = ?").run(original.id), /PUBLISHED_GENERATION_IMMUTABLE/);
  assert.equal(db.prepare("SELECT content_markdown FROM content_blocks WHERE id = ?").get(originalBlock.id).content_markdown, "Structured fixture text");
});

test("blocks and annotation targets cannot cross content generations or resources", t => {
  const db = database(t);
  const input = source(db, resource(db));
  const gen = generation(db, input);
  const otherInput = source(db, resource(db));
  const otherGen = generation(db, otherInput);
  const otherBlock = block(db, otherGen);
  const otherNode = insert(db, "structure_nodes", {
    id: randomUUID(), generation_id: otherGen.id, node_type: "root", path: "/",
    depth: 0, sort_order: 0, source_type: "import", created_at: now,
  });
  assert.throws(() => block(db, gen, { structure_node_id: otherNode.id, local_order: 0 }), /FOREIGN KEY/);
  assert.throws(() => insert(db, "resource_annotations", {
    id: randomUUID(), resource_id: input.resource_id, source_id: input.id, generation_id: gen.id,
    content_block_id: otherBlock.id, resource_version: 1, annotation_type: "question",
    text: "Scoped note", created_by_type: "user", created_at: now, updated_at: now,
  }), /FOREIGN KEY/);
  assert.throws(() => block(db, gen, { page_start: 5, page_end: 2 }), /CHECK/);
  block(db, gen, { page_start: null, page_end: null });
});

test("a competing published generation cannot claim the same source content version", t => {
  const db = database(t);
  const input = source(db, resource(db));
  const first = generation(db, input);
  const competing = generation(db, input);
  publish(db, first);
  assert.throws(() => publish(db, competing), /UNIQUE/);
});

test("switching to an older generation cannot rewind a source content version", t => {
  const db = database(t);
  const input = source(db, resource(db));
  const first = generation(db, input);
  publish(db, first);
  const next = generation(db, input, { base_generation_id: first.id, base_content_version: 1, content_version: 2 });
  publish(db, next);
  assert.throws(() => db.prepare("UPDATE resource_sources SET active_generation_id = ?, content_version = 1 WHERE id = ?").run(first.id, input.id), /INVALID_CONTENT_VERSION_ADVANCE/);
});

test("library placements reject cross-library nodes and parent cycles", t => {
  const db = database(t);
  const lib = library(db);
  const foreignLib = library(db);
  const parent = folder(db, lib);
  const child = folder(db, lib, { parent_id: parent.id });
  const foreignNode = folder(db, foreignLib);
  const paper = resource(db);
  const membership = insert(db, "library_resources", { id: randomUUID(), library_id: lib.id, resource_id: paper.id, added_at: now });
  assert.throws(() => insert(db, "library_items", {
    id: randomUUID(), library_id: lib.id, node_id: foreignNode.id,
    library_resource_id: membership.id, sort_order: 0, added_at: now,
  }), /FOREIGN KEY/);
  assert.throws(() => db.prepare("UPDATE library_nodes SET parent_id = ? WHERE id = ?").run(child.id, parent.id), /LIBRARY_NODE_CYCLE/);
});

for (const table of treeTables) {
  test(`${table} rejects two- and three-node bulk insert cycles atomically`, t => {
    const db = database(t);
    const insertTree = treeFixture(db, table);
    // A valid bulk insert may refer to parents that appear later in the statement.
    insertTree([1, 2, null], "valid");
    for (const parents of [[1, 0], [1, 2, 0]]) {
      assert.throws(() => insertTree(parents, "cycle"), /(?:NODE|PARENT)_CYCLE/);
      assert.equal(db.prepare(`SELECT count(*) AS total FROM ${table}`).get().total, 3);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
}

test("removing a native origin can preserve an independent manual membership", t => {
  const db = database(t);
  const lib = library(db);
  const paper = resource(db);
  const native = insert(db, "zotero_libraries", {
    id: randomUUID(), library_type: "user", local_library_id: 1, display_name: "My Library",
    is_editable: 1, files_editable: 1, availability: "available", last_checked_at: now,
    created_at: now, updated_at: now,
  });
  const binding = insert(db, "zotero_bindings", {
    id: randomUUID(), zotero_library_id: native.id, knowledge_library_id: lib.id,
    scope_type: "library", created_at: now, updated_at: now,
  });
  const link = insert(db, "zotero_item_links", {
    id: randomUUID(), zotero_library_id: native.id, item_key: "ABCD1234", item_kind: "regular",
    resource_id: paper.id, is_anchor: 1, state: "current", last_seen_at: now, created_at: now, updated_at: now,
  });
  const relation = insert(db, "library_resources", { id: randomUUID(), library_id: lib.id, resource_id: paper.id, added_at: now });
  for (const origin of ["manual", "zotero"]) {
    insert(db, "membership_origins", {
      id: randomUUID(), origin_key: randomUUID(), library_id: lib.id, resource_id: paper.id,
      library_resource_id: relation.id, origin_type: origin,
      binding_id: origin === "zotero" ? binding.id : null,
      item_link_id: origin === "zotero" ? link.id : null, created_at: now, updated_at: now,
    });
  }
  db.prepare("UPDATE membership_origins SET deleted_at = ? WHERE binding_id = ?").run(now, binding.id);
  assert.equal(db.prepare("SELECT count(*) AS total FROM membership_origins WHERE library_resource_id = ? AND deleted_at IS NULL").get(relation.id).total, 1);
  assert.ok(db.prepare("SELECT id FROM knowledge_resources WHERE id = ?").get(paper.id));
});

test("live jobs deduplicate while an explicit new run is possible after completion", t => {
  const db = database(t);
  const input = source(db, resource(db));
  const first = job(db, input, { dedup_key: "same-input" });
  assert.throws(() => job(db, input, { dedup_key: "same-input" }), /UNIQUE/);
  db.prepare("UPDATE processing_jobs SET state = 'succeeded', finished_at = ? WHERE id = ?").run(now, first.id);
  job(db, input, { dedup_key: "same-input" });
  assert.equal(db.prepare("SELECT count(*) AS total FROM processing_jobs").get().total, 2);
});

test("only one claim succeeds and an expired attempt cannot complete after reclaim", t => {
  const db = database(t);
  const work = job(db, source(db, resource(db)));
  assert.equal(claim(db, work.id, "old"), 1);
  assert.equal(claim(db, work.id, "competing"), 0);
  db.prepare(`UPDATE processing_jobs SET state = 'pending', lease_owner = NULL,
    execution_token = NULL, lease_expires_at = NULL
    WHERE id = ? AND execution_token = ? AND lease_expires_at <= ?`).run(work.id, "old", now + 1001);
  assert.equal(claim(db, work.id, "new", now + 1001), 1);
  const complete = db.prepare(`UPDATE processing_jobs SET state = 'succeeded', finished_at = ?,
    lease_owner = NULL, execution_token = NULL, lease_expires_at = NULL
    WHERE id = ? AND state = 'running' AND execution_token = ?
      AND lease_expires_at > ? AND cancel_requested_at IS NULL`);
  assert.equal(complete.run(now + 1002, work.id, "old", now + 1002).changes, 0);
  assert.equal(complete.run(now + 1002, work.id, "new", now + 1002).changes, 1);
});

test("waiting for a remote parse preserves identity without occupying a lease", t => {
  const db = database(t);
  const work = job(db, source(db, resource(db)));
  assert.equal(claim(db, work.id, "poll"), 1);
  db.prepare(`UPDATE processing_jobs SET state = 'waiting', next_run_at = ?,
    lease_owner = NULL, execution_token = NULL, lease_expires_at = NULL WHERE id = ?`).run(now + 5000, work.id);
  assert.equal(claim(db, work.id, "early", now + 1000), 0);
  assert.equal(claim(db, work.id, "due", now + 5000), 1);
  const row = db.prepare("SELECT attempt_count, failure_count FROM processing_jobs WHERE id = ?").get(work.id);
  assert.equal(row.attempt_count, 2);
  assert.equal(row.failure_count, 0);
});

test("a parse run must belong to the job's source and imported results need no provider", t => {
  const db = database(t);
  const input = source(db, resource(db));
  const other = source(db, resource(db));
  const work = job(db, input);
  const values = {
    id: randomUUID(), job_id: work.id, resource_id: input.resource_id, source_id: input.id,
    mode: "import", parser_name: "fixture", normalizer_version: "1", source_version: 1,
    source_fingerprint: hash, base_content_version: 0, submission_key: randomUUID(),
    submission_state: "not_applicable", stage: "validate", created_at: now, updated_at: now,
  };
  assert.throws(() => insert(db, "parse_runs", { ...values, source_id: other.id, resource_id: other.resource_id }), /FOREIGN KEY/);
  insert(db, "parse_runs", values);
  assert.equal(db.prepare("SELECT provider_profile_id FROM parse_runs WHERE id = ?").get(values.id).provider_profile_id, null);
});

test("embedding storage rejects wrong dimensions/length and immutable profile changes", t => {
  const db = database(t);
  const gen = generation(db, source(db, resource(db)));
  const text = block(db, gen);
  const embeddingProfile = profile(db);
  const values = {
    id: randomUUID(), generation_id: gen.id, content_block_id: text.id,
    profile_id: embeddingProfile.id, dimensions: 2, input_text_hash: hash,
    vector: Buffer.alloc(8), created_at: now, updated_at: now,
  };
  assert.throws(() => insert(db, "block_embeddings", { ...values, vector: Buffer.alloc(4) }), /CHECK/);
  assert.throws(() => insert(db, "block_embeddings", { ...values, dimensions: 3, vector: Buffer.alloc(12) }), /FOREIGN KEY/);
  values.vector.writeFloatLE(1, 0);
  insert(db, "block_embeddings", values);
  assert.throws(() => db.prepare("UPDATE embedding_profiles SET model = 'different' WHERE id = ?").run(embeddingProfile.id), /IMMUTABLE/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("FTS tracks insert, update and removal of derived projection rows", t => {
  const db = database(t);
  const paper = resource(db);
  insert(db, "search_documents", {
    document_kind: "metadata", resource_id: paper.id, title: "Neutrino analysis",
    tokenizer_profile: "unicode61-pilot-v1", indexed_version: 1, updated_at: now,
  });
  const matches = term => db.prepare("SELECT count(*) AS total FROM search_fts WHERE search_fts MATCH ?").get(term).total;
  assert.equal(matches("neutrino"), 1);
  db.prepare("UPDATE search_documents SET title = 'Photon analysis' WHERE resource_id = ?").run(paper.id);
  assert.equal(matches("neutrino"), 0);
  assert.equal(matches("photon"), 1);
  db.prepare("DELETE FROM search_documents WHERE resource_id = ?").run(paper.id);
  assert.equal(matches("photon"), 0);
});

test("revisions are append-only and receipt identities reject duplicate operation rows", t => {
  const db = database(t);
  const paper = resource(db);
  const revision = insert(db, "resource_revisions", {
    id: randomUUID(), resource_id: paper.id, operation_id: "fixture-operation",
    base_version: 1, result_version: 2, change_type: "update_metadata", target_type: "resource",
    created_by_type: "user", created_at: now,
  });
  assert.throws(() => db.prepare("UPDATE resource_revisions SET change_type = 'other' WHERE id = ?").run(revision.id), /APPEND_ONLY/);
  const receipt = { authority_key: "local:fixture", operation_id: "fixture-operation", operation_kind: "update", target_key: paper.id, request_hash: hash, result_json: "{}", created_at: now };
  insert(db, "mutation_receipts", receipt);
  assert.throws(() => insert(db, "mutation_receipts", { ...receipt, request_hash: "b".repeat(64) }), /UNIQUE/);
});

test("managed files reject obvious absolute and traversal paths", t => {
  const db = database(t);
  const file = { id: randomUUID(), relative_path: "files/fixture.pdf", media_type: "application/pdf", byte_length: 8, sha256: hash, state: "available", created_at: now };
  for (const relative_path of ["../outside.pdf", "files/../../outside.pdf", "/absolute.pdf", "C:/outside.pdf", "files\\outside.pdf"]) {
    assert.throws(() => insert(db, "stored_files", { ...file, relative_path }), /CHECK/);
  }
  insert(db, "stored_files", file);
});

test("reserved MCP storage has foreign-keyed libraries and rejects unknown scopes", t => {
  const db = database(t);
  const lib = library(db);
  const token = insert(db, "mcp_tokens", {
    id: randomUUID(), name: "Fixture credential", selector: "fixture-selector", token_hash: hash,
    created_at: now, expires_at: now + 86400000,
  });
  insert(db, "mcp_token_libraries", { token_id: token.id, library_id: lib.id });
  insert(db, "mcp_token_scopes", { token_id: token.id, scope: "knowledge:read" });
  assert.throws(() => insert(db, "mcp_token_scopes", { token_id: token.id, scope: "knowledge:all" }), /CHECK/);
  assert.throws(() => insert(db, "mcp_token_libraries", { token_id: token.id, library_id: randomUUID() }), /FOREIGN KEY/);
});
