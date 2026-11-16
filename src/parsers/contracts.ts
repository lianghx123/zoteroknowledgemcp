import type { ExtractionPhase, ParseCheckpoint, ParsedDocument, ParserIdentity, ParsingConfig, ParseProgress } from "../shared/contracts/parsing";

export interface ParserSubmission { remoteID: string; checkpoint?: ParseCheckpoint }
export interface ParserResult { document: ParsedDocument; producerVersion?: string; resultSchema?: string }
export type StageParserArtifact = (key: string, bytes: Uint8Array, mediaType: string, role: string, pageNumber?: number, metadata?: Record<string, unknown>) => Promise<void>;

/** Queue capabilities are fenced and bounded; providers never write database rows. */
export interface ParserContext {
  identity: ParserIdentity;
  key: string;
  file: { bytes: Uint8Array; name: string };
  remoteID?: string;
  checkpoint: ParseCheckpoint;
  expectedPages?: number;
  limits: Pick<ParsingConfig, "requestTimeoutMs" | "jobTimeoutMs" | "pollIntervalMs" | "maxResultBytes">;
  signal: AbortSignal;
  uuid(): string;
  hash(value: string | Uint8Array): Promise<string>;
  assertActive(): void;
  /** Persists submission intent/identity, including ambiguous outcomes, atomically. */
  submit(operation: () => Promise<ParserSubmission>): Promise<void>;
  saveCheckpoint(value: ParseCheckpoint): Promise<void>;
  reportProgress(progress: ParseProgress): Promise<void>;
  /** Optional for clients that consume results without a task progress surface. */
  reportPhase?(phase: ExtractionPhase): Promise<void>;
  stage: StageParserArtifact;
  artifactCount(): number;
}

/** Each peer parser owns submission, upload, polling, validation and local assets. */
export interface DocumentParser {
  readonly id: string;
  readonly normalizers: readonly string[];
  /** Undefined yields the lease while waiting; a result is ready for shared publication. */
  process(context: ParserContext): Promise<ParserResult | undefined>;
}
