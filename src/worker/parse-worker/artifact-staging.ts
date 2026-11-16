import { ParseError, type ParsingPort } from "../../shared/contracts/parsing";
import { ProcessingRepository, type ProcessingJob, type StoredArtifact } from "../../repositories/processing";
import { parseFilePath } from "../../storage/parse-files";

/** One generated attempt namespace, shared by every parser and atomic publication. */
export class ParseArtifactStaging {
  readonly artifacts: StoredArtifact[] = [];
  private readonly written: string[] = [];
  private readonly prefix: string;
  private readonly manifestPath: string;
  private totalBytes = 0;
  constructor(private readonly repository: ProcessingRepository, job: ProcessingJob, private readonly port: ParsingPort,
    private readonly maxBytes: number, private readonly assertActive: () => void) {
    this.prefix = `parse/${job.id}/${job.execution_token}`;
    this.manifestPath = parseFilePath(`${this.prefix}/manifest.json`);
  }
  readonly store = async (key: string, bytes: Uint8Array, mediaType: string, role: string, pageNumber?: number, metadata?: Record<string, unknown>): Promise<void> => {
    this.assertActive();
    this.totalBytes += bytes.length; if (this.totalBytes > this.maxBytes) throw new ParseError("size");
    if (this.artifacts.some(artifact => artifact.key === key)) throw new ParseError("format");
    const relativePath = `${this.prefix}/${this.artifacts.length}.bin`, path = parseFilePath(relativePath);
    this.written.push(path);
    await this.port.write(this.manifestPath, new TextEncoder().encode(JSON.stringify({ files: [...this.artifacts.map(artifact => artifact.relativePath), relativePath] })));
    await this.port.write(path, bytes);
    this.artifacts.push({ id: this.port.uuid(), key, relativePath, mediaType, bytes: bytes.length, hash: await this.port.hash(bytes), role, pageNumber, metadata });
  };
  async committed(): Promise<void> { await this.port.remove(this.manifestPath).catch(() => {}); }
  async rollback(): Promise<void> {
    if (!this.written.length) return;
    let cleaned = true;
    try {
      // COMMIT may succeed before acknowledgement fails. Query ownership first;
      // an unavailable database is never evidence that files are orphaned.
      const retained = await this.repository.db.selectFrom("stored_files").select("relative_path").where("relative_path", "like", `${this.prefix}/%`).execute();
      const referenced = new Set(retained.map(file => parseFilePath(file.relative_path)));
      for (const path of this.written) {
        if (referenced.has(path)) continue;
        try { await this.port.remove(path); } catch { cleaned = false; }
      }
    } catch { cleaned = false; }
    if (cleaned) await this.port.remove(this.manifestPath).catch(() => {});
  }
}
