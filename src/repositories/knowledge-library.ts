import { assertEditable, excludeOrigin, canSyncAdmit } from "./sync-policy";
import { purgeResource, purgeMemberships, purgeContainers } from "./permanent-delete";
import { t } from "../shared/localization";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import { forEachBatch, queryInBatches } from "../database/batches";
import type { NativeItemProjection, NativeKnowledgePort } from "../integrations/zotero/knowledge-items";
import { NativeLibraryIdentityError } from "../integrations/zotero/knowledge-items";
import { KnowledgeUserError } from "../shared/knowledge-errors";
import { KnowledgeTrashRepository } from "./knowledge-trash";
import { emptyKnowledgeSnapshot, type KnowledgeSnapshot, type KnowledgeTarget, type KnowledgeTrashEntry } from "../shared/contracts/knowledge-library";

function recoveryScopes(entries: readonly KnowledgeTrashEntry[]): { resources: Map<string, string[]>; libraries: Map<string, string[]> } {
  const resources = new Map<string, string[]>(), libraries = new Map<string, string[]>();
  for (const entry of entries) {
    const library = libraries.get(entry.target.libraryID) ?? [];
    library.push(entry.id); libraries.set(entry.target.libraryID, library);
    for (const id of entry.resourceIDs) {
      const resource = resources.get(id) ?? [];
      resource.push(entry.id); resources.set(id, resource);
    }
  }
  return { resources, libraries };
}

export class KnowledgeLibraryRepository {
  private authority = "";
  private readonly trash: KnowledgeTrashRepository;

  constructor(private readonly db: Kysely<Database>, private readonly native: NativeKnowledgePort) { this.trash = new KnowledgeTrashRepository(native); }

  async initialize(): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const state = await tx.selectFrom("plugin_state").selectAll().where("key", "=", "installation").executeTakeFirst();
      const identity = state ? JSON.parse(state.value_json) as { id: string } : { id: this.native.uuid() };
      this.authority = `local-ui:${identity.id}`;
      if (!state) await tx.insertInto("plugin_state").values({ key: "installation", value_json: JSON.stringify(identity), updated_at: Date.now() }).execute();
      // The installation record is also the persistent initialization marker,
      // including for older databases without a separate bootstrap flag.
      const library = await tx.selectFrom("knowledge_libraries").select("id").executeTakeFirst();
      if (!state && !library) {
        const now = Date.now();
        const name = t("default-library");
        await tx.insertInto("knowledge_libraries").values({ id: this.native.uuid(), name, is_default: 1, description: null, created_at: now, updated_at: now, deleted_at: null }).execute();
      }
    });
  }

  async snapshot(): Promise<KnowledgeSnapshot> {
    const result = emptyKnowledgeSnapshot();
    result.trash = await this.trash.listSummary(this.db);
    if (result.trash.length) {
      const trashed = await this.db.selectFrom("knowledge_resources as r").innerJoin("zotero_item_links as z", "z.resource_id", "r.id")
        .innerJoin("zotero_libraries as l", "l.id", "z.zotero_library_id")
        .select(["r.id", "r.title", "r.updated_at", "r.version", "z.local_item_id", "z.item_key", "z.state", "l.local_library_id", "l.availability"])
        .where("z.is_anchor", "=", 1).where(eb => eb.exists(eb.selectFrom("knowledge_trash_resources as t")
          .select("t.resource_id").whereRef("t.resource_id", "=", "r.id"))).execute();
      result.trashedResources = trashed.map(row => ({ id: row.id, title: row.title, itemID: row.local_item_id, nativeLibraryID: row.local_library_id,
        itemKey: row.item_key, state: row.availability === "available" ? row.state : "unavailable", modifiedAt: row.updated_at, version: row.version }));
    }
    const libraries = await this.db.selectFrom("knowledge_libraries").selectAll().where("status", "=", "active").orderBy("is_default", "desc").orderBy("name").execute();
    const activeLibraries = new Set(libraries.map(library => library.id));
    result.libraries = libraries.map(row => ({ id: row.id, name: row.name, isDefault: row.is_default === 1 }));
    result.folders = (await this.db.selectFrom("library_nodes").selectAll().where("deleted_at", "is", null).where("node_type", "=", "folder").orderBy("sort_order").execute())
      .filter(row => activeLibraries.has(row.library_id)).map(row => ({ id: row.id, libraryID: row.library_id, parentID: row.parent_id, name: row.name }));
    const rows = await this.db.selectFrom("knowledge_resources as r").innerJoin("zotero_item_links as z", "z.resource_id", "r.id")
      .innerJoin("zotero_libraries as l", "l.id", "z.zotero_library_id").innerJoin("library_resources as m", "m.resource_id", "r.id")
      .innerJoin("knowledge_libraries as k", "k.id", "m.library_id")
      .select(["r.id", "r.title", "r.updated_at", "r.version", "z.local_item_id", "z.item_key", "z.state", "l.local_library_id", "l.availability"])
      .where("z.is_anchor", "=", 1).where("r.status", "=", "active").where("m.deleted_at", "is", null).where("k.status", "=", "active").distinct().execute();
    result.resources = rows.map(row => ({ id: row.id, title: row.title, itemID: row.local_item_id, nativeLibraryID: row.local_library_id,
      itemKey: row.item_key, state: row.availability === "available" ? row.state : "unavailable", modifiedAt: row.updated_at, version: row.version }));
    const ids = new Set(result.resources.map(resource => resource.id));
    const memberships = await this.db.selectFrom("membership_origins as o")
      .leftJoin("library_items as p", join => join.onRef("p.id", "=", "o.library_item_id").on("p.deleted_at", "is", null))
      .select(["o.resource_id", "o.library_id", "p.node_id"]).where("o.deleted_at", "is", null).execute();
    result.memberships = memberships.filter(row => ids.has(row.resource_id)).map(row => ({ resourceID: row.resource_id, libraryID: row.library_id,
      nodeID: row.node_id }));
    const links = await this.db.selectFrom("zotero_item_links").select(["local_item_id", "resource_id"]).where("state", "=", "current").execute();
    for (const link of links) if (link.local_item_id && ids.has(link.resource_id)) result.itemResources.set(link.local_item_id, link.resource_id);
    const sources = await this.db.selectFrom("resource_sources as s").leftJoin("content_generations as g", "g.id", "s.active_generation_id")
      .leftJoin("parse_runs as p", "p.id", "g.parse_run_id").leftJoin("provider_profiles as profile", "profile.id", "p.provider_profile_id")
      .select(["s.id", "s.resource_id", "s.media_type", "s.metadata_json", "s.availability", "g.state as content_state",
        "p.parser_name as parser_model", "profile.config_json as parser_config"]).where("s.deleted_at", "is", null).execute();
    const sourceResources = new Set([...ids, ...result.trashedResources.map(row => row.id)]);
    result.sources = sources.filter(row => sourceResources.has(row.resource_id)).map(row => {
      let parser: KnowledgeSnapshot["sources"][number]["parser"];
      if (["ready", "partial"].includes(row.content_state ?? "") && row.parser_model && row.parser_config) {
        try {
          const identity: unknown = JSON.parse(row.parser_config);
          if (identity && typeof identity === "object" && !Array.isArray(identity)) {
            const provider = (identity as { provider?: unknown }).provider ?? "paddleocr";
            if (typeof provider === "string" && provider) parser = { provider, model: row.parser_model };
          }
        } catch { /* Missing legacy provenance must not hide attachment metadata. */ }
      }
      return { id: row.id, resourceID: row.resource_id, mediaType: row.media_type,
        title: String((JSON.parse(row.metadata_json) as { title?: string }).title || "Attachment"), availability: row.availability,
        contentState: row.content_state ?? undefined, parser };
    });
    return result;
  }

  async create(name: string, target?: KnowledgeTarget, fromSync = false): Promise<string> {
    return this.db.transaction().execute(tx => this.createInTransaction(tx, name, target, fromSync));
  }

  async createInTransaction(tx: Transaction<Database>, name: string, target?: KnowledgeTarget, fromSync = false): Promise<string> {
    name = name.trim();
    if (!name || name.length > 255) throw new KnowledgeUserError(t("error-name"));
    const duplicateMessage = t(target ? "duplicate-folder" : "duplicate-library", { name });
    try {
      const now = Date.now();
      const id = this.native.uuid();
      let version = 1;
      if (target) {
        await this.validateTarget(tx, target);
        if (!fromSync) await assertEditable(tx, target);
        let siblings = tx.selectFrom("library_nodes").select("id").where("library_id", "=", target.libraryID).where("name", "=", name).where("deleted_at", "is", null);
        siblings = target.nodeID ? siblings.where("parent_id", "=", target.nodeID) : siblings.where("parent_id", "is", null);
        if (await siblings.executeTakeFirst()) throw new KnowledgeUserError(duplicateMessage);
        await tx.insertInto("library_nodes").values({ id, library_id: target.libraryID, parent_id: target.nodeID, name,
          node_type: "folder", description: null, query_json: null, sort_order: now, created_at: now, updated_at: now, deleted_at: null }).execute();
        const library = await tx.selectFrom("knowledge_libraries").select("version").where("id", "=", target.libraryID).executeTakeFirstOrThrow();
        version = library.version + 1;
        await tx.updateTable("knowledge_libraries").set({ version, updated_at: now }).where("id", "=", target.libraryID).execute();
      } else {
        const duplicate = await tx.selectFrom("knowledge_libraries").select("id").where("name", "=", name).where("deleted_at", "is", null).executeTakeFirst();
        if (duplicate) throw new KnowledgeUserError(duplicateMessage);
        const defaultLibrary = await tx.selectFrom("knowledge_libraries").select("id").where("status", "=", "active").where("is_default", "=", 1).executeTakeFirst();
        await tx.insertInto("knowledge_libraries").values({ id, name, description: null, is_default: defaultLibrary ? 0 : 1, created_at: now, updated_at: now, deleted_at: null }).execute();
      }
      await this.event(tx, "knowledge_library", target?.libraryID ?? id, version, target ? "folder_created" : "library_created", { id, name, target });
      return id;
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      if (/UNIQUE constraint failed: (?:library_nodes\.library_id|knowledge_libraries\.name)/i.test(message)) throw new KnowledgeUserError(duplicateMessage);
      throw error;
    }
  }

  async deleteLibrary(libraryID: string, deleteExclusiveResources: boolean): Promise<void> {
    await this.db.transaction().execute(async tx => {
      await assertEditable(tx, { libraryID, nodeID: null }, true);
      const library = await tx.selectFrom("knowledge_libraries").selectAll().where("id", "=", libraryID).where("status", "=", "active").executeTakeFirst();
      if (!library) throw new KnowledgeUserError(t("error-library-deleted"));
      const now = Date.now();
      const members = await tx.selectFrom("library_resources as m").innerJoin("knowledge_resources as r", "r.id", "m.resource_id")
        .select(["m.resource_id", "r.version"])
        .select(eb => eb.exists(eb.selectFrom("library_resources as other").innerJoin("knowledge_libraries as l", "l.id", "other.library_id")
          .select("other.id").whereRef("other.resource_id", "=", "m.resource_id").where("other.library_id", "!=", libraryID)
          .where("other.deleted_at", "is", null).where("l.deleted_at", "is", null)).as("shared"))
        .where("m.library_id", "=", libraryID).where("m.deleted_at", "is", null).execute();
      const folders = await tx.selectFrom("library_nodes").select("id").where("library_id", "=", libraryID).where("deleted_at", "is", null).execute();
      const origins = await tx.selectFrom("membership_origins").select("id").where("library_id", "=", libraryID).where("deleted_at", "is", null).execute();
      const exclusive = deleteExclusiveResources ? members.filter(member => !member.shared).map(member => member.resource_id) : [];
      await this.trash.capture(tx, "library", library.name, { libraryID, nodeID: null }, folders.map(row => row.id), members.map(row => row.resource_id), origins.map(row => row.id), exclusive);
      await tx.updateTable("membership_origins").set({ deleted_at: now, updated_at: now }).where("library_id", "=", libraryID).where("deleted_at", "is", null).execute();
      await tx.updateTable("library_items").set({ deleted_at: now }).where("library_id", "=", libraryID).where("deleted_at", "is", null).execute();
      await tx.updateTable("library_resources").set({ deleted_at: now }).where("library_id", "=", libraryID).where("deleted_at", "is", null).execute();
      await tx.updateTable("library_nodes").set(eb => ({ deleted_at: now, updated_at: now, version: eb("version", "+", 1) })).where("library_id", "=", libraryID).where("deleted_at", "is", null).execute();
      await tx.updateTable("knowledge_libraries").set({ status: "deleted", is_default: 0, deleted_at: now, updated_at: now, version: library.version + 1 }).where("id", "=", libraryID).execute();
      for (const member of members) {
        const resourceID = member.resource_id;
        const deleted = deleteExclusiveResources && !member.shared;
        await tx.updateTable("knowledge_resources").set({ version: member.version + 1, updated_at: now,
          ...(deleted ? { status: "deleted", deleted_at: now } : {}) }).where("id", "=", resourceID).execute();
        await this.revision(tx, resourceID, member.version, this.native.uuid(), deleted ? "resource_deleted" : "membership_removed", { libraryID, reason: "library_deleted" });
      }
      if (library.is_default) {
        const replacement = await tx.selectFrom("knowledge_libraries").select(["id", "version"]).where("status", "=", "active").orderBy("created_at").orderBy("id").executeTakeFirst();
        if (replacement) {
          await tx.updateTable("knowledge_libraries").set({ is_default: 1, version: replacement.version + 1, updated_at: now }).where("id", "=", replacement.id).execute();
          await this.event(tx, "knowledge_library", replacement.id, replacement.version + 1, "default_library_changed", {});
        }
      }
      await this.event(tx, "knowledge_library", libraryID, library.version + 1, "library_deleted", { deleteExclusiveResources });
    });
  }

  private async validateTarget(tx: DatabaseContext, target: KnowledgeTarget): Promise<void> {
    const library = await tx.selectFrom("knowledge_libraries").select("id").where("id", "=", target.libraryID).where("status", "=", "active").executeTakeFirst();
    if (!library) throw new KnowledgeUserError(t("error-target-library"));
    if (target.nodeID) {
      const node = await tx.selectFrom("library_nodes").select("id").where("id", "=", target.nodeID).where("library_id", "=", target.libraryID)
        .where("node_type", "=", "folder").where("deleted_at", "is", null).executeTakeFirst();
      if (!node) throw new KnowledgeUserError(t("error-target-folder"));
    }
  }

  async deleteFolders(targets: KnowledgeTarget[]): Promise<void> {
    if (targets.some(target => !target.nodeID)) throw new KnowledgeUserError(t("error-select-folder"));
    await this.db.transaction().execute(async tx => {
      const selected = new Map(targets.map(target => [target.nodeID!, target]));
      for (const target of targets) { await this.validateTarget(tx, target); await assertEditable(tx, target, true); }
      const nodes = await tx.selectFrom("library_nodes").select(["id", "parent_id"]).where("deleted_at", "is", null).execute();
      const parents = new Map(nodes.map(node => [node.id, node.parent_id]));
      const children = new Map<string, string[]>();
      for (const node of nodes) if (node.parent_id) {
        const siblings = children.get(node.parent_id) ?? [];
        siblings.push(node.id); children.set(node.parent_id, siblings);
      }
      const hasSelectedParent = (id: string): boolean => {
        const seen = new Set<string>();
        for (let parent = parents.get(id); parent && !seen.has(parent); parent = parents.get(parent)) {
          if (selected.has(parent)) return true;
          seen.add(parent);
        }
        return false;
      };
      for (const target of selected.values()) {
        if (hasSelectedParent(target.nodeID!)) continue;
        const now = Date.now();
        const subtree = new Set([target.nodeID!]);
        // Set iteration visits newly added children without rescanning other nodes.
        for (const id of subtree) for (const child of children.get(id) ?? []) subtree.add(child);
        const origins = await queryInBatches([...subtree], ids => tx.selectFrom("membership_origins as o").innerJoin("library_items as p", "p.id", "o.library_item_id")
          .select(["o.id", "o.resource_id"]).where("o.library_id", "=", target.libraryID).where("p.node_id", "in", ids).where("o.deleted_at", "is", null).execute());
        const syncLinks = await queryInBatches([...subtree], ids => tx.selectFrom("zotero_collection_links").select(["binding_id", "collection_key"]).where("node_id", "in", ids).execute());
        for (const link of syncLinks) await tx.insertInto("sync_collection_exclusions").values({ binding_id: link.binding_id, collection_key: link.collection_key, created_at: now })
          .onConflict(c => c.columns(["binding_id", "collection_key"]).doNothing()).execute();
        const folder = await tx.selectFrom("library_nodes").select("name").where("id", "=", target.nodeID!).executeTakeFirstOrThrow();
        await this.trash.capture(tx, "folder", folder.name, target, [...subtree], [...new Set(origins.map(row => row.resource_id))], origins.map(row => row.id));
        await forEachBatch(origins.map(origin => origin.id), ids => tx.updateTable("membership_origins").set({ deleted_at: now, updated_at: now }).where("id", "in", ids).execute());
        await forEachBatch([...subtree], ids => tx.updateTable("library_items").set({ deleted_at: now }).where("library_id", "=", target.libraryID).where("node_id", "in", ids).where("deleted_at", "is", null).execute());
        await forEachBatch([...subtree], ids => tx.updateTable("library_nodes").set(eb => ({ deleted_at: now, updated_at: now, version: eb("version", "+", 1) })).where("id", "in", ids).execute());
        for (const resourceID of new Set(origins.map(origin => origin.resource_id))) {
          const remaining = await tx.selectFrom("membership_origins").select("id").where("resource_id", "=", resourceID)
            .where("library_id", "=", target.libraryID).where("deleted_at", "is", null).executeTakeFirst();
          if (!remaining) await this.membership(tx, resourceID, { libraryID: target.libraryID, nodeID: null }, now);
          const resource = await tx.selectFrom("knowledge_resources").select("version").where("id", "=", resourceID).executeTakeFirstOrThrow();
          await tx.updateTable("knowledge_resources").set({ version: resource.version + 1, updated_at: now }).where("id", "=", resourceID).execute();
          await this.revision(tx, resourceID, resource.version, this.native.uuid(), "membership_removed", { target, reason: "folder_deleted", retainedAtRoot: !remaining });
        }
        const library = await tx.selectFrom("knowledge_libraries").select("version").where("id", "=", target.libraryID).executeTakeFirstOrThrow();
        await tx.updateTable("knowledge_libraries").set({ version: library.version + 1, updated_at: now }).where("id", "=", target.libraryID).execute();
        await this.event(tx, "knowledge_library", target.libraryID, library.version + 1, "folder_deleted", { nodeID: target.nodeID, descendants: subtree.size - 1 });
      }
    });
  }

  async save(input: NativeItemProjection, target?: KnowledgeTarget, operationID?: string): Promise<string>;
  async save(input: NativeItemProjection, target: KnowledgeTarget, operationID: string | undefined, bindingID: string): Promise<string | null>;
  async save(input: NativeItemProjection, target?: KnowledgeTarget, operationID = this.native.uuid(), bindingID?: string): Promise<string | null> {
    const requestHash = await this.native.hash(JSON.stringify({ library: input.library.localID, key: input.key, target: target ?? null }));
    return this.db.transaction().execute(async tx => {
      if (bindingID && (!target || !await canSyncAdmit(tx, bindingID, target, input.key))) return null;
      if (target) { await this.validateTarget(tx, target); if (!bindingID) await assertEditable(tx, target); }
      const receipt = await tx.selectFrom("mutation_receipts").selectAll().where("authority_key", "=", this.authority).where("operation_id", "=", operationID).executeTakeFirst();
      if (receipt) {
        if (receipt.request_hash !== requestHash) throw new Error("An operation ID was reused for a different admission.");
        return (JSON.parse(receipt.result_json) as { resourceID: string }).resourceID;
      }
      const now = Date.now();
      let library = await tx.selectFrom("zotero_libraries").selectAll().where("local_library_id", "=", input.library.localID).executeTakeFirst();
      if (library && (library.library_type !== input.library.type || (library.external_library_id && input.library.externalID && library.external_library_id !== input.library.externalID))) {
        throw new NativeLibraryIdentityError(t("error-identity"));
      }
      const libraryProjection = { library_type: input.library.type, local_library_id: input.library.localID, external_library_id: input.library.externalID,
        display_name: input.library.name, is_editable: Number(input.library.editable), files_editable: Number(input.library.filesEditable), availability: "available", last_checked_at: now, updated_at: now };
      if (!library) {
        const id = this.native.uuid();
        await tx.insertInto("zotero_libraries").values({ id, ...libraryProjection, created_at: now }).execute();
        library = await tx.selectFrom("zotero_libraries").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
      } else await tx.updateTable("zotero_libraries").set(libraryProjection).where("id", "=", library.id).execute();

      const anchor = await tx.selectFrom("zotero_item_links").selectAll().where("zotero_library_id", "=", library.id).where("item_key", "=", input.key).executeTakeFirst();
      if (!target && !anchor) throw new Error("Only admitted Zotero items can be refreshed.");
      if (!target && anchor?.metadata_fingerprint === input.fingerprint && anchor.state === input.state && anchor.local_item_id === input.itemID) return anchor.resource_id;
      const resourceID = anchor?.resource_id ?? this.native.uuid();
      const previous = await tx.selectFrom("knowledge_resources").selectAll().where("id", "=", resourceID).executeTakeFirst();
      if (target && previous?.status === "deleted") await tx.updateTable("knowledge_resources").set({ status: "active", deleted_at: null }).where("id", "=", resourceID).execute();
      const metadataChanged = !previous || previous.metadata_fingerprint !== input.metadataFingerprint;
      const sourceChanged = !anchor || anchor.metadata_fingerprint !== input.fingerprint || anchor.state !== input.state;
      const previousMetadata = previous ? JSON.parse(previous.metadata_json) as Record<string, unknown> : {};
      const { publicationTitle, volume, issue, DOI, ...fields } = input.fields;
      const projected = { title: input.title, resource_type: input.itemType, language: input.language, abstract: input.abstract,
        publication_title: publicationTitle || null, volume: volume || null, issue: issue || null, doi: DOI || null, metadata_schema_version: 2,
        publication_date: input.publicationDate, contributors_json: JSON.stringify(input.contributors), metadata_authority: "zotero",
        metadata_json: JSON.stringify({ ...previousMetadata, fields, tags: input.tags }), metadata_fingerprint: input.metadataFingerprint };
      if (!previous) {
        await tx.insertInto("knowledge_resources").values({ id: resourceID, ...projected, subtitle: null, summary: null, canonical_source_id: null,
          created_at: now, updated_at: now, deleted_at: null }).execute();
      } else if (metadataChanged) await tx.updateTable("knowledge_resources").set({ ...projected, metadata_version: previous.metadata_version + 1 }).where("id", "=", resourceID).execute();

      if (metadataChanged) {
        await tx.deleteFrom("resource_identifiers").where("resource_id", "=", resourceID).where("metadata_json", "=", '{"authority":"zotero"}').execute();
        for (const key of ["DOI", "ISBN", "ISSN"]) {
          const raw = input.fields[key];
          if (!raw?.trim()) continue;
          const normalized = key === "DOI" ? raw.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase() : raw.replace(/[\s-]/g, "").toUpperCase();
          const primary = await tx.selectFrom("resource_identifiers").select("id").where("resource_id", "=", resourceID)
            .where("identifier_type", "=", key.toLowerCase()).where("is_primary", "=", 1).executeTakeFirst();
          await tx.insertInto("resource_identifiers").values({ id: this.native.uuid(), resource_id: resourceID, identifier_type: key.toLowerCase(),
            identifier_value: raw, normalized_value: normalized, is_primary: primary ? 0 : 1, metadata_json: '{"authority":"zotero"}', created_at: now })
            .onConflict(conflict => conflict.columns(["resource_id", "identifier_type", "normalized_value"]).doNothing()).execute();
        }
      }

      if (input.kind === "regular") {
        const values = { local_item_id: input.itemID, resource_id: resourceID, source_id: null, item_kind: "regular", is_anchor: 1,
          parent_item_key: null, native_version: input.nativeVersion, native_modified_at: input.modified, metadata_fingerprint: input.fingerprint,
          state: input.state, last_seen_at: now, updated_at: now };
        if (anchor) await tx.updateTable("zotero_item_links").set(values).where("id", "=", anchor.id).execute();
        else await tx.insertInto("zotero_item_links").values({ id: this.native.uuid(), zotero_library_id: library.id, item_key: input.key, ...values,
          cached_file_path: null, file_size: null, file_modified_at: null, created_at: now }).execute();
      }
      for (const attachment of input.attachments) {
        const link = await tx.selectFrom("zotero_item_links").selectAll().where("zotero_library_id", "=", library.id).where("item_key", "=", attachment.key).executeTakeFirst();
        if (link && link.resource_id !== resourceID) throw new KnowledgeUserError(t("error-attachment-conflict"));
        const sourceID = link?.source_id ?? this.native.uuid();
        const source = await tx.selectFrom("resource_sources").selectAll().where("id", "=", sourceID).executeTakeFirst();
        const metadata = JSON.stringify({ title: attachment.title, linkMode: attachment.linkMode });
        const values = { metadata_json: metadata, media_type: attachment.mediaType, deleted_at: null,
          availability: attachment.state === "trashed" ? "missing" : source?.availability === "missing" || source?.availability === "deleted" ? "pending" : source?.availability ?? "pending", updated_at: now };
        if (source) {
          if (source.metadata_json !== metadata || source.media_type !== attachment.mediaType || link?.state !== attachment.state || source.deleted_at) {
            await tx.updateTable("resource_sources").set(values).where("id", "=", sourceID).execute();
          }
        } else await tx.insertInto("resource_sources").values({ id: sourceID, resource_id: resourceID, source_type: "zotero_attachment", source_role: "attachment",
          ...values, stored_file_id: null, uri: null, text_content: null, version_label: null, source_fingerprint: null, fingerprint_algorithm: null,
          active_generation_id: null, last_checked_at: null, error_code: null, created_at: now }).execute();
        const linkValues = { local_item_id: attachment.itemID, resource_id: resourceID, source_id: sourceID, item_kind: "attachment",
          parent_item_key: attachment.parentKey, is_anchor: input.kind === "attachment" ? 1 : 0, state: attachment.state,
          native_version: input.nativeVersion, native_modified_at: input.modified, metadata_fingerprint: input.kind === "attachment" ? input.fingerprint : null,
          last_seen_at: now, updated_at: now };
        if (link) await tx.updateTable("zotero_item_links").set(linkValues).where("id", "=", link.id).execute();
        else await tx.insertInto("zotero_item_links").values({ id: this.native.uuid(), zotero_library_id: library.id, item_key: attachment.key,
          ...linkValues, cached_file_path: null, file_size: null, file_modified_at: null, created_at: now }).execute();
      }
      const oldLinks = await tx.selectFrom("zotero_item_links").selectAll().where("resource_id", "=", resourceID).where("item_kind", "=", "attachment").execute();
      for (const link of oldLinks) if (!input.attachments.some(attachment => attachment.key === link.item_key) && link.state !== "deleted") {
        await tx.updateTable("zotero_item_links").set({ state: "deleted", updated_at: now }).where("id", "=", link.id).execute();
        if (link.source_id) await tx.updateTable("resource_sources").set({ availability: "deleted", deleted_at: now, updated_at: now }).where("id", "=", link.source_id).execute();
      }
      if (target && !bindingID && target.nodeID) await tx.deleteFrom("sync_exclusions").where("node_id", "=", target.nodeID).where("item_key", "=", input.key).execute();
      const membershipChanged = target ? await this.membership(tx, resourceID, target, now, bindingID) : false;
      if (target) await this.trash.readmitted(tx, resourceID, target);
      if (!previous || metadataChanged || sourceChanged || membershipChanged) {
        const version = (previous?.version ?? 0) + 1;
        await tx.updateTable("knowledge_resources").set({ version, updated_at: now }).where("id", "=", resourceID).execute();
        await this.revision(tx, resourceID, previous?.version ?? 0, operationID,
          !previous ? "resource_created" : metadataChanged || sourceChanged ? "metadata_refreshed" : "membership_added", { metadataFingerprint: input.metadataFingerprint, sourceFingerprint: input.fingerprint, target: target ?? null });
      }
      await tx.insertInto("mutation_receipts").values({ authority_key: this.authority, operation_id: operationID, operation_kind: target ? "admit" : "refresh",
        target_key: resourceID, request_hash: requestHash, result_json: JSON.stringify({ resourceID }), created_at: now }).execute();
      return resourceID;
    });
  }

  private async membership(tx: DatabaseContext, resourceID: string, target: KnowledgeTarget, now: number, bindingID?: string): Promise<boolean> {
    let relation = await tx.selectFrom("library_resources").selectAll().where("library_id", "=", target.libraryID).where("resource_id", "=", resourceID).executeTakeFirst();
    if (!relation) {
      const id = this.native.uuid();
      await tx.insertInto("library_resources").values({ id, library_id: target.libraryID, resource_id: resourceID, added_at: now, deleted_at: null }).execute();
      relation = { id, library_id: target.libraryID, resource_id: resourceID, added_at: now, deleted_at: null };
    } else if (relation.deleted_at) await tx.updateTable("library_resources").set({ deleted_at: null }).where("id", "=", relation.id).execute();
    let placementID: string | null = null;
    if (target.nodeID) {
      let placement = await tx.selectFrom("library_items").selectAll().where("node_id", "=", target.nodeID).where("library_resource_id", "=", relation.id).executeTakeFirst();
      if (!placement) {
        placementID = this.native.uuid();
        await tx.insertInto("library_items").values({ id: placementID, library_id: target.libraryID, node_id: target.nodeID,
          library_resource_id: relation.id, sort_order: now, added_at: now, deleted_at: null }).execute();
      } else {
        placementID = placement.id;
        if (placement.deleted_at) await tx.updateTable("library_items").set({ deleted_at: null }).where("id", "=", placement.id).execute();
      }
    }
    const link = bindingID ? await tx.selectFrom("zotero_item_links").select("id").where("resource_id", "=", resourceID).where("is_anchor", "=", 1).executeTakeFirstOrThrow() : undefined;
    const originKey = `${bindingID ? `zotero:${bindingID}` : "manual"}:${target.libraryID}:${target.nodeID ?? "root"}:${resourceID}`;
    const origin = await tx.selectFrom("membership_origins").selectAll().where("origin_key", "=", originKey).executeTakeFirst();
    if (!origin) await tx.insertInto("membership_origins").values({ id: this.native.uuid(), origin_key: originKey, library_id: target.libraryID,
      resource_id: resourceID, library_resource_id: relation.id, library_item_id: placementID, origin_type: bindingID ? "zotero" : "manual", binding_id: bindingID ?? null, item_link_id: link?.id ?? null,
      last_seen_scan_id: null, created_at: now, updated_at: now, deleted_at: null }).execute();
    else if (origin.deleted_at) await tx.updateTable("membership_origins").set({ deleted_at: null, updated_at: now }).where("id", "=", origin.id).execute();
    return !origin || origin.deleted_at !== null;
  }

  async remove(resourceID: string, target: KnowledgeTarget): Promise<void> {
    await this.db.transaction().execute(tx => this.removeMembership(tx, resourceID, target));
  }

  async moveToTrash(resourceIDs: string[], libraryIDs: string[]): Promise<void> {
    await this.db.transaction().execute(async tx => {
      for (const libraryID of new Set(libraryIDs)) {
        const target = { libraryID, nodeID: null };
        await this.validateTarget(tx, target);
        for (const resourceID of new Set(resourceIDs)) await this.removeMembership(tx, resourceID, target);
      }
    });
  }

  private async removeMembership(tx: DatabaseContext, resourceID: string, target: KnowledgeTarget): Promise<void> {
    await this.validateTarget(tx, target);
    await assertEditable(tx, target);
    const now = Date.now();
    const origins = await tx.selectFrom("membership_origins as o").leftJoin("library_items as p", "p.id", "o.library_item_id")
      .select(["o.id", "o.library_resource_id", "o.library_item_id", "p.node_id"]).where("o.resource_id", "=", resourceID)
      .where("o.library_id", "=", target.libraryID).where("o.deleted_at", "is", null).execute();
    const selected = origins.filter(origin => !target.nodeID || origin.node_id === target.nodeID);
    if (!selected.length) return;
    const label = await tx.selectFrom("knowledge_resources").select("title").where("id", "=", resourceID).executeTakeFirstOrThrow();
    await this.trash.capture(tx, "item", label.title, target, [], [resourceID], selected.map(row => row.id));
    for (const origin of selected) {
      if (origin.node_id) await assertEditable(tx, { libraryID: target.libraryID, nodeID: origin.node_id });
      await excludeOrigin(tx, origin.id);
      await tx.updateTable("membership_origins").set({ deleted_at: now, updated_at: now }).where("id", "=", origin.id).execute();
      if (origin.library_item_id) {
        const other = await tx.selectFrom("membership_origins").select("id").where("library_item_id", "=", origin.library_item_id).where("deleted_at", "is", null).executeTakeFirst();
        if (!other) await tx.updateTable("library_items").set({ deleted_at: now }).where("id", "=", origin.library_item_id).execute();
      }
    }
    const relationID = selected[0].library_resource_id;
    const remaining = await tx.selectFrom("membership_origins").select("id").where("library_resource_id", "=", relationID).where("deleted_at", "is", null).executeTakeFirst();
    if (!remaining) await tx.updateTable("library_resources").set({ deleted_at: now }).where("id", "=", relationID).execute();
    const resource = await tx.selectFrom("knowledge_resources").select("version").where("id", "=", resourceID).executeTakeFirstOrThrow();
    await tx.updateTable("knowledge_resources").set({ version: resource.version + 1, updated_at: now }).where("id", "=", resourceID).execute();
    await this.revision(tx, resourceID, resource.version, this.native.uuid(), "membership_removed", { target });
  }

  async markUnavailable(resourceID: string, state: "deleted" | "unavailable"): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const anchor = await tx.selectFrom("zotero_item_links").selectAll().where("resource_id", "=", resourceID).where("is_anchor", "=", 1).executeTakeFirst();
      if (!anchor || anchor.state === state) return;
      await tx.updateTable("zotero_item_links").set({ state, updated_at: Date.now() }).where("id", "=", anchor.id).execute();
      const resource = await tx.selectFrom("knowledge_resources").select("version").where("id", "=", resourceID).executeTakeFirstOrThrow();
      await tx.updateTable("knowledge_resources").set({ version: resource.version + 1, updated_at: Date.now() }).where("id", "=", resourceID).execute();
      await this.revision(tx, resourceID, resource.version, this.native.uuid(), "source_unavailable", { state });
    });
  }

  async restoreTrash(entryIDs: string[]): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const entries = await this.trash.restore(tx, entryIDs, (resourceID, target, now) => this.membership(tx, resourceID, target, now));
      const scopes = recoveryScopes(entries);
      for (const [resourceID, trashEntries] of scopes.resources) {
        const resource = await tx.selectFrom("knowledge_resources").select("version").where("id", "=", resourceID).executeTakeFirstOrThrow();
        await tx.updateTable("knowledge_resources").set({ version: resource.version + 1, updated_at: Date.now() }).where("id", "=", resourceID).execute();
        await this.revision(tx, resourceID, resource.version, this.native.uuid(), "membership_restored", { trashEntries });
      }
      for (const [libraryID, entryIDs] of scopes.libraries) {
        const library = await tx.selectFrom("knowledge_libraries").select("version").where("id", "=", libraryID).executeTakeFirstOrThrow();
        await tx.updateTable("knowledge_libraries").set({ version: library.version + 1, updated_at: Date.now() }).where("id", "=", libraryID).execute();
        await this.event(tx, "knowledge_library", libraryID, library.version + 1, "trash_restored", { entries: entryIDs });
      }
    });
  }

  async purgeTrash(entryIDs: string[]): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const entries = await this.trash.purge(tx, entryIDs);
      await purgeMemberships(tx);
      for (const resourceID of new Set(entries.flatMap(entry => entry.resourceIDs))) await purgeResource(tx, resourceID);
      await purgeContainers(tx, new Set(entries.flatMap(entry => entry.folderIDs)), new Set(entries.filter(entry => entry.kind === "library").map(entry => entry.target.libraryID)));

    });
  }

  private async revision(tx: DatabaseContext, id: string, base: number, operationID: string, type: string, changes: object): Promise<void> {
    await tx.insertInto("resource_revisions").values({ id: this.native.uuid(), resource_id: id, operation_id: operationID,
      base_version: base, result_version: base + 1, change_type: type, target_type: "resource", target_id: id, before_json: null,
      after_json: null, changes_json: JSON.stringify(changes), created_by_type: "user", created_by: this.authority, agent_run_id: null, created_at: Date.now() }).execute();
    await this.event(tx, "resource", id, base + 1, type, changes);
  }

  private async event(tx: DatabaseContext, type: string, id: string, version: number, event: string, payload: object): Promise<void> {
    await tx.insertInto("change_outbox").values({ event_id: this.native.uuid(), aggregate_type: type, aggregate_id: id,
      aggregate_version: version, event_type: event, payload_json: JSON.stringify(payload), created_at: Date.now() }).execute();
  }
}
