import type { ItemImportTask } from "../../shared/contracts/import-tasks";
import type { ExtractionPhase } from "../../shared/contracts/parsing";
import { t } from "../../shared/localization";

export const extractionSteps = ["prepare", "wait", "parse", "download", "organize", "save"] as const;
export function extractionPhase(task: ItemImportTask): ExtractionPhase {
  return task.extraction?.phase ?? (task.stage === "publish" ? "saving" : task.stage === "download" ? "downloading"
    : task.stage === "parse" ? "parsing" : task.status === "queued" ? "local-queue" : "uploading");
}
export function extractionStep(task: ItemImportTask): number {
  const phase = extractionPhase(task);
  return ["local-queue", "preparing", "uploading"].includes(phase) ? 0 : ["remote-queue", "remote-preparing"].includes(phase) ? 1
    : phase === "parsing" ? 2 : phase === "downloading" ? 3 : phase === "organizing" ? 4 : 5;
}
export function waitingProgress(task: ItemImportTask): string | undefined {
  if (!task.extraction?.startedAt || !["queued", "parsing", "publishing"].includes(task.status)
    || !["local-queue", "remote-queue", "remote-preparing"].includes(extractionPhase(task))) return;
  const seconds = Math.max(0, Math.floor((Date.now() - task.extraction.startedAt) / 1000));
  return t(seconds < 60 ? "tasks-waited-seconds" : "tasks-waited-minutes", { count: seconds < 60 ? seconds : Math.floor(seconds / 60) });
}
export function currentAction(task: ItemImportTask): string {
  if (["completed", "partial", "failed", "cancelled"].includes(task.status)) return t(`tasks-status-${task.status}`);
  const action = task.stage === "embed" ? t("tasks-semantic-prepare") : task.stage === "index" ? t("tasks-semantic-index") : t(`tasks-phase-${extractionPhase(task)}`);
  return ["paused", "retrying", "attention"].includes(task.status) ? `${action} · ${t(`tasks-status-${task.status}`)}` : action;
}
export function pageProgress(task: ItemImportTask): string | undefined {
  if (!task.pages || !Number.isSafeInteger(task.pages.completed) || task.pages.completed < 0) return;
  const { completed, total } = task.pages;
  return total !== undefined && Number.isSafeInteger(total) && total > 0 && completed <= total
    ? t("tasks-parsed-pages", { completed, total, percent: Math.floor(completed / total * 100) }) : t("tasks-parsed-count", { completed });
}
export function semanticState(task: ItemImportTask): string {
  if (task.embedding || ["embed", "index"].includes(task.stage)) return task.embedding?.status === "completed" || task.status === "completed" ? "done" : task.status;
  return task.semanticPlan ?? "manual";
}
export function workflowGroup(task: ItemImportTask): number {
  return task.embedding || ["embed", "index"].includes(task.stage) ? 2 : 1;
}
