import { sql, type Kysely } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import { ModelError, embeddingSpace, spaceKey, type RetrievalConfig } from "../shared/contracts/retrieval";
import { ZoteroParsingPort } from "../integrations/zotero/parsing-port";
import { embeddingAdmission, splitEmbeddingInput, searchTokens } from "../services/embedding-input";
import { modelProviders, vectorBlob } from "../providers/models";
import { fulltextProfile, searchOffsets } from "../services/search-text";

export class EmbeddingRepository {
  readonly port = new ZoteroParsingPort();
  constructor(readonly db: Kysely<Database>) {}
  async pruneRetiredIndexes(tx: DatabaseContext, profile?: string): Promise<void> {
    let retired = tx.selectFrom("search_index_builds as b").select("b.id")
      .where("b.kind", "=", "vector").where("b.state", "=", "retired")
      .where(eb => eb.not(eb.exists(eb.selectFrom("vector_snapshot_state as s").select("s.profile_id").whereRef("s.build_id", "=", "b.id"))));
    if (profile) retired = retired.where("b.profile_id", "=", profile);
    // A retained snapshot must keep its labels, including other vector spaces.
    await tx.deleteFrom("vector_index_entries").where("build_id", "in", retired).execute();
    await tx.deleteFrom("search_index_builds").where("id", "in", retired).execute();
  }
  async profile(config: RetrievalConfig, current: () => boolean = () => true): Promise<string> {
    const identity = spaceKey(config), id = await this.port.hash(identity), space = embeddingSpace(config), now = Date.now();
    const rerankHash = await this.port.hash(JSON.stringify({ provider: config.rerank.provider, model: config.rerank.model, endpoint: config.rerank.endpoint, options: config.rerank.options ?? {} }));
    await this.db.transaction().execute(async tx => {
      if (!current()) throw new ModelError("config-changed");
      await tx.insertInto("provider_profiles").values({ id: `embedding-${id}`, name: config.embedding.provider, kind: "embedding", adapter_key: config.embedding.provider,
        adapter_version: "1", endpoint_url: config.embedding.endpoint, credential_ref: config.embedding.credentialRef, configuration_hash: id, created_at: now })
        .onConflict(c => c.column("id").doUpdateSet({ credential_ref: config.embedding.credentialRef, enabled: config.enabled ? 1 : 0 })).execute();
      await tx.insertInto("provider_profiles").values({ id: `rerank-${rerankHash}`, name: config.rerank.provider, kind: "rerank", adapter_key: config.rerank.provider,
        adapter_version: "1", endpoint_url: config.rerank.endpoint, credential_ref: config.shareCredential ? config.embedding.credentialRef : config.rerank.credentialRef,
        configuration_hash: rerankHash, config_json: JSON.stringify({ model: config.rerank.model, options: config.rerank.options ?? {} }), created_at: now })
        .onConflict(c => c.column("id").doUpdateSet({ credential_ref: config.shareCredential ? config.embedding.credentialRef : config.rerank.credentialRef, enabled: config.enabled ? 1 : 0 })).execute();
      await tx.updateTable("embedding_profiles").set({ is_active: 0 }).where("is_active", "=", 1).execute();
      await tx.insertInto("embedding_profiles").values({ id, profile_key: identity, provider_profile_id: `embedding-${id}`, model: space.model, model_revision: null,
        dimensions: space.dimensions, normalization: "l2", input_template_version: space.inputVersion, admission_version: space.admissionVersion,
        configuration_hash: id, created_at: now }).onConflict(c => c.column("id").doNothing()).execute();
      await tx.updateTable("embedding_profiles").set({ is_active: 1 }).where("id", "=", id).execute();
      if (!current()) throw new ModelError("config-changed");
    }); return id;
  }
  async clear(config: RetrievalConfig): Promise<void> {
    const id = await this.port.hash(spaceKey(config));
    await this.db.transaction().execute(async tx => {
      const snapshot = await tx.selectFrom("vector_snapshot_state").select("snapshot_path").where("profile_id", "=", id).executeTakeFirst();
      const file = snapshot?.snapshot_path?.split(/[\\/]/).at(-1);
      if (file && /^[a-f0-9-]{36}\.usearch$/.test(file)) await tx.insertInto("file_cleanup").values({ relative_path: `vectors/${file}`, created_at: Date.now() })
        .onConflict(c => c.column("relative_path").doNothing()).execute();
      await tx.updateTable("processing_jobs").set({ state: "cancelled", error_code: "configuration-cleared", cancel_requested_at: Date.now(), finished_at: Date.now(), lease_owner: null, execution_token: null, lease_expires_at: null, updated_at: Date.now() }).where("kind", "=", "embed").where("embedding_profile_id", "=", id).execute();
      await tx.deleteFrom("embedding_segments").where("profile_id", "=", id).execute();
      await tx.deleteFrom("vector_index_entries").where("profile_id", "=", id).execute();
      await tx.deleteFrom("block_embeddings").where("profile_id", "=", id).execute();
      await tx.deleteFrom("vector_snapshot_state").where("profile_id", "=", id).execute();
      await tx.updateTable("search_index_builds").set({ state: "retired" }).where("profile_id", "=", id).execute();
      await this.pruneRetiredIndexes(tx, id);
    });
  }
  async reconcile(profile: string, config: RetrievalConfig, forceResources?: readonly string[]): Promise<void> {
    const sources = await this.db.selectFrom("resource_sources as s").innerJoin("content_generations as g", "g.id", "s.active_generation_id")
      .select(["s.id", "s.resource_id", "s.active_generation_id", "s.source_version", "s.content_version"])
      .where("s.deleted_at", "is", null).where("g.state", "in", ["ready", "partial"])
      .whereRef("g.source_version", "=", "s.source_version").whereRef("g.content_version", "=", "s.content_version")
      .where(eb => eb.exists(eb.selectFrom("library_resources").innerJoin("knowledge_libraries", "knowledge_libraries.id", "library_resources.library_id")
        .select("library_resources.id").whereRef("library_resources.resource_id", "=", "s.resource_id").where("library_resources.deleted_at", "is", null).where("knowledge_libraries.deleted_at", "is", null))).execute();
    for (const source of sources) {
      if (forceResources && !forceResources.includes(source.resource_id)) continue;
      const dedup = `${profile}:${source.active_generation_id}`;
      const suppressed = await this.db.selectFrom("plugin_state").select("key").where("key", "=", `embedding-cancel:${dedup}`).executeTakeFirst();
      if (suppressed && !forceResources) continue;
      if (forceResources) await this.db.deleteFrom("plugin_state").where("key", "=", `embedding-cancel:${dedup}`).execute();
      const previous = await this.db.selectFrom("processing_jobs").select(["id", "state", "cancel_requested_at", "error_code"]).where("kind", "=", "embed").where("dedup_key", "=", dedup).orderBy("created_at", "desc").executeTakeFirst();
      if (forceResources && previous && ["pending", "running", "waiting"].includes(previous.state)) {
        await this.db.updateTable("processing_jobs").set({ payload_json: sql<string>`json_remove(payload_json, '$.hidden')`, updated_at: Date.now() })
          .where("id", "=", previous.id).execute();
      }
      if (previous && previous.error_code !== "configuration-cleared" && (!forceResources || ["pending", "running"].includes(previous.state))) continue;
      const now = Date.now();
      await this.db.insertInto("processing_jobs").values({ id: this.port.uuid(), kind: "embed", dedup_key: dedup, resource_id: source.resource_id, source_id: source.id,
        generation_id: source.active_generation_id, embedding_profile_id: profile, expected_source_version: source.source_version, expected_content_version: source.content_version,
        next_run_at: now, created_at: now, updated_at: now, max_failures: 3, payload_json: JSON.stringify({ provider: config.embedding.provider, model: config.embedding.model }) }).onConflict(c => c.doNothing()).execute();
    }
    const maximum = await this.db.selectFrom("change_outbox").select(sql<number>`coalesce(max(event_seq), 0)`.as("sequence")).executeTakeFirstOrThrow();
    await this.db.insertInto("consumer_checkpoints").values({ consumer_key: `embedding:${profile}`, last_event_seq: maximum.sequence, updated_at: Date.now() })
      .onConflict(c => c.column("consumer_key").doUpdateSet({ last_event_seq: maximum.sequence, updated_at: Date.now() })).execute();
  }
  async prepare(generation: string, profile: string, config: RetrievalConfig): Promise<void> {
    const blocks = await this.db.selectFrom("content_blocks").selectAll().where("generation_id", "=", generation).orderBy("canonical_order").execute();
    for (const block of blocks) {
      const text = block.content_normalized ?? block.content_markdown;
      const flags = embeddingAdmission(block.block_type, text, JSON.parse(block.quality_flags_json) as string[]);
      const segments = flags.length ? [{ ordinal: 0, start: 0, end: text.length, overlap: 0, text: "" }] : splitEmbeddingInput(text, modelProviders.get(config.embedding.provider).definition.maxInputCharacters);
      for (const segment of segments) {
        const hash = await this.port.hash(JSON.stringify({ text: segment.text, start: segment.start, end: segment.end }));
        await this.db.insertInto("embedding_segments").values({ id: await this.port.hash(`${block.id}:${profile}:${segment.ordinal}`), block_id: block.id, profile_id: profile,
          ordinal: segment.ordinal, start_offset: segment.start, end_offset: segment.end, overlap: segment.overlap, input_text: segment.text, input_hash: hash,
          skip_reason: flags.length ? flags.join(",") : null, embedding_id: null, created_at: Date.now() }).onConflict(c => c.columns(["block_id", "profile_id", "ordinal"]).doNothing()).execute();
      }
    }
  }
  async pending(generation: string, profile: string, limit: number) {
    return this.db.selectFrom("embedding_segments as s").innerJoin("content_blocks as b", "b.id", "s.block_id")
      .select(["s.id", "s.block_id", "s.input_hash", "s.input_text"]).where("b.generation_id", "=", generation).where("s.profile_id", "=", profile)
      .where("s.skip_reason", "is", null).where("s.embedding_id", "is", null).orderBy("b.canonical_order").orderBy("s.ordinal").limit(limit).execute();
  }
  /** Apply the same admission boundary to scheduling, HTTP dispatch and commits. */
  eligibleJobs(profile: string, tx: DatabaseContext = this.db) {
    return tx.selectFrom("processing_jobs as j")
      .innerJoin("resource_sources as s", "s.id", "j.source_id")
      .innerJoin("content_generations as g", "g.id", "j.generation_id")
      .innerJoin("knowledge_resources as r", "r.id", "j.resource_id")
      .innerJoin("embedding_profiles as p", "p.id", "j.embedding_profile_id")
      .selectAll("j").where("j.kind", "=", "embed").where("j.embedding_profile_id", "=", profile)
      .where("j.cancel_requested_at", "is", null).where("p.is_active", "=", 1)
      .where("s.deleted_at", "is", null).where("r.deleted_at", "is", null).where("r.status", "=", "active")
      .whereRef("s.resource_id", "=", "j.resource_id").whereRef("g.source_id", "=", "s.id")
      .whereRef("s.active_generation_id", "=", "j.generation_id").where("g.state", "in", ["ready", "partial"])
      .whereRef("s.source_version", "=", "j.expected_source_version").whereRef("s.content_version", "=", "j.expected_content_version")
      .whereRef("g.source_version", "=", "s.source_version").whereRef("g.content_version", "=", "s.content_version")
      .where(eb => eb.exists(eb.selectFrom("library_resources as lr").innerJoin("knowledge_libraries as l", "l.id", "lr.library_id")
        .select("lr.id").whereRef("lr.resource_id", "=", "j.resource_id").where("lr.deleted_at", "is", null)
        .where("l.deleted_at", "is", null).where("l.status", "=", "active")));
  }
  async guard(jobID: string, token: string, profile: string, tx: DatabaseContext = this.db) {
    const job = await this.eligibleJobs(profile, tx).where("j.id", "=", jobID).where("j.execution_token", "=", token)
      .where("j.state", "=", "running").executeTakeFirst();
    if (!job) throw new ModelError("embedding-stale");
    return job;
  }
  async hideHistory(id: string): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const job = await tx.selectFrom("processing_jobs").select(["source_id", "generation_id", "state"])
        .where("id", "=", id).where("kind", "=", "embed").executeTakeFirst();
      if (!job?.source_id || !job.generation_id || !["succeeded", "failed", "cancelled"].includes(job.state)) throw new ModelError("stale");
      // A workflow combines all retained profiles/attempts for this generation.
      // Keep their deduplication and cancellation state when hiding that workflow.
      await tx.updateTable("processing_jobs").set({ payload_json: sql<string>`json_set(payload_json, '$.hidden', json('true'))`, updated_at: Date.now() })
        .where("kind", "=", "embed").where("source_id", "=", job.source_id).where("generation_id", "=", job.generation_id).execute();
    });
  }
  async commit(jobID: string, token: string, profile: string, rows: Array<{ id: string; block_id: string; input_hash: string }>, vectors: Float32Array[], current: () => boolean = () => true): Promise<void> {
    if (rows.length !== vectors.length) throw new Error("embedding-response");
    await this.db.transaction().execute(async tx => {
      if (!current()) throw new Error("embedding-stale");
      const job = await this.guard(jobID, token, profile, tx);
      const now = Date.now();
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index], id = this.port.uuid(), vector = vectors[index];
        await tx.insertInto("block_embeddings").values({ id, generation_id: job.generation_id!, content_block_id: row.block_id, profile_id: profile, dimensions: vector.length,
          input_text_hash: row.input_hash, vector: vectorBlob(vector), created_at: now, updated_at: now }).onConflict(c => c.columns(["content_block_id", "profile_id", "input_text_hash"]).doNothing()).execute();
        const embedding = await tx.selectFrom("block_embeddings").select("id").where("content_block_id", "=", row.block_id).where("profile_id", "=", profile).where("input_text_hash", "=", row.input_hash).executeTakeFirstOrThrow();
        await tx.updateTable("embedding_segments").set({ embedding_id: embedding.id }).where("id", "=", row.id).execute();
      }
      await tx.updateTable("processing_jobs").set({ updated_at: now, heartbeat_at: now, lease_expires_at: now + 600000,
        checkpoint_json: JSON.stringify({ stage: "embed", lastSegment: rows.at(-1)?.id }) }).where("id", "=", jobID).execute();
      if (!current()) throw new Error("embedding-stale");
    });
  }
  activeVectors(profile: string) {
    return this.db.selectFrom("block_embeddings as e").innerJoin("resource_sources as s", "s.active_generation_id", "e.generation_id")
      .innerJoin("content_generations as g", "g.id", "e.generation_id")
      .innerJoin("embedding_segments as seg", "seg.embedding_id", "e.id")
      .select(["e.id", "e.generation_id", "e.content_block_id", "s.resource_id", "seg.id as segment_id"])
      .where("e.profile_id", "=", profile).where("e.state", "=", "active").where("s.deleted_at", "is", null)
      .whereRef("g.source_version", "=", "s.source_version").whereRef("g.content_version", "=", "s.content_version");
  }
  async projectFulltext(): Promise<void> {
    // Keyset pages bound both database reads and parameter counts.
    let cursor = "";
    while (true) {
      const rows = await this.db.selectFrom("content_blocks as b").innerJoin("resource_sources as s", "s.active_generation_id", "b.generation_id")
        .select(["b.id", "b.generation_id", "b.content_markdown", "s.id as source_id", "s.resource_id", "s.content_version"])
        .where("b.id", ">", cursor).where("s.deleted_at", "is", null)
        .where(eb => eb.not(eb.exists(eb.selectFrom("search_documents").select("rowid").whereRef("block_id", "=", "b.id").where("tokenizer_profile", "=", fulltextProfile))))
        .orderBy("b.id").limit(100).execute();
      if (!rows.length) break;
      await this.db.transaction().execute(async tx => {
        for (const row of rows) {
          const existing = await tx.selectFrom("search_documents").select(["rowid", "tokenizer_profile"]).where("block_id", "=", row.id).executeTakeFirst();
          if (existing?.tokenizer_profile === fulltextProfile) continue;
          const value = { body: row.content_markdown, search_text: searchTokens(row.content_markdown), body_offsets_json: JSON.stringify(searchOffsets(row.content_markdown)),
            tokenizer_profile: fulltextProfile, indexed_version: Math.max(1, row.content_version), updated_at: Date.now() };
          if (existing) await tx.updateTable("search_documents").set(value).where("rowid", "=", existing.rowid).execute();
          else await tx.insertInto("search_documents").values({ ...value, document_kind: "block", resource_id: row.resource_id, source_id: row.source_id,
            generation_id: row.generation_id, block_id: row.id }).execute();
        }
      }); cursor = rows.at(-1)!.id;
    }
    const resources = await this.db.selectFrom("knowledge_resources as r").select("r.id").where("r.deleted_at", "is", null)
      .where(eb => eb.not(eb.exists(eb.selectFrom("search_documents as d").select("d.rowid").whereRef("d.resource_id", "=", "r.id")
        .where("d.document_kind", "=", "metadata").where("d.tokenizer_profile", "=", fulltextProfile).whereRef("d.indexed_version", "=", "r.version")))).execute();
    for (const candidate of resources) await this.db.transaction().execute(async tx => {
      const resource = await tx.selectFrom("knowledge_resources").select(["id", "title", "abstract", "version", "contributors_json", "metadata_json", "publication_title", "doi", "publication_date"])
        .where("id", "=", candidate.id).where("deleted_at", "is", null).executeTakeFirst();
      if (!resource) return;
      const current = await tx.selectFrom("search_documents").select(["rowid", "indexed_version", "tokenizer_profile"]).where("resource_id", "=", resource.id).where("document_kind", "=", "metadata").executeTakeFirst();
      if (current?.indexed_version === resource.version && current.tokenizer_profile === fulltextProfile) return;
      const names = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) ? value.map(names).join(" ")
        : value && typeof value === "object" ? Object.values(value).map(names).join(" ") : "";
      const contributors = names(JSON.parse(resource.contributors_json));
      const metadata = names(JSON.parse(resource.metadata_json));
      const value = { title: resource.title, contributors, search_text: searchTokens(`${resource.title} ${contributors} ${metadata} ${resource.abstract ?? ""} ${resource.publication_title ?? ""} ${resource.doi ?? ""} ${resource.publication_date ?? ""}`),
        tokenizer_profile: fulltextProfile, indexed_version: resource.version, updated_at: Date.now() };
      if (current) await tx.updateTable("search_documents").set(value).where("rowid", "=", current.rowid).execute();
      else await tx.insertInto("search_documents").values({ ...value, document_kind: "metadata", resource_id: resource.id, source_id: null, generation_id: null, block_id: null }).execute();
    });
  }
}
