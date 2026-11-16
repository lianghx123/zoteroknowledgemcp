import type { ReaderContentRepository } from "../repositories/reader-content";
import { validateAttachment, validateMarkdown } from "../schemas/knowledge-content";
import type { AttachmentIdentity, AttachmentMarkdown } from "../shared/contracts/knowledge-content";

export class ContentReadService {
  private processedReader: ((identity: AttachmentIdentity) => Promise<AttachmentMarkdown | null>) | undefined;
  constructor(private readonly repository: ReaderContentRepository) {}
  setProcessedReader(read?: (identity: AttachmentIdentity) => Promise<AttachmentMarkdown | null>): void { this.processedReader = read; }

  async readAttachment(identity: AttachmentIdentity): Promise<AttachmentMarkdown | null> {
    validateAttachment(identity);
    let imported: AttachmentMarkdown | null = null, importError: unknown, importFailed = false;
    try { imported = await this.repository.read(identity); }
    catch (error) { importFailed = true; importError = error; }
    let processed: AttachmentMarkdown | null | undefined;
    try { processed = await this.processedReader?.(identity); }
    catch (error) { if (!imported) throw error; }
    if (!imported && !processed && importFailed) throw importError;
    return imported && (!processed || imported.updatedAt > processed.updatedAt) ? imported : processed ?? null;
  }

  async importMarkdown(identity: AttachmentIdentity, markdown: string): Promise<AttachmentMarkdown> {
    validateAttachment(identity);
    validateMarkdown(markdown);
    const content: AttachmentMarkdown = {
      formatVersion: 1, attachment: { ...identity }, markdown, origin: "import", updatedAt: Date.now(),
    };
    await this.repository.save(content);
    return content;
  }
}
