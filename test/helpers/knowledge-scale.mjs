// Synthetic business rows shared by Node and native Zotero storage checks.
export async function seedKnowledgeScale(db, sql, { resourceCount = 4000, folderCount = 10 } = {}) {
  for (const count of [resourceCount, folderCount]) {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Scale fixtures require positive integer counts");
  }
  const sequence = count => `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n+1<${count})`;
  const statements = [
    "INSERT INTO knowledge_libraries(id,name,is_default,created_at,updated_at) VALUES ('scale-library','Scale library',1,1,1)",
    `${sequence(resourceCount)} INSERT INTO knowledge_resources(id,title,resource_type,metadata_authority,created_at,updated_at)
      SELECT 'scale-resource-'||n,'Synthetic paper '||n,'article','import',1,1 FROM seq`,
    "INSERT INTO library_nodes(id,library_id,node_type,name,sort_order,created_at,updated_at) VALUES ('scale-root','scale-library','folder','Parent',0,1,1)",
    `${sequence(folderCount)} INSERT INTO library_nodes(id,library_id,parent_id,node_type,name,sort_order,created_at,updated_at)
      SELECT 'scale-folder-'||n,'scale-library','scale-root','folder','Folder '||n,n,1,1 FROM seq`,
    "INSERT INTO library_resources(id,library_id,resource_id,added_at) SELECT 'scale-relation-'||id,'scale-library',id,1 FROM knowledge_resources",
    `INSERT INTO library_items(id,library_id,node_id,library_resource_id,sort_order,added_at)
      SELECT 'scale-placement-'||r.id||'-'||n.id,'scale-library',n.id,r.id,n.sort_order,1
      FROM library_resources r CROSS JOIN library_nodes n WHERE n.parent_id='scale-root'`,
    `INSERT INTO membership_origins(id,origin_key,library_id,resource_id,library_resource_id,library_item_id,origin_type,created_at,updated_at)
      SELECT 'scale-origin-'||p.id,'manual:scale-library:'||r.resource_id||':'||p.node_id,'scale-library',r.resource_id,r.id,p.id,'manual',1,1
      FROM library_items p JOIN library_resources r ON r.id=p.library_resource_id`
  ];
  await db.transaction().execute(async tx => {
    for (const statement of statements) await sql.raw(statement).execute(tx);
  });
  return { target: { libraryID: "scale-library", nodeID: null }, root: { libraryID: "scale-library", nodeID: "scale-root" },
    resourceCount, folderCount, originCount: resourceCount * folderCount };
}
