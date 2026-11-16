import type { AttachmentIdentity, AttachmentMarkdown } from "../shared/contracts/knowledge-content";

/** Replaceable read/import boundary; a generation repository can implement it later. */
export interface ReaderContentRepository {
  read(identity: AttachmentIdentity): Promise<AttachmentMarkdown | null>;
  save(content: AttachmentMarkdown): Promise<void>;
}
