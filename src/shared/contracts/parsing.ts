export interface ParserProfile {
  provider?: string;
  api: string;
  model: string;
  key: string;
  options: Record<string, unknown>;
}

export interface ParsingConfig {
  version: 1;
  enabled: boolean;
  activeProfile: string;
  profiles: Record<string, ParserProfile>;
  /** Selected configuration per parser; legacy names remain credential references. */
  parserProfiles?: Record<string, string>;
  concurrency: number;
  remoteConcurrency: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  jobTimeoutMs: number;
  maxFileBytes: number;
  maxResultBytes: number;
  maxFailures: number;
}

/** Immutable processing identity; credentials are resolved from the live config. */
export interface ParserIdentity extends Omit<ParserProfile, "key"> { profile: string; normalizer: string }
export interface ParseInput {
  sourceID: string;
  resourceID: string;
  libraryID: number;
  attachmentKey: string;
  title: string;
  itemType: string;
  fileName: string;
  target: string;
  batch?: { id: string; title: string; sourceCollection: string };
  parser: ParserIdentity;
  replacesJobID?: string;
  hidden?: boolean;
}
export type ExtractionPhase = "local-queue" | "preparing" | "uploading" | "remote-queue" | "remote-preparing" | "parsing" | "downloading" | "organizing" | "saving";
export interface ParseProgress { state: "pending" | "running" | "done" | "failed"; phase?: "remote-queue" | "remote-preparing" | "parsing"; completed?: number; total?: number; resultURL?: string }
/** Protocol and display checkpoints coexist with provider-private JSON data. */
export interface ParseCheckpoint {
  phase?: "submit" | "poll" | "download" | "publish";
  completed?: number;
  total?: number;
  deadline?: number;
  extractionPhase?: ExtractionPhase;
  phaseStartedAt?: number;
  progressUpdatedAt?: number;
  [key: string]: unknown;
}
export interface ParsedBlock {
  type: string;
  label: string;
  markdown: string;
  text: string;
  page: number;
  sourceID: string;
  bbox: number[] | null;
  headingLevel?: number;
  /** Approved parent by canonical block position; null means document root. */
  headingParentOrder?: number | null;
  pageEnd?: number;
  sourceIDs?: string[];
  locations?: Array<{ page: number; bbox: number[]; sourceID?: string }>;
  metadata?: Record<string, unknown>;
  qualityFlags?: string[];
}
export interface ParsedPage { number: number; width?: number; height?: number; raw: Record<string, unknown> }
export interface ParsedDocument {
  /** Algorithm that produced this content, independent of submission identity. */
  normalizerVersion: string;
  sectionHierarchy?: "heading-levels" | "legacy-two-level";
  pages: ParsedPage[];
  blocks: ParsedBlock[];
  total: number;
  partial: boolean;
  warnings: string[];
  markdown: string;
  detectedMetadata?: { title: string | null; abstract: string | null; language: string | null };
  errors?: Array<Record<string, unknown>>;
}
export interface ParsingPort {
  uuid(): string;
  hash(value: string | Uint8Array): Promise<string>;
  attachment(libraryID: number, key: string, maxBytes: number): Promise<{ bytes: Uint8Array; name: string }>;
  write(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
}

export class ParseError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfterMs?: number, readonly submissionRejected = false) { super(code); }
}
export class LeaseLost extends Error {}
