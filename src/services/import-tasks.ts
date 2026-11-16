import type { ImportTask, ImportTaskAction, ImportTaskSource, ItemImportTask } from "../shared/contracts/import-tasks";
import { recoveryNotice, type StartupRecovery } from "./startup-recovery";
import type { ParsingService } from "./parsing";
import type { CollectionSyncService } from "./collection-sync";
import type { EmbeddingService } from "./embedding";

/** One displayed workflow per published attachment generation; jobs remain independent. */
export function mergeImportTasks(parsing: readonly ImportTask[], vectors: readonly ImportTask[]): ImportTask[] {
  const identity = (task: ItemImportTask) => task.processing?.generationID ? JSON.stringify([task.processing.sourceID, task.processing.generationID]) : undefined;
  const selected = new Map<string, ItemImportTask>();
  for (const task of vectors) if (task.kind === "item") {
    const key = identity(task); if (!key) continue;
    const current = selected.get(key);
    if (!current || (!current.embedding?.current && task.embedding?.current)) selected.set(key, task);
  }
  const consumed = new Set<string>();
  const combine = (task: ItemImportTask, vector: ItemImportTask): ItemImportTask => ({ ...task, stage: vector.stage, status: vector.status === "completed" && task.status === "partial" ? "partial" : vector.status,
    pages: undefined, counts: vector.counts, errorCode: vector.errorCode ?? (vector.status === "completed" ? task.errorCode : undefined),
    processing: task.processing ? { ...task.processing, contentPartial: task.processing.contentPartial || task.status === "partial" } : undefined,
    embedding: { ...vector.embedding!, taskID: vector.id, status: vector.status, provider: vector.parser?.provider, model: vector.parser?.model } });
  const result = parsing.map(task => {
    if (task.kind !== "item") return task;
    const key = identity(task), vector = key && selected.get(key);
    if (!vector || task.stage !== "publish" || !["completed", "partial"].includes(task.status)) return task;
    consumed.add(key!);return combine(task, vector);
  });
  for (const [key, vector] of selected) if (!consumed.has(key)) result.push(combine({ ...vector, id: `pipeline:${encodeURIComponent(key)}`, parser: undefined }, vector));
  return result;
}

export class ImportTasksService implements ImportTaskSource {
  constructor(private readonly parsing: ParsingService, private readonly sync: CollectionSyncService, private readonly embeddings?: EmbeddingService, private readonly recovery?: StartupRecovery) {}
  snapshot(): readonly ImportTask[] {
    const config = this.embeddings?.config?.current;
    const semanticPlan: ItemImportTask["semanticPlan"] = !config?.enabled ? "disabled" : !config.autoEmbed ? "manual" : config.paused ? "paused" : "automatic";
    const bindings = this.sync.snapshot(), ids = new Set(bindings.map(row => `batch-sync-${row.id}`)), tasks = mergeImportTasks(this.parsing.snapshot(), this.embeddings?.snapshot() ?? [])
      .map(task => task.kind === "item" ? { ...task, semanticPlan } : task);
    return [...bindings.filter(row => !this.sync.isHidden(row.id) || tasks.some(task => task.kind === "item" && task.parentID === `batch-sync-${row.id}`)).map(row => ({ id: `batch-sync-${row.id}`, kind: "folder" as const, mode: "sync" as const,
      title: row.title, sourceCollection: row.title, target: row.location, status: !row.enabled ? "paused" as const : row.error || tasks.some(task => task.kind === "item"
        && task.parentID === `batch-sync-${row.id}` && ["failed", "partial", "attention"].includes(task.status)) ? "attention" as const : "syncing" as const,
      changes: { added: row.added, removed: row.removed } })), ...tasks.filter(task => !ids.has(task.id))];
  }
  subscribe(listener: () => void): () => void { const parse = this.parsing.subscribe(listener), sync = this.sync.subscribe(listener), embed = this.embeddings?.subscribe(listener); const startup = this.recovery?.subscribe(listener); return () => { parse(); sync(); embed?.(); startup?.(); }; }
  notice(): string | undefined { return recoveryNotice(this.recovery?.snapshot()) ?? this.parsing.notice(); }
  openConfig(): void { this.parsing.openConfig(); }
  async runAction(id: string, action: ImportTaskAction, value?: string): Promise<void> {
    if (id.startsWith("embed:")) return this.embeddings?.runAction(id, action);
    const task = this.snapshot().find(row => row.id === id);
    if (task?.kind === "item" && task.embedding?.taskID) {
      if (action === "delete") {
        if (!["completed", "partial", "failed", "cancelled"].includes(task.status)) throw new Error("stale");
        if (!task.processing?.parseTaskID) return this.embeddings?.runAction(task.embedding.taskID, action);
        await this.embeddings?.runAction(task.embedding.taskID, action);
        return this.parsing.runAction(task.processing.parseTaskID, action, value);
      }
      if (!task.processing?.parseTaskID || (action !== "recover" && task.embedding.status !== "completed")) return this.embeddings?.runAction(task.embedding.taskID, action);
      return this.parsing.runAction(task.processing.parseTaskID, action, value);
    }
    const binding = this.sync.snapshot().find(row => `batch-sync-${row.id}` === id);
    if (task?.kind === "folder" && task.mode === "import" && ["retry", "cancel", "delete"].includes(action)) return this.runChildren(id, action);
    if (!binding) return this.parsing.runAction(id, action, value);
    if (action === "pause" || action === "cancel") await this.sync.setEnabled(binding.id, false);
    if (action === "resume" || action === "retry") await this.sync.setEnabled(binding.id, true);
    if (action === "retry") {
      const failures = this.snapshot().filter(task => task.kind === "item" && task.parentID === id
        && ["failed", "partial", "retrying", "attention"].includes(task.status) && task.errorCode !== "ambiguous");
      if (failures.length) await this.runChildren(id, "retry");
    }
    if (action === "delete") await this.sync.hide(binding.id);
  }
  private async runChildren(id: string, action: ImportTaskAction): Promise<void> {
    const children = this.snapshot().filter(row => row.kind === "item" && row.parentID === id), failures: unknown[] = [];
    for (const child of children) {
      if (action === "retry" && (!["failed", "partial", "cancelled", "attention", "retrying"].includes(child.status) || child.kind === "item" && child.errorCode === "ambiguous")) continue;
      if (action === "cancel" && ["completed", "failed", "partial", "cancelled"].includes(child.status)) continue;
      try { await this.runAction(child.id, action); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw failures[0];
  }
}
