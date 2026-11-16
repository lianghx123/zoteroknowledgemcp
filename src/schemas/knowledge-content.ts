import { t } from "../shared/localization";
import type { AttachmentIdentity, AttachmentMarkdown } from "../shared/contracts/knowledge-content";

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

/** Localized validation failures that may be shown in the reader. */
export class MarkdownContentError extends Error {}

export function validateAttachment(identity: AttachmentIdentity): void {
  if (!Number.isSafeInteger(identity.libraryID) || identity.libraryID < 1
    || !/^[A-Z0-9]{8}$/.test(identity.itemKey)) {
    throw new Error("Invalid attachment identity.");
  }
}

export function validateMarkdown(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MarkdownContentError(t("error-markdown-empty"));
  }
  if (new TextEncoder().encode(value).byteLength > MAX_MARKDOWN_BYTES) {
    throw new MarkdownContentError(t("error-markdown-size"));
  }
}

export function validateStoredMarkdown(value: unknown, identity: AttachmentIdentity): AttachmentMarkdown {
  if (!value || typeof value !== "object") throw new MarkdownContentError(t("error-stored-invalid"));
  const record = value as Partial<AttachmentMarkdown>;
  if (record.formatVersion !== 1 || record.origin !== "import"
    || record.attachment?.libraryID !== identity.libraryID
    || record.attachment?.itemKey !== identity.itemKey
    || !Number.isSafeInteger(record.updatedAt) || record.updatedAt! < 0) {
    throw new MarkdownContentError(t("error-stored-mismatch"));
  }
  validateMarkdown(record.markdown);
  return record as AttachmentMarkdown;
}
