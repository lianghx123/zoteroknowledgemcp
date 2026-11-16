import { sql, type Kysely, type Selectable } from "kysely";
import type { Database } from "../database/types";
import type { DatabaseContext } from "../database/unit-of-work";
import { canonicalParserJSON } from "../shared/parsing-identity";
import { parserProvider } from "../shared/parser-profile";
import { parserDefinition } from "../parsers/catalog";
import { projectVisualContent } from "./visual-content";
import { projectReferenceContent } from "./reference-content";
import { LeaseLost, ParseError, type ParseInput, type ParsedDocument, type ParsingPort, type ParserIdentity, type ParseCheckpoint } from "../shared/contracts/parsing";

export type ProcessingJob = Selectable<Database["processing_jobs"]>;
export type JobCheckpoint = ParseCheckpoint;
export interface StoredArtifact { id: string; key: string; relativePath: string; mediaType: string; bytes: number; hash: string; role: string; pageNumber?: number; metadata?: Record<string, unknown> }
const live = ["pending", "running", "waiting", "retry_wait", "needs_attention"];
const released = { lease_owner: null, execution_token: null, lease_expires_at: null };

export class ProcessingRepository {
  constructor(readonly db: Kysely<Database>, private readonly port: Pick<ParsingPort, "uuid" | "hash">) {}

  async sourceFor(libraryID: number, attachmentKey: string) {
    return this.db.selectFrom("zotero_item_links as z").innerJoin("zotero_libraries as l", "l.id", "z.zotero_library_id")
      .innerJoin("resource_sources as s", "s.id", "z.source_id").innerJoin("knowledge_resources as r", "r.id", "s.resource_id")
      .select(["s.id", "s.resource_id", "s.source_version", "s.source_fingerprint", "s.content_version", "s.active_generation_id", "r.title"])
      .where("l.local_library_id", "=", libraryID).where("l.availability", "=", "available").where("z.item_key", "=", attachmentKey)
      .where("z.state", "=", "current").where("s.deleted_at", "is", null).where("r.status", "=", "active").executeTakeFirst();
  }

  async enqueue(input: ParseInput, fingerprint: string, maxFailures: number, force = false, reuseHistory = false): Promise<string> {
    const parserJSON = canonicalParserJSON(input.parser), parserHash = await this.port.hash(parserJSON);
    const dedup = await this.port.hash(JSON.stringify([input.sourceID, fingerprint, parserHash]));
    return this.db.transaction().execute(async tx => {
      const now = Date.now();
      const source = await tx.selectFrom("resource_sources").selectAll().where("id", "=", input.sourceID).where("deleted_at", "is", null).executeTakeFirst();
      if (!source) throw new ParseError("stale");
      // Fence legacy terminal records as well, independently of the active
      // profile/dedup key. A changed profile cannot resolve an accepted upload.
      const uncertain = await tx.selectFrom("processing_jobs as j").innerJoin("parse_runs as p", "p.job_id", "j.id")
        .selectAll("j").where("j.source_id", "=", input.sourceID).where("j.input_fingerprint", "=", fingerprint)
        .where("p.submission_state", "in", ["submitting", "ambiguous"]).orderBy("j.created_at", "desc").executeTakeFirst();
      if (uncertain) {
        // Background synchronization respects an intentional local cancellation.
        // Explicit admission can expose recovery again, but cannot upload.
        if (uncertain.state === "cancelled" && reuseHistory) return uncertain.id;
        await this.fenceUnsubmittedSiblings(tx, uncertain);
        if (uncertain.state !== "running") await tx.updateTable("processing_jobs").set({
          ...(!await this.liveConflict(tx, uncertain) ? { state: "needs_attention", ...released, finished_at: null } : {}),
          error_code: "ambiguous", updated_at: now,
          ...(!reuseHistory ? { cancel_requested_at: null, payload_json: JSON.stringify({ ...JSON.parse(uncertain.payload_json), hidden: false }) } : {}) }).where("id", "=", uncertain.id).execute();
        return uncertain.id;
      }
      const existing = await tx.selectFrom("processing_jobs").selectAll().where("kind", "=", "parse").where("dedup_key", "=", dedup)
        .orderBy("created_at", "desc").execute();
      const current = (job: ProcessingJob) => source.source_fingerprint === fingerprint
        && job.expected_source_version === source.source_version && job.expected_content_version === source.content_version;
      const reuse = async (job: ProcessingJob): Promise<string> => {
        const payload = JSON.parse(job.payload_json) as ParseInput;
        // Adopt visible one-time history when a collection begins tracking it.
        // Never unhide cleared records or move a job out of another batch.
        if (input.batch && !payload.batch && !payload.hidden) {
          await tx.updateTable("processing_jobs").set({ payload_json: JSON.stringify({ ...payload, batch: input.batch }) }).where("id", "=", job.id).execute();
        }
        return job.id;
      };
      const running = existing.find(job => live.includes(job.state));
      if (running && current(running)) return reuse(running);
      if (running) {
        // A matching byte/parser hash is insufficient after the source or base
        // generation changes. Fence the old lease before replacing its live key.
        await tx.updateTable("processing_jobs").set({ state: "cancelled", error_code: "stale", ...released,
          finished_at: now, updated_at: now }).where("id", "=", running.id).execute();
      }
      if (reuseHistory && existing.length && (current(existing[0]) || (source.source_fingerprint === fingerprint
        && existing[0].generation_id !== null && existing[0].generation_id === source.active_generation_id))
        && existing[0].error_code !== "stale"
        && ["failed", "cancelled", "partially_succeeded"].includes(existing[0].state)) return reuse(existing[0]);
      if (!force && source.source_fingerprint === fingerprint && source.active_generation_id) {
        // Synchronization follows attachment changes, not application upgrades
        // or settings changes. Keep published work across parser identities;
        // explicit parsing still admits the selected parser/normalizer.
        const ready = existing.find(job => job.state === "succeeded" && job.generation_id === source.active_generation_id)
          ?? (reuseHistory ? await tx.selectFrom("processing_jobs").selectAll().where("kind", "=", "parse")
            .where("source_id", "=", input.sourceID).where("input_fingerprint", "=", fingerprint)
            .where("expected_source_version", "=", source.source_version).where("generation_id", "=", source.active_generation_id)
            .where("state", "in", ["succeeded", "partially_succeeded"]).executeTakeFirst() : undefined);
        if (ready) return reuse(ready);
      }
      if (reuseHistory && source.source_fingerprint === fingerprint) {
        const history = await tx.selectFrom("processing_jobs").selectAll().where("kind", "=", "parse")
          .where("source_id", "=", input.sourceID).where("input_fingerprint", "=", fingerprint)
          .where("expected_source_version", "=", source.source_version).where("expected_content_version", "=", source.content_version)
          .where("state", "in", [...live, "failed", "cancelled", "partially_succeeded"])
          .where(eb => eb.or([eb("error_code", "is", null), eb("error_code", "!=", "stale")]))
          .orderBy("created_at", "desc").executeTakeFirst();
        // Settings changes cannot silently restart failed/cancelled work or
        // bypass accepted remote tracking owned by another parser identity.
        if (history) return reuse(history);
      }
      const version = source.source_version + (source.source_fingerprint && source.source_fingerprint !== fingerprint ? 1 : 0);
      await tx.updateTable("resource_sources").set({ source_version: version, source_fingerprint: fingerprint, fingerprint_algorithm: "sha256",
        availability: "available", last_checked_at: now, error_code: null, updated_at: now }).where("id", "=", source.id).execute();
      await tx.insertInto("provider_profiles").values({ id: parserHash, name: input.parser.profile, kind: "parse", adapter_key: parserDefinition(parserProvider(input.parser)).adapterKey,
        adapter_version: "1", endpoint_url: input.parser.api, credential_ref: input.parser.profile, config_json: parserJSON,
        configuration_hash: parserHash, enabled: 1, created_at: now }).onConflict(conflict => conflict.column("id").doNothing()).execute();
      const id = this.port.uuid();
      const payload = { ...input, replacesJobID: input.replacesJobID ?? existing[0]?.id };
      await tx.insertInto("processing_jobs").values({ id, kind: "parse", dedup_key: dedup, resource_id: input.resourceID, source_id: source.id,
        generation_id: null, binding_id: null, embedding_profile_id: null, expected_source_version: version, expected_content_version: source.content_version,
        input_fingerprint: fingerprint, payload_json: JSON.stringify(payload), next_run_at: now, max_failures: maxFailures,
        ...released, heartbeat_at: null, cancel_requested_at: null, error_code: null, error_message: null,
        created_at: now, updated_at: now, started_at: null, finished_at: null }).execute();
      await tx.insertInto("parse_runs").values({ id: this.port.uuid(), job_id: id, resource_id: input.resourceID, source_id: source.id, mode: "service",
        provider_profile_id: parserHash, parser_name: input.parser.model, parser_version: null, normalizer_version: input.parser.normalizer, result_schema_version: null,
        source_version: version, source_fingerprint: fingerprint, base_content_version: source.content_version, base_generation_id: source.active_generation_id,
        submission_key: this.port.uuid(), submission_state: "not_submitted", external_job_id: null, stage: "validating", progress_current: null,
        progress_total: null, result_fingerprint: null, created_at: now, updated_at: now }).execute();
      return id;
    });
  }

  async claim(owner: string): Promise<ProcessingJob | undefined> {
    return this.db.transaction().execute(async tx => {
      const now = Date.now();
      const candidate = await tx.selectFrom("processing_jobs").select("id").where("kind", "=", "parse")
        .where("state", "in", ["pending", "waiting", "retry_wait"]).where("next_run_at", "<=", now).where("cancel_requested_at", "is", null)
        .orderBy("priority", "desc").orderBy("next_run_at").orderBy("created_at").limit(1).executeTakeFirst();
      if (!candidate) return;
      return tx.updateTable("processing_jobs").set({ state: "running", lease_owner: owner, execution_token: this.port.uuid(), lease_expires_at: now + 90000,
        heartbeat_at: now, started_at: sql`coalesce(started_at, ${now})`, attempt_count: sql`attempt_count + 1`, updated_at: now })
        .where("id", "=", candidate.id).where("state", "in", ["pending", "waiting", "retry_wait"]).returningAll().executeTakeFirst();
    });
  }

  private fenced(tx: DatabaseContext, job: ProcessingJob) {
    return tx.updateTable("processing_jobs").where("id", "=", job.id).where("state", "=", "running")
      .where("execution_token", "=", job.execution_token).where("lease_expires_at", ">", Date.now()).where("cancel_requested_at", "is", null);
  }
  async guard(tx: DatabaseContext, job: ProcessingJob): Promise<void> {
    const updated = await this.fenced(tx, job).set({ updated_at: Date.now() }).returning("id").executeTakeFirst();
    if (!updated) throw new LeaseLost();
    const source = await tx.selectFrom("resource_sources as s").innerJoin("knowledge_resources as r", "r.id", "s.resource_id")
      .select(["s.source_version", "s.source_fingerprint", "s.content_version", "s.deleted_at", "r.status"])
      .where("s.id", "=", job.source_id).executeTakeFirst();
    if (!source || source.deleted_at || source.status !== "active" || source.source_version !== job.expected_source_version
      || source.source_fingerprint !== job.input_fingerprint || source.content_version !== job.expected_content_version) throw new ParseError("stale");
    const membership = await tx.selectFrom("library_resources as m").innerJoin("knowledge_libraries as k", "k.id", "m.library_id")
      .select("m.id").where("m.resource_id", "=", job.resource_id).where("m.deleted_at", "is", null).where("k.status", "=", "active").executeTakeFirst();
    if (!membership) throw new ParseError("stale");
    if (job.expected_content_version! > 0) {
      const generation = await tx.selectFrom("content_generations").select("origin").where("source_id", "=", job.source_id)
        .where("content_version", "=", job.expected_content_version).where("state", "in", ["ready", "partial"]).executeTakeFirst();
      if (generation && ["manual", "edit"].includes(generation.origin)) throw new ParseError("edited");
    }
  }
  async heartbeat(job: ProcessingJob): Promise<void> {
    const result = await this.fenced(this.db, job).set({ heartbeat_at: Date.now(), lease_expires_at: Date.now() + 90000 }).returning("id").executeTakeFirst();
    if (!result) throw new LeaseLost();
  }
  run(job: ProcessingJob) { return this.db.selectFrom("parse_runs").selectAll().where("job_id", "=", job.id).executeTakeFirstOrThrow(); }
  async configureUnsubmitted(job: ProcessingJob, parser: ParserIdentity): Promise<ProcessingJob> {
    const input = JSON.parse(job.payload_json) as ParseInput;
    if (canonicalParserJSON(input.parser) === canonicalParserJSON(parser)) return job;
    input.parser = parser;
    const parserJSON = canonicalParserJSON(parser), hash = await this.port.hash(parserJSON);
    const dedup = await this.port.hash(JSON.stringify([input.sourceID, job.input_fingerprint, hash]));
    return this.db.transaction().execute(async tx => {
      await this.guard(tx, job);
      const run = await tx.selectFrom("parse_runs").select("submission_state").where("job_id", "=", job.id).executeTakeFirstOrThrow();
      if (run.submission_state !== "not_submitted") return job;
      const duplicate = await tx.selectFrom("processing_jobs").select("id").where("kind", "=", "parse").where("dedup_key", "=", dedup)
        .where("id", "!=", job.id).where("state", "in", live).executeTakeFirst();
      if (duplicate) throw new ParseError("stale");
      await tx.insertInto("provider_profiles").values({ id: hash, name: parser.profile, kind: "parse", adapter_key: parserDefinition(parserProvider(parser)).adapterKey, adapter_version: "1",
        endpoint_url: parser.api, credential_ref: parser.profile, config_json: parserJSON, configuration_hash: hash, enabled: 1, created_at: Date.now() })
        .onConflict(conflict => conflict.column("id").doNothing()).execute();
      await tx.updateTable("parse_runs").set({ provider_profile_id: hash, parser_name: parser.model, normalizer_version: parser.normalizer, updated_at: Date.now() })
        .where("job_id", "=", job.id).execute();
      return tx.updateTable("processing_jobs").set({ payload_json: JSON.stringify(input), dedup_key: dedup, updated_at: Date.now() }).where("id", "=", job.id).returningAll().executeTakeFirstOrThrow();
    });
  }
  async reserveSubmission(job: ProcessingJob, limit: number): Promise<boolean> {
    return this.db.transaction().execute(async tx => {
      await this.guard(tx, job);
      const uncertain = await tx.selectFrom("parse_runs as p").innerJoin("processing_jobs as j", "j.id", "p.job_id")
        .select("j.id").where("j.source_id", "=", job.source_id).where("j.input_fingerprint", "=", job.input_fingerprint)
        .where("j.id", "!=", job.id).where("p.submission_state", "in", ["submitting", "ambiguous"]).executeTakeFirst();
      if (uncertain) throw new ParseError("stale");
      const count = await tx.selectFrom("parse_runs as p").innerJoin("processing_jobs as j", "j.id", "p.job_id")
        .select(eb => eb.fn.countAll<number>().as("count")).where("p.submission_state", "in", ["submitting", "ambiguous", "confirmed"])
        .where("j.state", "in", live).where("p.stage", "in", ["submitting", "polling"]).executeTakeFirstOrThrow();
      if (Number(count.count) >= limit) return false;
      await tx.updateTable("parse_runs").set({ submission_state: "submitting", stage: "submitting", updated_at: Date.now() }).where("job_id", "=", job.id).execute();
      return true;
    });
  }
  async attachRemote(id: string, remoteID: string, timeoutMs = 3600000): Promise<void> {
    if (!remoteID.trim() || remoteID.length > 512 || /[\r\n]/.test(remoteID)) throw new ParseError("format");
    await this.db.transaction().execute(async tx => {
      const job = await tx.selectFrom("processing_jobs").selectAll().where("id", "=", id).where("kind", "=", "parse")
        .where("state", "in", ["needs_attention", "failed", "cancelled"]).executeTakeFirst();
      if (!job) throw new ParseError("stale");
      const run = await tx.selectFrom("parse_runs").select("submission_state").where("job_id", "=", id).executeTakeFirstOrThrow();
      if (!["submitting", "ambiguous"].includes(run.submission_state)) throw new ParseError("stale");
      await this.fenceUnsubmittedSiblings(tx, job);
      if (await this.liveConflict(tx, job)) throw new ParseError("stale");
      await tx.updateTable("parse_runs").set({ submission_state: "confirmed", external_job_id: remoteID.trim(), stage: "polling", updated_at: Date.now() })
        .where("job_id", "=", id).execute();
      await tx.updateTable("processing_jobs").set({ state: "pending", error_code: null, cancel_requested_at: null, finished_at: null, next_run_at: Date.now(), updated_at: Date.now(),
        checkpoint_json: JSON.stringify({ ...JSON.parse(job.checkpoint_json), phase: "poll", extractionPhase: "remote-queue", phaseStartedAt: Date.now(), progressUpdatedAt: Date.now(), deadline: Date.now() + timeoutMs }) }).where("id", "=", id).execute();
    });
  }
  async checkpoint(job: ProcessingJob, checkpoint: JobCheckpoint, run?: Partial<Selectable<Database["parse_runs"]>>): Promise<void> {
    await this.db.transaction().execute(async tx => {
      await this.guard(tx, job);
      const current = await tx.selectFrom("processing_jobs").select("checkpoint_json").where("id", "=", job.id).executeTakeFirstOrThrow();
      await tx.updateTable("processing_jobs").set({ checkpoint_json: JSON.stringify({ ...JSON.parse(current.checkpoint_json), ...checkpoint }) }).where("id", "=", job.id).execute();
      if (run) await tx.updateTable("parse_runs").set({ ...run, updated_at: Date.now() }).where("job_id", "=", job.id).execute();
    });
  }
  async finish(job: ProcessingJob, state: string, code: string | null = null, delay = 0, checkpoint?: JobCheckpoint): Promise<void> {
    const terminal = ["succeeded", "partially_succeeded", "failed", "cancelled"].includes(state);
    await this.db.transaction().execute(async tx => {
      const result = await this.fenced(tx, job).set({ state, ...released, error_code: code, error_message: null,
        finished_at: terminal ? Date.now() : null, next_run_at: Date.now() + delay, updated_at: Date.now(),
        ...(checkpoint ? { checkpoint_json: JSON.stringify(checkpoint) } : {}),
        ...(code && state !== "needs_attention" ? { failure_count: sql`failure_count + 1` } : {}) }).returning("id").executeTakeFirst();
      if (!result) throw new LeaseLost();
    });
  }
  async recover(): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const uncertain = await tx.selectFrom("processing_jobs").selectAll()
        .where("kind", "=", "parse").where("state", "not in", ["running", "succeeded", "partially_succeeded", "cancelled"])
        .where("id", "in", tx.selectFrom("parse_runs").select("job_id").where("submission_state", "in", ["submitting", "ambiguous"]))
        .orderBy("created_at", "desc").orderBy("id").execute();
      for (const job of uncertain) {
        await this.fenceUnsubmittedSiblings(tx, job);
        // Already accepted successors keep their tracking/provenance. The old
        // unresolved record remains visible without violating the live-key index.
        if (await this.liveConflict(tx, job)) continue;
        await tx.updateTable("processing_jobs").set({ state: "needs_attention", error_code: "ambiguous", ...released,
          finished_at: null, updated_at: Date.now() }).where("id", "=", job.id).execute();
      }
      const expired = await tx.selectFrom("processing_jobs").selectAll().where("kind", "=", "parse").where("state", "=", "running")
        .where("lease_expires_at", "<=", Date.now()).execute();
      for (const job of expired) {
        const failed = job.failure_count + 1 >= job.max_failures;
        const run = await tx.selectFrom("parse_runs").select("submission_state").where("job_id", "=", job.id).executeTakeFirstOrThrow();
        const ambiguous = ["submitting", "ambiguous"].includes(run.submission_state);
        const state = job.cancel_requested_at ? "cancelled" : ambiguous ? "needs_attention" : failed ? "failed" : "retry_wait";
        await tx.updateTable("processing_jobs").set({ state, ...released, failure_count: sql`failure_count + 1`,
          error_code: ambiguous ? "ambiguous" : "interrupted", next_run_at: Date.now(), updated_at: Date.now(),
          finished_at: ["cancelled", "failed"].includes(state) ? Date.now() : null }).where("id", "=", job.id).execute();
      }
    });
  }
  private liveConflict(tx: DatabaseContext, job: ProcessingJob) {
    return tx.selectFrom("processing_jobs").select("id").where("kind", "=", "parse").where("dedup_key", "=", job.dedup_key)
      .where("id", "!=", job.id).where("state", "in", live).executeTakeFirst();
  }
  private async fenceUnsubmittedSiblings(tx: DatabaseContext, job: ProcessingJob): Promise<void> {
    await tx.updateTable("processing_jobs").set({ state: "cancelled", error_code: "stale", ...released,
      finished_at: Date.now(), updated_at: Date.now() }).where("kind", "=", "parse").where("id", "!=", job.id)
      .where("source_id", "=", job.source_id).where("input_fingerprint", "=", job.input_fingerprint).where("state", "in", live)
      .where("id", "in", tx.selectFrom("parse_runs").select("job_id").where("submission_state", "=", "not_submitted")
        .where("external_job_id", "is", null)).execute();
  }
  async releaseOwner(owner: string): Promise<void> {
    await this.db.updateTable("processing_jobs").set({ state: "waiting", ...released, next_run_at: Date.now(), updated_at: Date.now() })
      .where("lease_owner", "=", owner).where("state", "=", "running").execute();
    await this.recover();
  }
  async cancel(id: string): Promise<void> {
    await this.db.updateTable("processing_jobs").set({ state: "cancelled", ...released, cancel_requested_at: Date.now(), finished_at: Date.now(), updated_at: Date.now() })
      .where("id", "=", id).where("kind", "=", "parse")
      .where(eb => eb.or([eb("state", "in", live), eb.and([eb("state", "=", "failed"), eb("id", "in",
        eb.selectFrom("parse_runs").select("job_id").where("submission_state", "in", ["submitting", "ambiguous"]))])])).execute();
  }
  async hide(id: string): Promise<void> {
    // Keep parse provenance and published content intact when clearing history.
    await this.db.updateTable("processing_jobs").set({ payload_json: sql`json_set(payload_json, '$.hidden', json('true'))`, updated_at: Date.now() })
      .where("id", "=", id).where("kind", "=", "parse").where("state", "in", ["succeeded", "partially_succeeded", "failed", "cancelled"]).execute();
  }
  async hideFinishedBatch(id: string): Promise<void> {
    await this.db.transaction().execute(async tx => {
      const jobs = await tx.selectFrom("processing_jobs").select(["id", "source_id", "generation_id"])
        .where("kind", "=", "parse").where("state", "in", ["succeeded", "partially_succeeded", "failed", "cancelled"])
        .where(eb => eb(eb.fn<string>("json_extract", ["payload_json", eb.val("$.batch.id")]), "=", id.replace(/^batch-/, ""))).execute();
      const hidden = { payload_json: sql<string>`json_set(payload_json, '$.hidden', json('true'))`, updated_at: Date.now() };
      for (const job of jobs) {
        if (job.source_id && job.generation_id) {
          const active = await tx.selectFrom("processing_jobs as j").innerJoin("resource_sources as s", "s.id", "j.source_id")
            .select("j.id").where("j.kind", "=", "embed").where("j.source_id", "=", job.source_id).where("j.generation_id", "=", job.generation_id)
            .where("j.state", "in", live).whereRef("j.generation_id", "=", "s.active_generation_id")
            .where(sql<boolean>`coalesce(json_extract(j.payload_json, '$.hidden'), 0) <> 1`).executeTakeFirst();
          // Preserve visible current work; archived or superseded jobs cannot reexpose history.
          if (active) continue;
          await tx.updateTable("processing_jobs").set(hidden).where("kind", "=", "embed")
            .where("source_id", "=", job.source_id).where("generation_id", "=", job.generation_id).execute();
        }
        await tx.updateTable("processing_jobs").set(hidden).where("id", "=", job.id).execute();
      }
    });
  }
  async resume(id: string, timeoutMs: number): Promise<void> {
    const job = await this.db.selectFrom("processing_jobs").selectAll().where("id", "=", id).where("kind", "=", "parse").executeTakeFirstOrThrow();
    const run = await this.run(job);
    if (["submitting", "ambiguous"].includes(run.submission_state)) throw new ParseError("ambiguous");
    if (!["needs_attention", "retry_wait"].includes(job.state)) throw new ParseError("stale");
    await this.db.updateTable("processing_jobs").set({ state: "pending", error_code: null, next_run_at: Date.now(), updated_at: Date.now(),
      checkpoint_json: JSON.stringify({ ...JSON.parse(job.checkpoint_json), deadline: Date.now() + timeoutMs }) })
      .where("id", "=", id).where("state", "=", job.state).execute();
  }
  /** A failed download/publication retries the accepted remote result, not OCR. */
  async resumeResult(id: string, fingerprint: string, timeoutMs: number): Promise<boolean> {
    return this.db.transaction().execute(async tx => {
      const job = await tx.selectFrom("processing_jobs").selectAll().where("id", "=", id).where("kind", "=", "parse")
        .where("state", "=", "failed").where("cancel_requested_at", "is", null).executeTakeFirst();
      if (!job || fingerprint !== job.input_fingerprint || await this.liveConflict(tx, job)) return false;
      const run = await tx.selectFrom("parse_runs").selectAll().where("job_id", "=", id).executeTakeFirstOrThrow();
      if (run.submission_state !== "confirmed" || !run.external_job_id || !["downloading", "importing"].includes(run.stage)) return false;
      const source = await tx.selectFrom("resource_sources").selectAll().where("id", "=", job.source_id).where("deleted_at", "is", null).executeTakeFirst();
      if (!source || source.source_fingerprint !== fingerprint || source.source_version !== job.expected_source_version
        || source.content_version !== job.expected_content_version) return false;
      await tx.updateTable("processing_jobs").set({ state: "pending", error_code: null, error_message: null, finished_at: null, failure_count: 0,
        next_run_at: Date.now(), updated_at: Date.now(), checkpoint_json: JSON.stringify({ ...JSON.parse(job.checkpoint_json), deadline: Date.now() + timeoutMs }) })
        .where("id", "=", id).where("state", "=", "failed").execute();
      return true;
    });
  }
  async list() { return this.db.selectFrom("processing_jobs").selectAll().where("kind", "=", "parse").orderBy("created_at").execute(); }
  async remoteCount(): Promise<number> {
    const result = await this.db.selectFrom("parse_runs as p").innerJoin("processing_jobs as j", "j.id", "p.job_id")
      .select(eb => eb.fn.countAll<number>().as("count")).where("p.submission_state", "in", ["submitting", "ambiguous", "confirmed"])
      .where("j.state", "in", live).where("p.stage", "in", ["submitting", "polling"]).executeTakeFirstOrThrow();
    return Number(result.count);
  }

  async publish(job: ProcessingJob, document: ParsedDocument, artifacts: StoredArtifact[]): Promise<string> {
    if (typeof document.normalizerVersion !== "string" || !document.normalizerVersion.trim()) throw new ParseError("format");
    const fingerprint = await this.port.hash(document.markdown), generationID = this.port.uuid();
    const blockHashes = await Promise.all(document.blocks.map(block => this.port.hash(block.markdown)));
    await this.db.transaction().execute(async tx => {
      await this.guard(tx, job); const now = Date.now();
      const run = await tx.selectFrom("parse_runs").selectAll().where("job_id", "=", job.id).executeTakeFirstOrThrow();
      await tx.insertInto("content_generations").values({ id: generationID, source_id: job.source_id!, resource_id: job.resource_id!, parse_run_id: run.id,
        base_generation_id: run.base_generation_id, base_content_version: job.expected_content_version!, content_version: job.expected_content_version! + 1,
        source_version: job.expected_source_version!, source_fingerprint: job.input_fingerprint!, origin: "parse", state: "staging", content_fingerprint: fingerprint,
        normalizer_version: document.normalizerVersion, page_manifest_json: JSON.stringify(document.pages.map(page => ({ number: page.number, width: page.width, height: page.height,
          modelSettings: (page.raw.prunedResult as Record<string, unknown> | undefined)?.model_settings,
          inputImage: page.raw.inputImage }))),
        warnings_json: JSON.stringify(document.warnings), created_by_type: "system", created_by: null, created_at: now, published_at: null }).execute();
      const resource = await tx.selectFrom("knowledge_resources").selectAll().where("id", "=", job.resource_id).executeTakeFirstOrThrow();
      const detected = document.detectedMetadata;
      const reviewStatus = document.partial ? "needs_review" : "auto";
      const rootID = this.port.uuid();
      const firstPage = Math.min(...document.blocks.map(block => block.page));
      const lastPage = Math.max(...document.blocks.map(block => block.pageEnd ?? block.page));
      await tx.insertInto("structure_nodes").values({ id: rootID, generation_id: generationID, parent_id: null, node_type: "root",
        label: detected?.title || resource.title, path: "/", depth: 0,
        sort_order: 0, canonical_order_start: 0, canonical_order_end: document.blocks.length - 1, page_start: firstPage,
        page_end: lastPage, source_type: "ocr", source_ref_id: run.id, confidence: null, review_status: reviewStatus,
        metadata_json: JSON.stringify({ detectedMetadata: detected, errors: document.errors ?? [] }), created_at: now }).execute();
      type Section = { id: string; parent?: Section; path: string; depth: number; level: number; start: number; end: number; pageStart: number; pageEnd: number };
      const root: Section = { id: rootID, path: "/", depth: 0, level: 1, start: 0, end: document.blocks.length - 1, pageStart: firstPage, pageEnd: lastPage };
      let current = root, lastLevelTwo = root;
      const headingStack: Array<{ level: number; section: Section }> = [];
      const headingSections = new Map<number, Section>();
      const sections: Section[] = [], childOrders = new Map<string, number>(), localOrders = new Map<string, number>();
      for (const [index, block] of document.blocks.entries()) {
        const blockReview = block.metadata?.heading_level_inferred || block.metadata?.missing_visual_body
          || block.qualityFlags?.includes("heading_hierarchy_uncertain") ? "needs_review" : reviewStatus;
        if (block.type === "heading" && block.label === "paragraph_title") {
          const level = block.headingLevel ?? 3;
          if (document.sectionHierarchy === "heading-levels") while (headingStack.length && headingStack[headingStack.length - 1].level >= level) headingStack.pop();
          let parent = document.sectionHierarchy === "heading-levels" ? headingStack[headingStack.length - 1]?.section ?? root : level <= 2 ? root : lastLevelTwo;
          if (block.headingParentOrder !== undefined) {
            if (block.headingParentOrder === null) parent = root;
            else {
              const inferredParent = headingSections.get(block.headingParentOrder);
              if (!Number.isSafeInteger(block.headingParentOrder) || block.headingParentOrder >= index || !inferredParent) throw new ParseError("format");
              parent = inferredParent;
            }
            // Restore the approved ancestry even if a provisional unnumbered
            // heading previously changed the level-based fallback stack.
            headingStack.length = 0;
            const ancestry: Section[] = [];
            for (let ancestor: Section | undefined = parent; ancestor && ancestor !== root; ancestor = ancestor.parent) ancestry.push(ancestor);
            for (const ancestor of ancestry.reverse()) headingStack.push({ level: ancestor.level, section: ancestor });
          }
          const order = childOrders.get(parent.id) ?? 0; childOrders.set(parent.id, order + 1);
          current = { id: this.port.uuid(), parent, path: `${parent.path.replace(/\/$/, "")}/${order + 1}`, depth: parent.depth + 1, level,
            start: index, end: index, pageStart: block.page, pageEnd: block.pageEnd ?? block.page };
          sections.push(current);
          headingSections.set(index, current);
          if (document.sectionHierarchy === "heading-levels") headingStack.push({ level, section: current });
          await tx.insertInto("structure_nodes").values({ id: current.id, generation_id: generationID, parent_id: parent.id, node_type: "section", label: block.text,
            path: current.path, depth: current.depth, sort_order: order, canonical_order_start: index, canonical_order_end: index,
            page_start: current.pageStart, page_end: current.pageEnd, source_type: "ocr", source_ref_id: block.sourceIDs?.[0] ?? block.sourceID,
            confidence: null, review_status: blockReview, metadata_json: JSON.stringify({ heading_hierarchy: block.metadata?.heading_hierarchy }), created_at: now }).execute();
          if ((block.headingLevel ?? 3) <= 2) lastLevelTwo = current;
        }
        for (let node: Section | undefined = current; node && node !== root; node = node.parent) {
          node.end = index; node.pageStart = Math.min(node.pageStart, block.page); node.pageEnd = Math.max(node.pageEnd, block.pageEnd ?? block.page);
        }
        const local = localOrders.get(current.id) ?? 0; localOrders.set(current.id, local + 1);
        const sourceIDs = block.sourceIDs ?? [block.sourceID];
        const blockID = this.port.uuid();
        await tx.insertInto("content_blocks").values({ id: blockID, generation_id: generationID, structure_node_id: current.id, parent_block_id: null,
          supersedes_block_id: null, block_type: block.type, content_role: block.type === "footnote" ? "note" : "body",
          canonical_order: index, local_order: local, content_markdown: block.markdown,
          content_normalized: block.text, content_hash: blockHashes[index], source_type: "ocr", source_block_ids_json: JSON.stringify(sourceIDs),
          page_start: block.page, page_end: block.pageEnd ?? block.page,
          locations_json: JSON.stringify(block.locations ?? (block.bbox ? [{ page: block.page, bbox: block.bbox }] : [])),
          confidence: null, review_status: blockReview, quality_flags_json: JSON.stringify(block.qualityFlags ?? []),
          metadata_json: JSON.stringify({ ...block.metadata, label: block.label, ocr_label: block.label, source_block_ids: sourceIDs }), created_at: now }).execute();
      }
      await projectVisualContent(tx, generationID, () => this.port.uuid(), document.pages);
      await projectReferenceContent(tx, generationID, () => this.port.uuid());
      for (const section of sections) await tx.updateTable("structure_nodes").set({ canonical_order_end: section.end,
        page_start: section.pageStart, page_end: section.pageEnd }).where("id", "=", section.id).execute();
      for (const artifact of artifacts) {
        await tx.insertInto("stored_files").values({ id: artifact.id, relative_path: artifact.relativePath, original_name: null, media_type: artifact.mediaType,
          byte_length: artifact.bytes, sha256: artifact.hash, state: "available", created_at: now, verified_at: now }).execute();
        await tx.insertInto("generation_files").values({ generation_id: generationID, asset_key: artifact.key, stored_file_id: artifact.id, role: artifact.role }).execute();
        await tx.insertInto("parse_artifacts").values({ id: this.port.uuid(), parse_run_id: run.id, artifact_key: artifact.key, artifact_type: artifact.role,
          stored_file_id: artifact.id, page_number: artifact.pageNumber ?? null, metadata_json: JSON.stringify(artifact.metadata ?? {}), created_at: now }).execute();
      }
      await tx.updateTable("content_generations").set({ state: document.partial ? "partial" : "ready", published_at: now }).where("id", "=", generationID).execute();
      // Switch first: the trigger forbids superseding an active generation.
      await tx.updateTable("resource_sources").set({ active_generation_id: generationID, content_version: job.expected_content_version! + 1, updated_at: now })
        .where("id", "=", job.source_id).execute();
      if (run.base_generation_id) {
        await tx.updateTable("content_generations").set({ state: "superseded" }).where("id", "=", run.base_generation_id).execute();
        await tx.updateTable("resource_annotations").set({ anchor_state: "historical", updated_at: now })
          .where("generation_id", "=", run.base_generation_id).where("anchor_state", "=", "current").where("deleted_at", "is", null).execute();
      }
      await tx.updateTable("knowledge_resources").set({ canonical_source_id: sql`coalesce(canonical_source_id, ${job.source_id})`,
        version: sql`version + 1`, updated_at: now,
        abstract: resource.abstract || detected?.abstract || null, language: resource.language || detected?.language || null,
        metadata_json: JSON.stringify({ ...JSON.parse(resource.metadata_json), ...(detected ? { detected_title: detected.title } : {}) })
      }).where("id", "=", job.resource_id).execute();
      await tx.insertInto("resource_revisions").values({ id: this.port.uuid(), resource_id: job.resource_id!, operation_id: job.id,
        base_version: resource.version, result_version: resource.version + 1, change_type: "parse_publish", target_type: "resource_source", target_id: job.source_id,
        before_json: JSON.stringify({ generationID: run.base_generation_id }), after_json: JSON.stringify({ generationID, partial: document.partial }),
        created_by_type: "system", created_by: null, agent_run_id: null, created_at: now }).execute();
      await tx.insertInto("change_outbox").values({ event_id: this.port.uuid(), aggregate_type: "resource_source", aggregate_id: job.source_id!,
        aggregate_version: job.expected_content_version! + 1, event_type: "content_published", payload_json: JSON.stringify({ generationID, partial: document.partial }), created_at: now }).execute();
      await tx.updateTable("parse_runs").set({ stage: "completed", result_fingerprint: fingerprint, progress_current: document.pages.length,
        progress_total: document.total, warnings_json: JSON.stringify(document.warnings), updated_at: now }).where("id", "=", run.id).execute();
      // The same fenced transaction publishes both content and terminal job state.
      const result = await this.fenced(tx, job).set({ state: document.partial ? "partially_succeeded" : "succeeded", generation_id: generationID,
        ...released, finished_at: now, error_code: null, updated_at: now }).returning("id").executeTakeFirst();
      if (!result) throw new LeaseLost();
    });
    return generationID;
  }
}
