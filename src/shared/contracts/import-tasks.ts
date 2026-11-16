import type { ExtractionPhase } from "./parsing";

/** Task projections shared by processing services and native views. */
export type ImportTaskStatus = "queued" | "parsing" | "publishing" | "completed" | "failed" | "partial" | "cancelled" | "syncing" | "paused" | "retrying" | "attention";
export type ImportTaskStage = "metadata" | "upload" | "parse" | "download" | "publish" | "embed" | "index";

interface ImportTaskBase {
  id: string;
  title: string;
  target: string;
  status: ImportTaskStatus;
  replacesID?: string;
}

export interface ItemImportTask extends ImportTaskBase {
  kind: "item";
  parentID?: string;
  itemType: string;
  fileName: string;
  stage: ImportTaskStage;
  pages?: { completed: number; total?: number };
  extraction?: { phase: ExtractionPhase; startedAt?: number; updatedAt?: number };
  semanticPlan?: "automatic" | "manual" | "disabled" | "paused";
  errorCode?: string;
  parser?: { provider: string; model: string };
  processing?: { sourceID: string; generationID: string | null; parseTaskID?: string; contentPartial?: boolean };
  counts?: { completed: number; skipped: number; failed: number; total: number };
  embedding?: { dimensions: number; active: boolean; current?: boolean; taskID?: string; provider?: string; model?: string; status?: ImportTaskStatus };
}

export interface FolderImportTask extends ImportTaskBase {
  kind: "folder";
  mode: "import" | "sync";
  sourceCollection: string;
  changes?: { added: number; removed: number };
}

export type ImportTask = ItemImportTask | FolderImportTask;

export type ImportTaskAction = "cancel" | "retry" | "pause" | "resume" | "recover" | "delete";

/** Internal UI boundary. The task service owns state and action validation. */
export interface ImportTaskSource {
  snapshot(): readonly ImportTask[];
  subscribe(listener: () => void): () => void;
  runAction?(taskID: string, action: ImportTaskAction, value?: string): Promise<void>;
  notice?(): string | undefined;
  openConfig?(): void;
}

export const isActiveImportTask = (task: ImportTask): boolean => ["queued", "parsing", "publishing", "retrying"].includes(task.status);
