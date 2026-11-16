import type { AttachmentMarkdown } from "../shared/contracts/knowledge-content";
import type { ReaderContentBlock } from "../shared/contracts/visual-content";
import { validateMarkdown } from "../schemas/knowledge-content";
import { readerBlockType, type ReaderBlockType } from "../shared/contracts/reader-edit";
export { readerBlockType, readerBlockTypes } from "../shared/contracts/reader-edit";

interface BlockChange { index: number; before?: ReaderContentBlock; after?: ReaderContentBlock; bytes: number; }
const historyLimit = 200, historyBytes = 8 * 1024 * 1024;

/** Convert only the old type's outer syntax, preserving its text payload. */
export function convertReaderBlock(block: ReaderContentBlock, type: ReaderBlockType): ReaderContentBlock {
  const old = readerBlockType(block.type);
  if (old === type) return { ...block };
  let body = block.markdown;
  if (old === "heading") body = body.replace(/^ {0,3}#{1,6}\s+/, "");
  if (old === "formula") body = body.replace(/^\s*(?:\$\$\s*([\s\S]*?)\s*\$\$|\\\[\s*([\s\S]*?)\s*\\\])\s*$/, (_match, dollars, brackets) => dollars ?? brackets);
  if (old === "code") {
    const match = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\1\s*$/.exec(body);
    if (match) body = match[2];
  }
  if (old === "footnote") body = body.replace(/^> ?/gm, "");
  if (old === "list") body = body.replace(/^(\s*)(?:[-+*]|\d+[.)])\s+/gm, "$1");
  if (type === "heading") body = `## ${body}`;
  if (type === "formula") body = `$$\n${body}\n$$`;
  if (type === "footnote") body = body.split("\n").map(line => `> ${line}`).join("\n");
  if (type === "list") body = body.split("\n").map(line => line.trim() ? `- ${line}` : line).join("\n");
  if (type === "code") {
    const length = Math.max(3, ...Array.from(body.matchAll(/`+/g), match => match[0].length + 1));
    const fence = "`".repeat(length); body = `${fence}\n${body}\n${fence}`;
  }
  return { ...block, type, markdown: body, label: type === "heading" ? "paragraph_title" : type === "formula" ? "display_formula" : type };
}

/** Mutable session copy. Original parse blocks, source locations and indexes are never written. */
export class ReaderBlockSession {
  private blocks: ReaderContentBlock[];
  private readonly touched = new Set<string>();
  private serial = 0;
  private readonly undoStack: BlockChange[] = [];
  private readonly redoStack: BlockChange[] = [];
  private retainedBytes = 0;
  private readonly originals: Map<string, ReaderContentBlock>;

  constructor(private readonly original: AttachmentMarkdown) {
    this.blocks = original.blocks!.map(block => ({ ...block })); this.originals = new Map(this.blocks.map(block => [block.id, block]));
  }
  get baseGenerationID(): string | undefined { return this.original.generationID; }
  get dirty(): boolean { return this.touched.size > 0; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get historyStats() { return { undo: this.undoStack.length, redo: this.redoStack.length, bytes: this.retainedBytes, maxEntries: historyLimit, maxBytes: historyBytes }; }

  get(id: string): ReaderContentBlock | undefined { const block = this.blocks.find(block => block.id === id); return block && { ...block }; }
  isNew(id: string): boolean { return !this.originals.has(id); }

  replace(id: string, draft: ReaderContentBlock): boolean {
    const index = this.blocks.findIndex(block => block.id === id);
    if (index < 0 || !readerBlockType(draft.type)) return false;
    const prior = this.blocks[index];
    if (prior.markdown === draft.markdown && prior.type === draft.type && prior.label === draft.label) return false;
    const next = [...this.blocks]; next[index] = { ...prior, markdown: draft.markdown, type: draft.type, label: draft.label };
    this.validate(next); this.blocks = next; this.record(index, prior, next[index]); this.refreshTouched(id); return true;
  }

  insertAfter(id?: string): string | undefined {
    const index = id === undefined && !this.blocks.length ? -1 : this.blocks.findIndex(block => block.id === id);
    if (index < 0 && this.blocks.length) return;
    let next: string; do { next = `reader-session-${++this.serial}`; } while (this.blocks.some(block => block.id === next));
    // New text has no physical PDF provenance; adjacency does not establish a page.
    const block = { id: next, type: "paragraph", label: "text", markdown: "" };
    this.blocks.splice(index + 1, 0, block); this.record(index + 1, undefined, block); this.refreshTouched(next); return next;
  }

  remove(id: string): boolean {
    const index = this.blocks.findIndex(block => block.id === id); if (index < 0) return false;
    const [before] = this.blocks.splice(index, 1); this.record(index, before); this.refreshTouched(id); return true;
  }

  cancelInsertion(id: string): void {
    const last = this.undoStack.at(-1);
    if (last?.before === undefined && last?.after?.id === id && !last.after.markdown.trim()) {
      this.blocks.splice(last.index, 1); this.undoStack.pop(); this.retainedBytes -= last.bytes; this.refreshTouched(id);
    } else this.remove(id);
  }

  undo(): string | undefined {
    const change = this.undoStack.pop(); if (!change) return;
    this.replay(change, false); this.redoStack.push(change); return (change.before ?? change.after)!.id;
  }
  redo(): string | undefined {
    const change = this.redoStack.pop(); if (!change) return;
    this.replay(change, true); this.undoStack.push(change); return (change.before ?? change.after)!.id;
  }
  private record(index: number, before?: ReaderContentBlock, after?: ReaderContentBlock): void {
    for (const change of this.redoStack) this.retainedBytes -= change.bytes;
    this.redoStack.length = 0;
    const bytes = new TextEncoder().encode(JSON.stringify([before, after])).byteLength;
    this.undoStack.push({ index, before, after, bytes }); this.retainedBytes += bytes;
    while (this.undoStack.length && (this.undoStack.length > historyLimit || this.retainedBytes > historyBytes)) this.retainedBytes -= this.undoStack.shift()!.bytes;
  }
  private replay(change: BlockChange, forward: boolean): void {
    const remove = forward ? change.before : change.after, insert = forward ? change.after : change.before;
    this.blocks.splice(change.index, remove ? 1 : 0, ...(insert ? [{ ...insert }] : []));
    this.refreshTouched((change.before ?? change.after)!.id);
  }
  private refreshTouched(id: string): void {
    const before = this.originals.get(id), after = this.blocks.find(block => block.id === id);
    if ((!before && !after) || (before && after && before.markdown === after.markdown && before.type === after.type && before.label === after.label)) this.touched.delete(id);
    else this.touched.add(id);
  }

  snapshot(): AttachmentMarkdown {
    const content = { ...this.original, blocks: this.blocks.map(block => ({ ...block })), markdown: this.blocks.map(block => block.markdown).join("\n\n") };
    if (!this.touched.size) return content;
    // A draft must not query embeddings or display projections from its old generation.
    return { ...content, generationID: undefined,
      visualLinks: content.visualLinks?.filter(link => !this.touched.has(link.visualBlockId) && (!link.relatedBlockId || !this.touched.has(link.relatedBlockId))),
      references: content.references?.filter(reference => reference.blockIds.every(id => !this.touched.has(id))) };
  }

  private validate(blocks: ReaderContentBlock[]): void {
    const markdown = blocks.map(block => block.markdown).join("\n\n");
    if (markdown.trim()) validateMarkdown(markdown);
  }
}
