import { knowledgeFolderPath, displayStoredFolderPath } from "../shared/folder-path";
import type { Kysely } from "kysely";
import type { Database } from "../database/types";
import type { KnowledgeLibraryController, KnowledgeTarget } from "../shared/contracts/knowledge-library";
import { ParseError, type ParseCheckpoint, type ParseInput, type ParsingPort } from "../shared/contracts/parsing";
import type { ImportTask, ImportTaskAction, ImportTaskSource, ImportTaskStatus } from "../shared/contracts/import-tasks";
import { t } from "../shared/localization";
import { KnowledgeUserError } from "../shared/knowledge-errors";
import { ProcessingRepository, type ProcessingJob } from "../repositories/processing";
import { ZoteroParsingPort } from "../integrations/zotero/parsing-port";
import { ParsingConfigFile } from "./parsing-config";
import { ParseWorker } from "../worker/parse-worker/runner";
import { ParserRegistry } from "../parsers/registry";
import { parserIdentity, parserProvider } from "../shared/parser-profile";
import { parsingErrorMessage } from "../shared/parsing-errors";
import { recoverParseFiles } from "../storage/parse-files";

export class ParsingService implements ImportTaskSource {
  readonly config: ParsingConfigFile;
  readonly repository: ProcessingRepository;
  readonly worker: ParseWorker;
  private tasks: readonly ImportTask[] = [];
  private readonly listeners = new Set<() => void>();
  private operations: Promise<unknown> = Promise.resolve();
  private closing = false;
  private refreshing: Promise<void> = Promise.resolve();
  private primePublished = false;
  private configStarted = false;
  private initialized = false;
  private readonly published = new Set<string>();
  constructor(db: Kysely<Database>, private readonly knowledge: KnowledgeLibraryController,
    private readonly port: ParsingPort = new ZoteroParsingPort(), parsers = new ParserRegistry()) {
    this.repository = new ProcessingRepository(db, port);
    this.config = new ParsingConfigFile(() => { this.worker?.wake(); if (this.initialized) void this.refresh().catch(() => {}); });
    this.worker = new ParseWorker(this.repository, this.config, port, parsers, () => this.refresh());
  }
  beforeWork?: () => Promise<void>;
  private starting: Promise<void> = Promise.resolve();
  start(metadataReconciled = false): Promise<void> {
    return this.starting = this.restore(metadataReconciled);
  }
  private async restore(metadataReconciled: boolean): Promise<void> {
    if (this.closing) return;
    this.primePublished = metadataReconciled;
    if (!this.configStarted) { await this.config.start(); this.configStarted = true; }
    if (this.closing) return;
    const files = await this.repository.db.selectFrom("stored_files").select("relative_path").execute();
    await recoverParseFiles(this.port, new Set(files.map(file => file.relative_path)));
    if (this.closing) return;
    this.initialized = true;
    await this.refresh(); if (!this.closing) await this.worker.start();
  }
  snapshot(): readonly ImportTask[] { return this.tasks; }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  notice(): string | undefined { return this.config.error ? t("parse-config-invalid") : !this.config.current.enabled ? t("parse-config-disabled") : undefined; }
  openConfig(): void { Zotero.Utilities?.Internal.openPreferences("knowledgemcp-settings"); }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new ParseError("interrupted"));
    const pending = this.operations.then(async () => { await this.beforeWork?.(); if (this.closing) throw new ParseError("interrupted"); return operation(); }); this.operations = pending.catch(() => {}); return pending;
  }
  parse(itemIDs: number[], target?: KnowledgeTarget): Promise<void> { return this.enqueue(itemIDs, target, undefined, true); }
  enqueue(itemIDs: number[], target?: KnowledgeTarget, batch?: { title: string; sourceCollection: string; id?: string }, requirePDF = false, reuseHistory = false): Promise<void> {
    return this.schedule(async () => {
      const settings = this.config.current, profile = settings.profiles[settings.activeProfile];
      const grouping = batch ? { ...batch, id: batch.id ?? this.port.uuid() } : undefined;
      const processed = new Set<string>(), failures: string[] = [];
      for (const id of new Set(itemIDs)) {
        if (this.closing) break;
        const item = await Zotero.Items.getAsync?.(id); if (!item || item.deleted) continue;
        const attachments = item.isAttachment() ? [item.id] : item.getAttachments();
        for (const attachmentID of attachments) {
          if (this.closing) break;
          const attachment = await Zotero.Items.getAsync?.(attachmentID);
          if (!attachment || attachment.deleted || attachment.attachmentContentType !== "application/pdf" || processed.has(`${attachment.libraryID}:${attachment.key}`)) continue;
          processed.add(`${attachment.libraryID}:${attachment.key}`);
          try {
            const source = await this.repository.sourceFor(attachment.libraryID, attachment.key);
            if (!source) throw new ParseError("stale");
            const file = await this.port.attachment(attachment.libraryID, attachment.key, settings.maxFileBytes);
            const input: ParseInput = { sourceID: source.id, resourceID: source.resource_id, libraryID: attachment.libraryID, attachmentKey: attachment.key,
              title: source.title, itemType: item.isRegularItem() ? item.itemType : "attachment", fileName: file.name,
              target: (target ? knowledgeFolderPath(this.knowledge.snapshot, target) : "") || this.locations(source.resource_id), batch: grouping,
              parser: parserIdentity(profile, settings.activeProfile) };
            await this.repository.enqueue(input, await this.port.hash(file.bytes), settings.maxFailures, false, reuseHistory);
          } catch (error) { failures.push(parsingErrorMessage(error instanceof ParseError ? error.code : "internal")); }
        }
      }
      await this.refresh(); this.worker.wake();
      if (requirePDF && !processed.size) throw new KnowledgeUserError(t("parse-no-pdf"));
      if (failures.length) throw new KnowledgeUserError([...new Set(failures)].join("\n"));
    });
  }
  private locations(resourceID: string): string {
    return [...new Set(this.knowledge.snapshot.memberships.filter(row => row.resourceID === resourceID)
      .map(row => knowledgeFolderPath(this.knowledge.snapshot, row)))].filter(Boolean).join("; ");
  }
  refresh(): Promise<void> {
    this.refreshing = this.refreshing.catch(() => {}).then(async () => {
      if (this.closing) return;
      const rows = await this.repository.list();
      if (this.primePublished) {
        for (const job of rows) if (job.generation_id && ["succeeded", "partially_succeeded"].includes(job.state)) this.published.add(job.generation_id);
        this.primePublished = false;
      }
      const unresolved = await this.unresolvedJobs();
      const replaced = new Set(rows.map(job => (JSON.parse(job.payload_json) as ParseInput).replacesJobID).filter(Boolean));
      // Older versions did not link manual retries. Project only the latest
      // attempt for the same attachment fingerprint and parser identity.
      const latest = new Map(rows.map(job => [job.dedup_key, job.id]));
      const tasks: ImportTask[] = [], batches = new Set<string>();
      for (const job of rows) {
        if ((!unresolved.has(job.id) && (replaced.has(job.id) || latest.get(job.dedup_key) !== job.id)) || (JSON.parse(job.payload_json) as ParseInput).hidden) continue;
        const input = JSON.parse(job.payload_json) as ParseInput, run = await this.repository.run(job);
        const states: Record<string, ImportTaskStatus> = { pending: "queued", running: "parsing", waiting: run.external_job_id ? "parsing" : "queued",
          retry_wait: "retrying", needs_attention: "attention", succeeded: "completed", partially_succeeded: "partial", failed: "failed", cancelled: "cancelled" };
        const checkpoint = JSON.parse(job.checkpoint_json) as ParseCheckpoint;
        const uncertain = ["submitting", "ambiguous"].includes(run.submission_state) && job.state !== "running";
        const status = uncertain && job.state !== "cancelled" ? "attention" : run.stage === "importing" && job.state === "running" ? "publishing" : states[job.state];
        if (input.batch && !batches.has(input.batch.id)) {
          batches.add(input.batch.id); tasks.push({ id: `batch-${input.batch.id}`, kind: "folder", mode: "import", title: input.batch.title,
            sourceCollection: input.batch.sourceCollection, target: this.locations(input.resourceID) || displayStoredFolderPath(input.target), status: "queued" });
        }
        tasks.push({ id: job.id, kind: "item", title: input.title, itemType: input.itemType, fileName: input.fileName, target: this.locations(input.resourceID) || displayStoredFolderPath(input.target),
          parser: { provider: parserProvider(input.parser), model: input.parser.model },
          processing: { sourceID: input.sourceID, generationID: job.generation_id, parseTaskID: job.id, contentPartial: job.state === "partially_succeeded" },
          parentID: input.batch ? `batch-${input.batch.id}` : undefined, replacesID: input.replacesJobID, status, stage: status === "completed" || checkpoint.phase === "publish" ? "publish"
            : checkpoint.phase === "download" ? "download" : checkpoint.phase === "submit" || !run.external_job_id ? "upload" : "parse", errorCode: uncertain ? "ambiguous" : job.error_code ?? undefined,
          extraction: { phase: checkpoint.extractionPhase ?? (checkpoint.phase === "publish" ? "saving" : checkpoint.phase === "download" ? "downloading"
            : run.external_job_id ? checkpoint.phase === "submit" ? "uploading" : "parsing" : "local-queue"),
            startedAt: checkpoint.phaseStartedAt ?? (!run.external_job_id ? job.created_at : undefined), updatedAt: checkpoint.progressUpdatedAt },
          pages: run.progress_current !== null ? { completed: run.progress_current, total: run.progress_total ?? undefined } : undefined });
      }
      if (this.closing) return;
      this.tasks = tasks;
      for (const listener of this.listeners) { try { listener(); } catch { Zotero.debug("[ZoteroKnowledgeMCP] Parse task view refresh failed."); } }
      const fresh = rows.flatMap(job => job.generation_id && ["succeeded", "partially_succeeded"].includes(job.state) && !this.published.has(job.generation_id) ? [job.generation_id] : []);
      if (fresh.length && typeof this.knowledge.refresh === "function") {
        try { await this.knowledge.refresh(); for (const id of fresh) this.published.add(id); }
        catch { Zotero.debug("[ZoteroKnowledgeMCP] Published content metadata will refresh on the next update."); }
      }
    });
    return this.refreshing;
  }
  runAction(id: string, action: ImportTaskAction, value?: string): Promise<void> {
    return this.schedule(async () => {
      const jobs = await this.repository.list();
      const unresolved = await this.unresolvedJobs();
      const replaced = new Set(jobs.map(job => (JSON.parse(job.payload_json) as ParseInput).replacesJobID).filter(Boolean));
      const latest = new Map(jobs.map(job => [job.dedup_key, job.id])), batch = id.startsWith("batch-");
      const visible = (job: ProcessingJob) => (unresolved.has(job.id) || (!replaced.has(job.id) && latest.get(job.dedup_key) === job.id))
        && !(JSON.parse(job.payload_json) as ParseInput).hidden;
      const selected = batch ? jobs.filter(job => visible(job)
        && `batch-${(JSON.parse(job.payload_json) as ParseInput).batch?.id}` === id)
        : jobs.filter(job => job.id === id && visible(job));
      if (!selected.length) throw new ParseError("stale");
      const failures: unknown[] = [];
      for (const job of selected) {
        try {
          if (action === "cancel") { await this.repository.cancel(job.id); this.worker.cancel(job.id); }
          else if (action === "delete") {
            if (!["succeeded", "partially_succeeded", "failed", "cancelled"].includes(job.state)) throw new ParseError("stale");
            await this.repository.hide(job.id);
          }
          else if (action === "recover" && value) await this.repository.attachRemote(job.id, value, this.config.current.jobTimeoutMs);
          else if (action === "retry") {
            if (batch && (job.state === "succeeded" || job.error_code === "ambiguous")) continue;
            if (["submitting", "ambiguous"].includes((await this.repository.run(job)).submission_state)) {
              if (batch) continue;
              throw new ParseError("ambiguous");
            }
            if (["needs_attention", "retry_wait"].includes(job.state)) await this.repository.resume(job.id, this.config.current.jobTimeoutMs);
            else if (["failed", "cancelled", "partially_succeeded", "succeeded"].includes(job.state)) await this.retry(job);
          }
        } catch (error) { if (!batch) throw error; failures.push(error); }
      }
      await this.refresh(); this.worker.wake();
      if (failures.length) throw new KnowledgeUserError([...new Set(failures.map(error =>
        error instanceof ParseError ? parsingErrorMessage(error.code) : error instanceof KnowledgeUserError ? error.message : parsingErrorMessage("internal")))].join("\n"));
    });
  }
  private async unresolvedJobs(): Promise<Set<string>> {
    return new Set((await this.repository.db.selectFrom("parse_runs").select("job_id")
      .where("submission_state", "in", ["submitting", "ambiguous"]).execute()).map(run => run.job_id));
  }
  clearFinishedBatch(id: string): Promise<void> {
    return this.schedule(async () => {
      await this.repository.hideFinishedBatch(id);
      await this.refresh();
    });
  }
  private async retry(job: ProcessingJob): Promise<void> {
    const input = JSON.parse(job.payload_json) as ParseInput, config = this.config.current;
    const profile = config.profiles[config.activeProfile];
    const file = await this.port.attachment(input.libraryID, input.attachmentKey, config.maxFileBytes);
    if (job.state === "failed" && await this.repository.resumeResult(job.id, await this.port.hash(file.bytes), config.jobTimeoutMs)) return;
    input.parser = parserIdentity(profile, config.activeProfile);
    input.replacesJobID = job.id;
    await this.repository.enqueue(input, await this.port.hash(file.bytes), config.maxFailures, true);
  }
  async close(): Promise<void> {
    this.closing = true; this.listeners.clear();
    const worker = this.worker.close();
    const results = await Promise.allSettled([this.config.close(), this.operations, worker, this.refreshing, this.starting]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
