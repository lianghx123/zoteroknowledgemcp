import { LeaseLost, ParseError, type ExtractionPhase, type ParseInput, type ParsingPort } from "../../shared/contracts/parsing";
import { ProcessingRepository, type ProcessingJob, type JobCheckpoint } from "../../repositories/processing";
import type { ParsingConfigFile } from "../../services/parsing-config";
import { MAX_MARKDOWN_BYTES } from "../../schemas/knowledge-content";
import { parserIdentity } from "../../shared/parser-profile";
import { ParserRegistry } from "../../parsers/registry";
import type { ParserContext } from "../../parsers/contracts";
import { ParseArtifactStaging } from "./artifact-staging";

export class ParseWorker {
  readonly owner: string;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tickPromise: Promise<void> = Promise.resolve();
  private ticking = false;
  private closing: Promise<void> | undefined;
  private readonly executions = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  constructor(private readonly repository: ProcessingRepository, private readonly config: ParsingConfigFile, private readonly port: ParsingPort,
    private readonly parsers: ParserRegistry, private readonly changed: () => Promise<void>) { this.owner = port.uuid(); }

  async start(): Promise<void> { this.stopped = false; await this.repository.recover(); this.schedule(0); }
  wake(): void { if (!this.stopped) this.schedule(0); }
  private async notify(): Promise<void> {
    try { await this.changed(); }
    catch { Zotero.debug("[ZoteroKnowledgeMCP] Parse task view refresh will retry."); }
  }
  cancel(id: string): void { this.executions.get(id)?.controller.abort(); }
  async drainDeleted(): Promise<void> {
    const live = new Set((await this.repository.db.selectFrom("processing_jobs").select("id").execute()).map(row => row.id));
    const removed = [...this.executions].filter(([id]) => !live.has(id));
    for (const [, execution] of removed) execution.controller.abort();
    await Promise.allSettled(removed.map(([, execution]) => execution.promise));
  }
  private schedule(delay = 500): void {
    clearTimeout(this.timer);
    if (!this.stopped) this.timer = setTimeout(() => { if (this.ticking) this.schedule(); else this.tickPromise = this.tick(); }, delay);
  }
  private async tick(): Promise<void> {
    if (this.ticking) { this.schedule(); return; }
    this.ticking = true;
    try {
      if (this.stopped) return;
      await this.repository.recover();
      const settings = this.config.current;
      const window = Zotero.getMainWindows?.().find(window => !window.closed) as (Window & typeof globalThis) | undefined;
      if (!window) return;
      if (settings.enabled) while (!this.stopped && this.executions.size < settings.concurrency) {
        // The bootstrap sandbox does not expose AbortController. Prepare the
        // native controller before claiming so setup failures cannot strand a lease.
        const controller = new window.AbortController();
        const job = await this.repository.claim(this.owner); if (!job) break;
        const promise = this.execute(job, controller).catch(() => {
          Zotero.debug("[ZoteroKnowledgeMCP] Parse execution could not persist its outcome; lease recovery remains active.");
        }).finally(async () => { this.executions.delete(job.id); await this.notify(); });
        this.executions.set(job.id, { controller, promise });
      }
    } catch { Zotero.debug("[ZoteroKnowledgeMCP] Parse scheduling temporarily failed."); }
    finally { this.ticking = false; this.schedule(); }
  }

  private async execute(job: ProcessingJob, controller: AbortController): Promise<void> {
    let heartbeat: ReturnType<typeof setTimeout> | undefined, renewal = Promise.resolve(), fenced = false;
    let acceptedSubmission = false;
    let staging: ParseArtifactStaging | undefined;
    const renew = () => {
      heartbeat = setTimeout(() => {
        renewal = this.repository.heartbeat(job).catch(() => { fenced = true; controller.abort(); }).then(() => {
          if (!controller.signal.aborted && !this.stopped) renew();
        });
      }, 20000);
    };
    const assertActive = () => { if (this.stopped || controller.signal.aborted || fenced) throw new LeaseLost(); };
    renew();
    try {
      assertActive();
      await this.repository.db.transaction().execute(tx => this.repository.guard(tx, job));
      let run = await this.repository.run(job);
      // Submission uncertainty must remain recoverable even when the original
      // credentials or local attachment are temporarily unavailable.
      if (["submitting", "ambiguous"].includes(run.submission_state)) throw new ParseError("ambiguous");
      let input = JSON.parse(job.payload_json) as ParseInput;
      const settings = this.config.current;
      const checkpoint = JSON.parse(job.checkpoint_json) as JobCheckpoint;
      const phaseUpdate = (phase: ExtractionPhase) => ({ extractionPhase: phase,
        phaseStartedAt: checkpoint.extractionPhase === phase ? checkpoint.phaseStartedAt ?? Date.now() : Date.now(), progressUpdatedAt: Date.now() });
      const reportPhase = async (phase: ExtractionPhase) => {
        assertActive();
        const value = phaseUpdate(phase);
        await this.repository.checkpoint(job, value); Object.assign(checkpoint, value);
        await this.notify();
      };
      if (run.submission_state === "not_submitted" && !checkpoint.extractionPhase) await reportPhase("preparing");
      const file = await this.port.attachment(input.libraryID, input.attachmentKey, settings.maxFileBytes);
      assertActive(); if (await this.port.hash(file.bytes) !== job.input_fingerprint) throw new ParseError("stale");
      if (run.submission_state === "not_submitted") {
        const profile = settings.profiles[settings.activeProfile];
        job = await this.repository.configureUnsubmitted(job, parserIdentity(profile, settings.activeProfile));
        input = JSON.parse(job.payload_json) as ParseInput; run = await this.repository.run(job);
      }
      const parser = this.parsers.resolve(input.parser), key = this.config.credential(input.parser);
      if (run.external_job_id && Date.now() > (checkpoint.deadline ?? run.created_at + settings.jobTimeoutMs)) throw new ParseError("timeout");
      staging = new ParseArtifactStaging(this.repository, job, this.port, settings.maxResultBytes, assertActive);
      let submissionStarted = false;
      const context: ParserContext = {
        identity: input.parser, key, file, checkpoint, remoteID: run.external_job_id ?? undefined, expectedPages: run.progress_total ?? undefined,
        limits: { requestTimeoutMs: settings.requestTimeoutMs, jobTimeoutMs: settings.jobTimeoutMs,
          pollIntervalMs: settings.pollIntervalMs, maxResultBytes: settings.maxResultBytes },
        signal: controller.signal, uuid: () => this.port.uuid(), hash: value => this.port.hash(value), assertActive,
        stage: staging.store, artifactCount: () => staging!.artifacts.length,
        saveCheckpoint: async value => { assertActive(); await this.repository.checkpoint(job, value); },
        reportPhase,
        reportProgress: async progress => {
          assertActive();
          const telemetry = phaseUpdate(progress.state === "done" ? "downloading" : progress.state === "failed" ? checkpoint.extractionPhase ?? "remote-queue"
            : progress.phase ?? (progress.state === "pending" ? "remote-queue" : "parsing"));
          await this.repository.checkpoint(job, { phase: progress.state === "done" ? "download" : "poll",
            ...telemetry, completed: progress.completed ?? run.progress_current ?? undefined, total: progress.total ?? run.progress_total ?? undefined },
          { stage: progress.state === "done" ? "downloading" : "polling", progress_current: progress.completed ?? run.progress_current,
            progress_total: progress.total ?? run.progress_total });
          Object.assign(checkpoint, telemetry);
          run.progress_current = progress.completed ?? run.progress_current; run.progress_total = progress.total ?? run.progress_total;
          await this.notify();
        },
        submit: async operation => {
          if (run.external_job_id || submissionStarted) throw new ParseError("format");
          submissionStarted = true;
          if (!(await this.repository.reserveSubmission(job, settings.remoteConcurrency))) { if (checkpoint.extractionPhase !== "local-queue") await reportPhase("local-queue"); return; }
          await reportPhase("uploading"); assertActive();
          let submission;
          try { submission = await operation(); }
          catch (error) {
            if (error instanceof ParseError && (error.submissionRejected || error.code === "credentials" || /^http-4\d\d$/.test(error.code))) {
              await this.repository.checkpoint(job, { phase: "submit" }, { submission_state: "not_submitted", stage: "validating" }); throw error;
            }
            throw new ParseError("ambiguous");
          }
          acceptedSubmission = true; assertActive();
          if (typeof submission.remoteID !== "string" || !submission.remoteID || submission.remoteID.length > 512) throw new ParseError("ambiguous");
          // Retry local acknowledgement only, never the external submission.
          for (let attempt = 0; ; attempt++) {
            try {
              await this.repository.checkpoint(job, { phase: "poll", ...submission.checkpoint, deadline: Date.now() + settings.jobTimeoutMs },
                { external_job_id: submission.remoteID, submission_state: "confirmed", stage: "polling" });
              break;
            } catch (error) {
              if (error instanceof LeaseLost) throw error;
              assertActive(); if (attempt >= 2) throw new ParseError("ambiguous");
            }
          }
          // A signed upload allocation is not the PDF upload itself.
          if (submission.checkpoint?.phase !== "submit") await reportPhase("remote-queue");
        },
      };
      const result = await parser.process(context);
      assertActive();
      if (!result) { await this.repository.finish(job, "waiting", null, settings.pollIntervalMs); return; }
      const { document } = result;
      if (!parser.normalizers.includes(document.normalizerVersion)) throw new ParseError("format");
      if (new TextEncoder().encode(document.markdown).length > MAX_MARKDOWN_BYTES) throw new ParseError("size");
      await staging.store("document.md", new TextEncoder().encode(document.markdown), "text/markdown", "markdown");
      await staging.store("pages.json", new TextEncoder().encode(JSON.stringify(document.pages)), "application/json", "pages");
      await this.repository.checkpoint(job, { phase: "publish", completed: document.pages.length, total: document.total }, {
        stage: "importing", ...(result.producerVersion ? { parser_version: result.producerVersion } : {}),
        ...(result.resultSchema ? { result_schema_version: result.resultSchema } : {}),
      });
      await reportPhase("saving");
      const currentFile = await this.port.attachment(input.libraryID, input.attachmentKey, settings.maxFileBytes);
      assertActive(); if (await this.port.hash(currentFile.bytes) !== job.input_fingerprint) throw new ParseError("stale");
      await this.repository.publish(job, document, staging.artifacts);
      await staging.committed();
    } catch (error) {
      await staging?.rollback();
      if (error instanceof LeaseLost || this.stopped || controller.signal.aborted || fenced) return;
      const run = await this.repository.run(job);
      const failure = ["submitting", "ambiguous"].includes(run.submission_state) ? new ParseError("ambiguous")
        : error instanceof ParseError ? error : new ParseError("internal");
      const attention = ["ambiguous", "credentials", "timeout", "missing", "edited"].includes(failure.code)
        || (failure.code === "internal" && acceptedSubmission && Boolean(run.external_job_id));
      const state = failure.code === "stale" ? "cancelled" : attention ? "needs_attention"
        : failure.retryable && job.failure_count + 1 < job.max_failures ? "retry_wait" : "failed";
      await this.repository.finish(job, state, failure.code, failure.retryAfterMs ?? Math.min(300000, 2000 * 2 ** job.failure_count) + Math.floor(Math.random() * 1000));
    } finally { clearTimeout(heartbeat); await renewal; }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.stopped = true; clearTimeout(this.timer);
      for (const execution of this.executions.values()) execution.controller.abort();
      await this.tickPromise;
      // A claim in progress may have registered after the first cancellation.
      for (const execution of this.executions.values()) execution.controller.abort();
      await Promise.allSettled([...this.executions.values()].map(execution => execution.promise));
      await this.repository.releaseOwner(this.owner);
    })();
  }
}
