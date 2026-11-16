import { sql, type Kysely } from "kysely";
import type { Database } from "../database/types";
import type { ImportTask, ImportTaskAction, ImportTaskSource } from "../shared/contracts/import-tasks";
import { ModelCredentials } from "../integrations/zotero/model-credentials";
import { EmbeddingRepository } from "../repositories/embeddings";
import { ModelGateway } from "./model-gateway";
import { RetrievalConfigFile } from "./retrieval-config";
import { VectorStore } from "./vector-store";
import { hostRuntime, hostSetTimeout, hostClearTimeout } from "../core/host-runtime";
import { ModelError, type RetrievalConfig } from "../shared/contracts/retrieval";

export class EmbeddingService implements ImportTaskSource {
  readonly repository: EmbeddingRepository;
  readonly config: RetrievalConfigFile;
  readonly gateway: ModelGateway;
  readonly store: VectorStore;
  profile = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private ticking: Promise<void> = Promise.resolve();
  private controllers = new Map<string, AbortController>();
  private lifetime: AbortController;
  private listeners = new Set<() => void>();
  private tasks: ImportTask[] = [];
  private refreshEpoch = 0;
  private refreshes = new Set<Promise<void>>();
  private operations = new Set<Promise<unknown>>();
  private closing: Promise<void> | undefined;
  private appliedConfig: RetrievalConfig | undefined;
  private clearing = 0;
  private awaitingConfig: RetrievalConfig | undefined;
  private configWaiters = new Set<() => void>();
  private eventSequence = -1;
  private unsubscribe: (() => void) | undefined;
  private credentials = new ModelCredentials();
  constructor(db: Kysely<Database>, rootURI: string) {
    this.repository = new EmbeddingRepository(db);
    this.config = new RetrievalConfigFile(() => {
      this.awaitingConfig = undefined;
      for (const controller of this.controllers.values()) controller.abort();
      this.wakeConfigWaiters();
    });
    this.gateway = new ModelGateway(() => this.config.current, ref => this.credentials.get(ref));
    this.store = new VectorStore(this.repository, rootURI);
    this.lifetime = new (hostRuntime().AbortController)();
  }
  private configStarted = false;
  beforeWork?: () => Promise<void>;
  private starting: Promise<void> = Promise.resolve();
  private accept<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("initializing"));
    const pending = operation(); this.operations.add(pending);
    void pending.then(() => this.operations.delete(pending), () => this.operations.delete(pending));
    return pending;
  }
  private current(config: RetrievalConfig): boolean {
    return !this.stopped && !this.clearing && this.config.current === config && this.awaitingConfig !== config;
  }
  private wakeConfigWaiters(): void {
    for (const resolve of this.configWaiters) resolve();
    this.configWaiters.clear();
  }
  start(schedule = true): Promise<void> { return this.starting = this.restore(schedule); }
  private async restore(schedule: boolean): Promise<void> {
    if (this.stopped) return;
    if (!this.configStarted) { await this.config.start(); this.configStarted = true; }
    if (this.stopped) return;
    await this.repository.db.transaction().execute(tx => this.repository.pruneRetiredIndexes(tx));
    await this.repository.db.updateTable("processing_jobs").set({ state: "pending", lease_owner: null, execution_token: null, lease_expires_at: null, updated_at: Date.now() })
      .where("kind", "=", "embed").where("state", "=", "running").execute();
    await this.refresh(); if (schedule) this.resumeBackground();
  }
  /** Local recovery never submits embedding or rerank requests. */
  restoreIndex(): Promise<void> { return this.accept(async () => {
    while (!this.stopped) {
      const config = this.config.current;
      if (!this.current(config)) { await new (hostRuntime().Promise)<void>(resolve => this.configWaiters.add(resolve)); continue; }
      let profile: string;
      try { profile = await this.repository.profile(config, () => this.current(config)); }
      catch (error) {
        if (error instanceof ModelError && error.code === "config-changed" && !this.stopped) continue;
        throw error;
      }
      if (!this.current(config)) continue;
      this.profile = profile;
      if (config.enabled) await this.store.sync(profile, config, this.lifetime.signal);
      if (this.current(config)) return;
    }
  }); }
  /** A document commit refreshes local index state without waiting for settings or calling a provider. */
  refreshContent(generationID: string): Promise<void> { return this.accept(async () => {
    const config = this.config.current;
    if (!this.current(config)) return;
    const profile = await this.repository.profile(config, () => this.current(config));
    if (!this.current(config)) return;
    this.profile = profile;
    if (config.enabled) {
      await this.repository.prepare(generationID, profile, config);
      if (this.current(config)) await this.store.sync(profile, config, this.lifetime.signal);
    }
  }); }
  resumeBackground(): void { if (!this.stopped && this.timer === undefined) this.schedule(); }
  observe(subscribe: (listener: () => void) => () => void): void {
    this.unsubscribe = subscribe(() => { this.eventSequence = -1; void this.refresh().catch(() => { if (!this.stopped) Zotero.debug("[ZoteroKnowledgeMCP] Vector task refresh will retry."); }); });
  }
  private schedule(): void {
    if (!this.stopped) this.timer = hostSetTimeout(() => { this.ticking = this.tick().catch(() => { Zotero.debug("[ZoteroKnowledgeMCP] Vector reconciliation failed."); }).finally(() => this.schedule()); }, 2000);
  }
  tick(): Promise<void> { return this.stopped ? Promise.resolve() : this.accept(() => this.reconcile()); }
  private async reconcile(): Promise<void> {
    const config = this.config.current;
    if (!this.current(config)) return;
    const head = await this.repository.db.selectFrom("change_outbox").select(eb => eb.fn.max<number>("event_seq").as("sequence")).executeTakeFirstOrThrow();
    const sequence = Number(head.sequence ?? 0), changed = this.eventSequence !== sequence;
    if (changed) await this.repository.projectFulltext();
    if (!this.current(config)) return;
    const reconfigured = this.appliedConfig !== config;
    if (reconfigured) { this.profile = await this.repository.profile(config, () => this.current(config)); this.appliedConfig = config; }
    if (!this.current(config)) return;
    const profile = this.profile;
    if (!config.enabled) {
      if (this.store.status !== "idle") await this.store.invalidate();
      this.eventSequence = sequence; if (changed || reconfigured) await this.refresh(); return;
    }
    try { this.credentials.get(config.embedding.credentialRef); } catch {
      if (this.store.status !== "idle") await this.store.invalidate();
      if (changed || reconfigured) await this.refresh(); return;
    }
    if (config.autoEmbed && (changed || reconfigured)) await this.repository.reconcile(profile, config);
    if (!this.current(config)) return;
    let executed = false;
    if (!config.paused) {
      const jobs = await this.repository.eligibleJobs(profile).where("j.state", "=", "pending").orderBy("j.created_at").limit(config.concurrency).execute();
      await Promise.allSettled(jobs.map(job => this.execute(job.id, config, profile)));
      executed = jobs.length > 0;
    }
    if (!this.current(config)) return;
    if (!changed && !reconfigured && !executed && this.store.status === "ready") return;
    await this.store.sync(profile, config, this.lifetime.signal);
    if (!this.current(config)) return;
    this.eventSequence = sequence;
    await this.repository.db.updateTable("processing_jobs").set({ state: "succeeded", finished_at: Date.now(), updated_at: Date.now() })
      .where("kind", "=", "embed").where("embedding_profile_id", "=", profile).where("state", "=", "waiting")
      .where(eb => eb(eb.fn<string>("json_extract", ["checkpoint_json", eb.val("$.stage")]), "=", "index")).execute();
    await this.refresh();
  }
  private async execute(id: string, config: RetrievalConfig, profile: string): Promise<void> {
    if (!this.current(config)) return;
    const db = this.repository.db, token = this.repository.port.uuid();
    const controller = new (hostRuntime().AbortController)();
    this.controllers.set(id, controller);
    let failedSegments = 0;
    try {
      const claimed = await db.updateTable("processing_jobs").set({ state: "running", execution_token: token, lease_owner: "embedding-service", lease_expires_at: Date.now() + 600000,
        started_at: Date.now(), updated_at: Date.now() }).where("id", "=", id).where("embedding_profile_id", "=", profile).where("state", "=", "pending").where("cancel_requested_at", "is", null).executeTakeFirst();
      if (!Number(claimed.numUpdatedRows)) return;
      const guard = async () => {
        controller.signal.throwIfAborted();
        if (!this.current(config)) throw new ModelError("embedding-stale");
        await this.repository.guard(id, token, profile);
        controller.signal.throwIfAborted();
        if (!this.current(config)) throw new ModelError("embedding-stale");
      };
      const job = await this.repository.guard(id, token, profile);
      controller.signal.throwIfAborted();
      await this.repository.prepare(job.generation_id!, profile, config);
      while (!this.stopped) {
        controller.signal.throwIfAborted();
        const rows = await this.repository.pending(job.generation_id!, profile, config.batchSize); if (!rows.length) break;
        await guard();
        failedSegments = rows.length;
        const vectors = await this.gateway.embed(rows.map(row => row.input_text), controller.signal, false, config, guard);
        controller.signal.throwIfAborted();
        await this.repository.commit(id, token, profile, rows, vectors, () => !controller.signal.aborted && this.current(config)); failedSegments = 0; await this.refresh();
      }
      controller.signal.throwIfAborted();
      await db.updateTable("processing_jobs").set({ state: "waiting", finished_at: null, checkpoint_json: JSON.stringify({ stage: "index" }), updated_at: Date.now(), lease_owner: null, execution_token: null, lease_expires_at: null })
        .where("id", "=", id).where("execution_token", "=", token).execute();
    } catch (error) {
      const cancelled = controller.signal.aborted || !this.current(config) || error instanceof ModelError && error.code === "embedding-stale";
      await db.updateTable("processing_jobs").set({ state: cancelled ? "pending" : "failed", finished_at: cancelled ? null : Date.now(), error_code: cancelled ? null : error instanceof Error && /^[a-z0-9-]+$/.test(error.message) ? error.message : "embedding",
        failure_count: cancelled ? sql<number>`failure_count` : sql<number>`failure_count + 1`, checkpoint_json: JSON.stringify({ stage: "embed", failed: cancelled ? 0 : failedSegments }),
        lease_owner: null, execution_token: null, lease_expires_at: null, updated_at: Date.now() }).where("id", "=", id).where("execution_token", "=", token).execute();
    } finally { this.controllers.delete(id); }
  }
  snapshot(): readonly ImportTask[] { return this.tasks; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const pending = this.refreshTasks(++this.refreshEpoch); this.refreshes.add(pending);
    void pending.then(() => this.refreshes.delete(pending), () => this.refreshes.delete(pending));
    return pending;
  }
  private async refreshTasks(epoch: number): Promise<void> {
    if (this.stopped) return;
    const jobs = await this.repository.db.selectFrom("processing_jobs as j").innerJoin("knowledge_resources as r", "r.id", "j.resource_id")
      .innerJoin("embedding_profiles as p", "p.id", "j.embedding_profile_id")
      .innerJoin("resource_sources as src", "src.id", "j.source_id")
      .select(["j.id", "j.resource_id", "j.state", "j.error_code", "j.payload_json", "j.checkpoint_json", "r.title", "j.generation_id", "j.embedding_profile_id", "p.dimensions", "src.id as sourceID", "src.metadata_json as sourceMetadata"])
      .where("j.kind", "=", "embed").whereRef("j.generation_id", "=", "src.active_generation_id").orderBy("j.created_at", "desc").execute();
    const tasks = await Promise.all(jobs.filter(row => !(JSON.parse(row.payload_json) as { hidden?: boolean }).hidden).map(async row => {
      const segments = await this.repository.db.selectFrom("embedding_segments as s").innerJoin("content_blocks as b", "b.id", "s.block_id")
        .select(["s.embedding_id", "s.skip_reason"]).where("b.generation_id", "=", row.generation_id!).where("s.profile_id", "=", row.embedding_profile_id!).execute();
      const payload = JSON.parse(row.payload_json) as { provider: string; model: string };
      const indexing = row.state === "waiting" && (JSON.parse(row.checkpoint_json) as { stage?: string }).stage === "index";
      const locations = await this.repository.db.selectFrom("library_resources as lr").innerJoin("knowledge_libraries as l", "l.id", "lr.library_id")
        .select("l.name").where("lr.resource_id", "=", row.resource_id!).where("lr.deleted_at", "is", null).where("l.deleted_at", "is", null).execute();
      const active = row.embedding_profile_id === this.profile && this.config.current.enabled && locations.length > 0;
      const filename = (JSON.parse(row.sourceMetadata) as { title?: string }).title ?? row.title;
      return { id: `embed:${row.id}`, kind: "item" as const, title: row.title, target: [...new Set(locations.map(location => location.name))].join(" / "), itemType: "journalArticle", fileName: filename, stage: indexing ? "index" as const : "embed" as const,
        status: !active && ["pending", "running", "waiting"].includes(row.state) ? "paused" as const : indexing ? "publishing" as const : row.state === "running" ? "parsing" as const : row.state === "succeeded" ? "completed" as const : row.state === "cancelled" ? "cancelled" as const : row.state === "failed" ? "failed" as const : row.state === "waiting" ? "paused" as const : "queued" as const,
        processing: { sourceID: row.sourceID, generationID: row.generation_id },
        errorCode: row.error_code ?? undefined, parser: { provider: payload.provider, model: payload.model }, embedding: { dimensions: row.dimensions, active, current: row.embedding_profile_id === this.profile },
        counts: { completed: segments.filter(s => s.embedding_id).length, skipped: segments.filter(s => s.skip_reason).length,
          failed: row.state === "failed" ? Number((JSON.parse(row.checkpoint_json) as { failed?: number }).failed ?? 0) : 0, total: segments.length } };
    }));
    if (this.stopped || epoch !== this.refreshEpoch || JSON.stringify(tasks) === JSON.stringify(this.tasks)) return;
    this.tasks = tasks;
    for (const listener of this.listeners) { try { listener(); } catch { /* A detached view cannot change job state. */ } }
  }
  enqueue(resourceIDs: readonly string[]): Promise<void> { return this.accept(async () => {
    await this.beforeWork?.(); if (this.stopped) throw new Error("initializing");
    if (this.stopped || !this.config.current.enabled) throw new Error("config");
    const config = this.config.current, profile = await this.repository.profile(config, () => this.current(config));
    if (!this.current(config)) throw new Error("config-changed");
    this.profile = profile; await this.repository.reconcile(profile, config, resourceIDs); await this.refresh();
  }); }
  runAction(taskID: string, action: ImportTaskAction): Promise<void> { return this.accept(async () => {
    await this.beforeWork?.(); if (this.stopped) throw new Error("initializing");
    const id = taskID.replace(/^embed:/, ""), now = Date.now();
    if (action === "delete") {
      await this.repository.hideHistory(id);
    } else {
      this.controllers.get(id)?.abort();
      const state = action === "cancel" ? "cancelled" : action === "pause" ? "waiting" : "pending";
      const job = await this.repository.db.selectFrom("processing_jobs").select("dedup_key").where("id", "=", id).where("kind", "=", "embed").executeTakeFirstOrThrow();
      if (action === "cancel") await this.repository.db.insertInto("plugin_state").values({ key: `embedding-cancel:${job.dedup_key}`, value_json: "true", updated_at: now })
        .onConflict(c => c.column("key").doUpdateSet({ updated_at: now })).execute();
      if (action === "retry" || action === "resume") await this.repository.db.deleteFrom("plugin_state").where("key", "=", `embedding-cancel:${job.dedup_key}`).execute();
      await this.repository.db.updateTable("processing_jobs").set({ state, cancel_requested_at: action === "cancel" ? now : null, lease_owner: null, execution_token: null,
        lease_expires_at: null, finished_at: action === "cancel" ? now : null, error_code: null, updated_at: now,
        ...(["retry", "resume"].includes(action) ? { payload_json: sql<string>`json_remove(payload_json, '$.hidden')` } : {}) }).where("id", "=", id).where("kind", "=", "embed").execute();
    } await this.refresh();
  }); }
  rebuild(): Promise<void> { return this.accept(async () => {
    await this.beforeWork?.(); if (this.stopped) throw new Error("initializing");
    const config = this.config.current, profile = await this.repository.profile(config, () => this.current(config));
    if (!this.current(config)) throw new Error("config-changed");
    this.profile = profile; await this.store.sync(profile, config, this.lifetime.signal, true);
  }); }
  clear(config: RetrievalConfig, publish?: () => Promise<void>): Promise<void> { return this.accept(async () => {
    await this.beforeWork?.(); if (this.stopped) throw new Error("initializing");
    const previous = this.config.current;
    this.clearing++;
    for (const controller of this.controllers.values()) controller.abort();
    try {
      await this.store.invalidate(); await this.repository.clear(config); this.eventSequence = -1;
      if (publish) {
        await publish();
        // Keep the old snapshot fenced even if the immediate runtime reload fails.
        this.awaitingConfig = previous;
        await this.config.reload();
        if (this.config.error) throw new ModelError("config");
      }
    } finally { this.clearing--; this.wakeConfigWaiters(); }
  }); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true; hostClearTimeout(this.timer); this.unsubscribe?.(); this.lifetime.abort(); for (const controller of this.controllers.values()) controller.abort();
    this.wakeConfigWaiters();
    this.listeners.clear();
    return this.closing = this.drain();
  }
  private async drain(): Promise<void> {
    const results = await Promise.allSettled([this.store.close(), this.config.close(), this.ticking, this.starting]);
    await Promise.allSettled([...this.operations]);
    await Promise.allSettled([...this.refreshes]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
