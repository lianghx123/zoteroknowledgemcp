import type { ReaderContentBlock, VisualLink } from "./visual-content";
import type { ReaderReference } from "./references";

/** Attachment-specific content used by the Markdown reader. */
export interface AttachmentIdentity {
  libraryID: number;
  itemKey: string;
}

export interface AttachmentMarkdown {
  formatVersion: 1;
  attachment: AttachmentIdentity;
  markdown: string;
  origin: "import" | "parse";
  updatedAt: number;
  generationID?: string;
  assets?: Record<string, string>;
  partial?: boolean;
  blocks?: ReaderContentBlock[];
  visualLinks?: VisualLink[];
  references?: ReaderReference[];
}

export interface MarkdownHeading {
  id: string;
  title: string;
  level: number;
  isDocumentTitle?: boolean;
}
