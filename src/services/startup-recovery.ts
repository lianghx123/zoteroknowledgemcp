import { hostRuntime, hostSetTimeout, hostClearTimeout } from "../core/host-runtime";
import { t } from "../shared/localization";
import { ModelError, type RetrievalMode } from "../shared/contracts/retrieval";

export const recoveryStages = ["metadata", "files", "parsing", "embedding", "sync", "fulltext", "index"] as const;
export type RecoveryStage = typeof recoveryStages[number];
export interface RecoverySnapshot {
  state: "waiting" | "running" | "ready" | "failed" | "closed";
  stage: RecoveryStage;
  completed: readonly RecoveryStage[];
  failure?: { code: string; type: string };
  retryScheduled?: boolean;
  retryAttempt?: number;
}

export function recoveryNotice(snapshot?: RecoverySnapshot): string | undefined {
  if (!snapshot || snapshot.state === "ready" || snapshot.state === "closed") return;
  return t(snapshot.state === "failed" ? "startup-failed" : "startup-restoring", { stage: t(`startup-stage-${snapshot.stage}`) });
}

/** Restores persisted state after native UI readiness, with explicit capability gates. */
export class StartupRecovery {
  private value: RecoverySnapshot = { state: "waiting", stage: "metadata", completed: [] };
  private listeners = new Set<() => void>();
  private waiters = new Set<{ stage: RecoveryStage; resolve: () => void; reject: (error: Error) => void }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> = Promise.resolve();
  private scheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private indexRetries = 0;
  // Retain the original exception only in privileged memory, never in public snapshots/logs.
  private cause: unknown;
  constructor(private readonly steps: Record<RecoveryStage, () => Promise<void>>, private readonly ready: () => void = () => {}, private readonly indexRetryDelays: readonly number[] = [500, 2000]) {}
  snapshot(): RecoverySnapshot { return { ...this.value, completed: [...this.value.completed], ...(this.value.failure ? { failure: { ...this.value.failure } } : {}) }; }
  isReady(stage: RecoveryStage): boolean { return this.value.state !== "closed" && this.value.completed.includes(stage); }
  isRetrievalReady(mode: RetrievalMode): boolean {
    return mode === "fusion" ? this.isReady("fulltext") || this.isReady("index") : this.isReady(mode === "fulltext" ? "fulltext" : "index");
  }
  unavailable(stage: RecoveryStage): ModelError {
    return new ModelError(this.value.state === "failed" ? "recovery-failed" : this.value.state === "closed" ? "service-closed" : "initializing",
      this.value.state !== "closed", 0, { requestedStage: stage, stage: this.value.stage, ...(this.value.failure ? { failureCode: this.value.failure.code, failureType: this.value.failure.type } : {}), retryScheduled: Boolean(this.value.retryScheduled) });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(): void {
    for (const listener of this.listeners) { try { listener(); } catch { /* Views do not own recovery. */ } }
    for (const waiter of this.waiters) {
      if (this.isReady(waiter.stage)) { this.waiters.delete(waiter); waiter.resolve(); }
      else if (["failed", "closed"].includes(this.value.state)) { this.waiters.delete(waiter); waiter.reject(this.unavailable(waiter.stage)); }
    }
  }
  waitFor(stage: RecoveryStage): Promise<void> {
    const RuntimePromise = hostRuntime().Promise;
    if (this.isReady(stage)) return RuntimePromise.resolve();
    if (["failed", "closed"].includes(this.value.state)) return RuntimePromise.reject(this.unavailable(stage));
    return new RuntimePromise((resolve, reject) => { this.waiters.add({ stage, resolve, reject }); });
  }
  schedule(uiReady: Promise<unknown> = Promise.resolve()): void {
    if (this.scheduled || this.value.state === "closed") return;
    this.scheduled = true;
    // A short yield lets the native list paint before file scans and reconciliation.
    void hostRuntime().Promise.resolve(uiReady).then(() => {
      if (this.value.state !== "closed") this.timer = hostSetTimeout(() => { this.timer = undefined; this.scheduled = false; this.retry(); }, 100);
    }, error => { if (this.value.state !== "closed") { this.scheduled = false; this.recordFailure(error); this.publish(); } });
  }
  retry(automatic = false): void {
    if (this.value.state === "running" || this.value.state === "ready" || this.value.state === "closed" || this.scheduled) return;
    hostClearTimeout(this.retryTimer); this.retryTimer = undefined;
    if (!automatic) this.indexRetries = 0;
    delete this.value.retryScheduled; delete this.value.failure;
    this.value.state = "running"; this.publish();
    this.running = this.run();
  }
  private async run(): Promise<void> {
    try {
      for (const stage of recoveryStages) {
        if (this.snapshot().state === "closed") return;
        if (this.isReady(stage)) continue;
        this.value.stage = stage; this.publish();
        await this.steps[stage]();
        if (this.snapshot().state === "closed") return;
        this.value.completed = [...this.value.completed, stage]; this.publish();
        await new (hostRuntime().Promise)<void>(resolve => hostSetTimeout(resolve, 0));
      }
      if (this.value.state !== "closed") { this.ready(); this.cause = undefined; delete this.value.failure; delete this.value.retryScheduled; delete this.value.retryAttempt; this.value.state = "ready"; this.publish(); }
    } catch (error) {
      if (this.value.state !== "closed") {
        this.recordFailure(error);
        if (this.value.stage === "index" && this.indexRetries < this.indexRetryDelays.length) {
          const delay = this.indexRetryDelays[this.indexRetries++];
          this.value.retryScheduled = true; this.value.retryAttempt = this.indexRetries;
          this.retryTimer = hostSetTimeout(() => { this.retryTimer = undefined; this.retry(true); }, delay);
        }
        this.publish(); Zotero.debug(`[ZoteroKnowledgeMCP] Startup recovery failed at ${this.value.stage}: ${this.value.failure!.code}.`);
      }
    }
  }
  private recordFailure(error: unknown): void {
    this.cause = error;
    const known = new Set(["index-closed", "index-worker", "index-timeout", "index-wasm", "index-profile", "index-memory", "index-snapshot-size", "index-snapshot-hash", "index-labels", "index-length", "index-save-length", "index-write-length", "config", "config-changed", "credentials"]);
    const value = this.cause instanceof ModelError ? this.cause.code : this.cause instanceof Error ? this.cause.message : "";
    this.value.failure = { code: known.has(value) ? value : "unexpected-error", type: this.cause instanceof Error && ["Error", "TypeError", "RangeError", "AbortError", "CompileError"].includes(this.cause.name) ? this.cause.name : "Error" };
    this.value.state = "failed";
  }
  close(): Promise<void> {
    this.value.state = "closed"; this.cause = undefined; hostClearTimeout(this.timer); hostClearTimeout(this.retryTimer); delete this.value.retryScheduled; this.publish(); this.listeners.clear();
    return this.running;
  }
}
