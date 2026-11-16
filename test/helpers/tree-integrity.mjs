// Synthetic tree data shared by schema and migration regression tests.
export const treeTables = ["library_nodes", "structure_nodes", "content_blocks"];

export function treeFixture(db, table) {
  const insert = (name, row) => {
    const fields = Object.keys(row);
    db.prepare(`INSERT INTO ${name} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(row));
  };
  if (table === "library_nodes") {
    insert("knowledge_libraries", { id: "library", name: "Tree fixture", created_at: 0, updated_at: 0 });
  } else {
    insert("knowledge_resources", { id: "resource", title: "Tree fixture", resource_type: "article", metadata_authority: "import", created_at: 0, updated_at: 0 });
    insert("resource_sources", { id: "source", resource_id: "resource", source_type: "imported_text", source_role: "primary_document", text_content: "Synthetic text", created_at: 0, updated_at: 0 });
    insert("content_generations", { id: "generation", resource_id: "resource", source_id: "source", base_content_version: 0, content_version: 1, source_version: 1, source_fingerprint: "a".repeat(64), origin: "import", normalizer_version: "fixture", created_by_type: "system", created_at: 0 });
  }
  let order = 0;
  return (parents, prefix) => {
    const ids = parents.map((_, i) => `${prefix}-${i}`);
    const rows = parents.map((parent, i) => {
      const base = { id: ids[i], created_at: 0 };
      const parentID = parent === null ? null : ids[parent];
      if (table === "library_nodes") return { ...base, library_id: "library", parent_id: parentID, node_type: "folder", name: ids[i], sort_order: order++, updated_at: 0 };
      if (table === "structure_nodes") return { ...base, generation_id: "generation", parent_id: parentID, node_type: parent === null ? "root" : "section", path: `/${ids[i]}`, depth: parent === null ? 0 : 1, sort_order: order++, source_type: "import" };
      return { ...base, generation_id: "generation", parent_block_id: parentID, block_type: "text", canonical_order: order++, content_markdown: "Synthetic block", content_hash: "a".repeat(64), source_type: "import" };
    });
    const fields = Object.keys(rows[0]);
    const placeholders = `(${fields.map(() => "?").join(",")})`;
    db.prepare(`INSERT INTO ${table} (${fields.join(",")}) VALUES ${rows.map(() => placeholders).join(",")}`)
      .run(...rows.flatMap(row => fields.map(field => row[field])));
    return ids;
  };
}
