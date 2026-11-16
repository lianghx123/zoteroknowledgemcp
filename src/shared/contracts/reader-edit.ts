import type { AttachmentIdentity, AttachmentMarkdown } from "./knowledge-content";
import type { ReaderContentBlock } from "./visual-content";

export const readerBlockTypes = ["heading", "abstract", "paragraph", "list", "code", "table", "image", "caption", "formula", "formula_number", "footnote", "reference"] as const;
export type ReaderBlockType = typeof readerBlockTypes[number];
export function readerBlockType(type: string): ReaderBlockType | undefined {
  if (type === "text") return "paragraph";
  if (type === "equation") return "formula";
  return readerBlockTypes.find(value => value === type);
}
export interface ReaderSaveRequest { attachment: AttachmentIdentity; baseGenerationID: string; blocks: ReaderContentBlock[]; }
export type ReaderSaveProvider = (request: ReaderSaveRequest) => Promise<AttachmentMarkdown>;
export class ReaderSaveError extends Error {
  constructor(readonly code: "conflict" | "invalid" | "unavailable") { super(`reader-save-${code}`); }
}
