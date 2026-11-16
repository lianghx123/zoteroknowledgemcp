import { ModelError, spaceKey, type RetrievalConfig } from "../shared/contracts/retrieval";
import { EmbeddingRepository } from "../repositories/embeddings";
import { vectorFromBlob } from "../providers/models";
import { VectorIndex } from "./vector-index";
import { withVectorSnapshotLock } from "../storage/vector-snapshot-lock";
import { sql } from "kysely";
import { blockPredicate, type RetrievalFilters } from "./retrieval-filters";

/** Owned by one retrieval invocation; never reused as a cross-request cache. */
export interface VectorSearchSession {
  filters?: RetrievalFilters;
  completeSmallScope?: boolean;
  exhausted?: boolean;
  prepared?: {
    profile: string; identity: string; scope: string; filters: string;
    labels: number[]; reverse: Map<number, string>; eligible?: ReadonlySet<string>;
  };
}

export class VectorStore {
  readonly index: VectorIndex;
  private labels = new Map<string, number>();
  private reverse = new Map<number, string>();
  private profile = "";
  private mode = "";
  private identity = "";
  private sequence = 0;
  private removed = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readable = false;
  status: "idle" | "building" | "ready" | "failed" = "idle";
  constructor(private readonly repository: EmbeddingRepository, rootURI: string) { this.index = new VectorIndex(rootURI); }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.tail.then(() => { if (this.closed) throw new Error("index-closed"); return operation(); });
    this.tail = work.catch(() => {}); return work;
  }
  sync(profile: string, config: RetrievalConfig, signal: AbortSignal, force = false): Promise<void> {
    return this.exclusive(async () => {
      const check = () => { if (this.closed) throw new Error("index-closed"); signal.throwIfAborted(); };
      const repo = this.repository, db = repo.db, rows = await repo.activeVectors(profile).orderBy("e.id").execute();
      const event = await db.selectFrom("change_outbox").select(eb => eb.fn.max<number>("event_seq").as("sequence")).executeTakeFirstOrThrow();
      const hash = await repo.port.hash(JSON.stringify(rows.map(row => row.id)));
      const reset = force || this.profile !== profile || this.mode !== config.indexMode || this.status === "failed";
      this.status = "building";
      try {
        check();
        if (reset) {
          this.readable = false;
          await this.index.open(config.dimensions, config.indexMode); this.labels.clear(); this.reverse.clear(); this.sequence = 0; this.removed = 0;
          this.profile = profile; this.mode = config.indexMode; this.identity = spaceKey(config);
          const snapshot = force ? undefined : await db.selectFrom("vector_snapshot_state").selectAll().where("profile_id", "=", profile).executeTakeFirst();
          const build = snapshot?.build_id && await db.selectFrom("search_index_builds").select(["engine_version", "configuration_hash"]).where("id", "=", snapshot.build_id).executeTakeFirst();
          if (snapshot && snapshot.format_version === 1 && build && build.engine_version === "2.26.5-cap32-stream1"
            && build.configuration_hash === await repo.port.hash(`${profile}:${config.indexMode}:16:100:200:32`)
            && snapshot.mode === config.indexMode && snapshot.corpus_hash === hash && snapshot.snapshot_path && snapshot.snapshot_hash && snapshot.snapshot_bytes) {
            try {
              const entries = await db.selectFrom("vector_index_entries").select(["embedding_id", "engine_label"]).where("build_id", "=", snapshot.build_id!).where("state", "=", "indexed").execute();
              const expected = new Set(rows.map(row => row.id));
              if (entries.length !== expected.size || entries.some(row => !expected.has(row.embedding_id) || !Number.isSafeInteger(Number(row.engine_label)) || Number(row.engine_label) <= 0)) throw new Error("index-labels");
              await this.index.restore(snapshot.snapshot_path, snapshot.snapshot_hash, snapshot.snapshot_bytes);
              check();
              for (const row of entries) { const label = Number(row.engine_label); this.labels.set(row.embedding_id, label); this.reverse.set(label, row.embedding_id); this.sequence = Math.max(this.sequence, label); }
              this.removed = snapshot.mutations; this.readable = true; this.status = "ready"; return;
            } catch { check(); await this.index.open(config.dimensions, config.indexMode); }
          }
        }
        const wanted = new Set(rows.map(row => row.id)), stale = [...this.labels].filter(([id]) => !wanted.has(id));
        if (stale.length) {
          await this.index.remove(stale.map(([, label]) => label)); this.removed += stale.length;
          for (const [id, label] of stale) { this.labels.delete(id); this.reverse.delete(label); }
        }
        if (this.removed >= Math.max(1000, rows.length * 0.2)) {
          check();
          await this.index.open(config.dimensions, config.indexMode); this.labels.clear(); this.reverse.clear(); this.sequence = 0; this.removed = 0;
        }
        const missing = rows.filter(row => !this.labels.has(row.id));
        for (let start = 0; start < missing.length; start += 100) {
          check(); const batch = missing.slice(start, start + 100);
          const vectors = await db.selectFrom("block_embeddings").select(["id", "vector"]).where("id", "in", batch.map(row => row.id)).execute();
          const additions = vectors.map(row => ({ label: ++this.sequence, vector: vectorFromBlob(row.vector, config.dimensions), id: row.id }));
          await this.index.add(additions);
          for (const row of additions) { this.labels.set(row.id, row.label); this.reverse.set(row.label, row.id); }
        }
        check(); this.readable = true;
        if (missing.length || stale.length || reset || force) await this.save(hash, config, signal, Number(event.sequence ?? 0));
        check();
        this.status = "ready";
      } catch (error) { this.status = "failed"; throw error; }
    });
  }
  private async save(corpusHash: string, config: RetrievalConfig, signal: AbortSignal, eventSequence: number): Promise<void> {
    const repo = this.repository, id = repo.port.uuid(), path = PathUtils.join(Zotero.DataDirectory.dir, "knowledgemcp", "vectors", `${id}.usearch`);
    return withVectorSnapshotLock(path, () => this.publishSnapshot(id, path, corpusHash, config, signal, eventSequence));
  }
  private async publishSnapshot(id: string, path: string, corpusHash: string, config: RetrievalConfig, signal: AbortSignal, eventSequence: number): Promise<void> {
    const repo = this.repository;
    const previous = await repo.db.selectFrom("vector_snapshot_state").select("snapshot_path").where("profile_id", "=", this.profile).executeTakeFirst();
    let committed = false;
    const relative = `vectors/${id}.usearch`;
    for (const suffix of ["", ".tmp"]) await repo.db.insertInto("file_cleanup").values({ relative_path: `${relative}${suffix}`, created_at: Date.now() }).onConflict(c => c.column("relative_path").doNothing()).execute();
    try {
      const snapshot = await this.index.save(path, signal), now = Date.now();
      await repo.db.transaction().execute(async tx => {
        await tx.updateTable("search_index_builds").set({ state: "retired" }).where("profile_id", "=", this.profile).where("state", "=", "active").execute();
        await tx.insertInto("search_index_builds").values({ id, kind: "vector", profile_id: this.profile, engine_key: "usearch", engine_version: "2.26.5-cap32-stream1",
          configuration_hash: await repo.port.hash(`${this.profile}:${config.indexMode}:16:100:200:32`), corpus_fingerprint: corpusHash, state: "active", created_at: now, activated_at: now,
          snapshot_event_seq: eventSequence, last_applied_event_seq: eventSequence,
          manifest_json: JSON.stringify({ ...snapshot, dimensions: config.dimensions, scalar: config.indexMode, arenaMiB: 32 }) }).execute();
        for (const [embedding, label] of this.labels) await tx.insertInto("vector_index_entries").values({ build_id: id, engine_label: String(label), embedding_id: embedding,
          profile_id: this.profile, state: "indexed", indexed_at: now }).execute();
        const value = { build_id: id, mode: config.indexMode, snapshot_path: path, snapshot_hash: snapshot.hash, snapshot_bytes: snapshot.bytes, corpus_hash: corpusHash, mutations: this.removed, updated_at: now };
        await tx.insertInto("vector_snapshot_state").values({ ...value, profile_id: this.profile }).onConflict(c => c.column("profile_id").doUpdateSet(value)).execute();
        await tx.deleteFrom("file_cleanup").where("relative_path", "in", [relative, `${relative}.tmp`]).execute();
        const oldFile = previous?.snapshot_path?.split(/[\\/]/).at(-1);
        if (oldFile && /^[a-f0-9-]{36}\.usearch$/.test(oldFile)) await tx.insertInto("file_cleanup").values({ relative_path: `vectors/${oldFile}`, created_at: now }).onConflict(c => c.column("relative_path").doNothing()).execute();
        await repo.pruneRetiredIndexes(tx, this.profile);
      }); committed = true;
    } finally {
      if (!committed) {
        // A lost COMMIT acknowledgement must not remove an activated snapshot.
        let owned = true;
        try { owned = Boolean(await repo.db.selectFrom("vector_snapshot_state").select("profile_id").where("snapshot_path", "=", path).executeTakeFirst()); }
        catch { /* Keep the file until ownership can be checked during recovery. */ }
        if (!owned) await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
    if (previous?.snapshot_path && previous.snapshot_path !== path) {
      try { await IOUtils.remove(previous.snapshot_path, { ignoreAbsent: true }); } catch { /* Durable cleanup retries later. */ }
    }
  }
  async search(vector: Float32Array, resourceIDs: readonly string[], limit: number, identity = this.identity, eligible?: ReadonlySet<string>, session: VectorSearchSession = {}): Promise<Array<{ embeddingID: string; score: number }>> {
    if (!this.readable) await this.tail;
    if (identity !== this.identity) throw new ModelError("initializing");
    if (!this.readable || this.status === "failed") throw new ModelError("index-unavailable", true);
    const profile = this.profile, scope = JSON.stringify(resourceIDs), filters = JSON.stringify(session.filters ?? {});
    let prepared = session.prepared;
    if (prepared && (prepared.profile !== profile || prepared.identity !== identity || prepared.scope !== scope || prepared.filters !== filters || prepared.eligible !== eligible)) throw new ModelError("config-changed");
    if (!prepared) {
      // Resolve current sources once, then use the existing profile/state/generation
      // index for each source. CROSS JOIN keeps SQLite from repeating source/version
      // probes for every embedding, including in databases without ANALYZE statistics.
      const rows = (await sql<{ id: string; resource_id: string }>`
        WITH sources AS MATERIALIZED (
          SELECT s.resource_id, s.active_generation_id
          FROM resource_sources s JOIN content_generations g ON g.id = s.active_generation_id
          WHERE s.resource_id IN (SELECT value FROM json_each(${scope})) AND s.deleted_at IS NULL
            AND g.source_version = s.source_version AND g.content_version = s.content_version
        )
        SELECT e.id, s.resource_id FROM sources s
        CROSS JOIN block_embeddings e ON e.generation_id = s.active_generation_id
          AND e.profile_id = ${profile} AND e.state = 'active'
        CROSS JOIN embedding_segments seg ON seg.embedding_id = e.id
        CROSS JOIN content_blocks b ON b.id = seg.block_id
        WHERE ${session.filters ? sql`seg.profile_id = ${profile} AND ${blockPredicate(session.filters)}` : sql`1=1`}`.execute(this.repository.db)).rows;
      if (profile !== this.profile || identity !== this.identity) throw new ModelError("config-changed");
      const allowed = new Set(resourceIDs), reverse = new Map<number, string>();
      for (const row of rows) {
        if (!allowed.has(row.resource_id) || eligible && !eligible.has(row.id)) continue;
        const label = this.labels.get(row.id);
        if (label !== undefined) reverse.set(label, row.id);
      }
      prepared = session.prepared = { profile, identity, scope, filters, eligible, reverse, labels: [...reverse.keys()] };
    }
    // The engine already uses exact search at this size. When the document budget
    // exceeds the entire scope, exhaust it once rather than doubling toward it.
    session.exhausted = Boolean(session.completeSmallScope && prepared.labels.length <= 5000);
    const result = await this.index.query(vector, prepared.labels, session.exhausted ? prepared.labels.length : limit);
    if (profile !== this.profile || identity !== this.identity) throw new ModelError("config-changed");
    return result.map(row => ({ embeddingID: prepared.reverse.get(row.label)!, score: row.score }));
  }
  async close(): Promise<void> {
    this.closed = true; this.readable = false; this.index.close();
    try { await this.tail; }
    finally { this.index.close(); this.readable = false; this.labels.clear(); this.reverse.clear(); }
  }
  invalidate(): Promise<void> { return this.exclusive(async () => { this.readable = false; this.index.close(); this.labels.clear(); this.reverse.clear(); this.profile = ""; this.mode = ""; this.identity = ""; this.status = "idle"; }); }
}
