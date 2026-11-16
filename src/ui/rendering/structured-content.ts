import type { AttachmentMarkdown, MarkdownHeading } from "../../shared/contracts/knowledge-content";
import type { ReaderContentBlock, VisualLink } from "../../shared/contracts/visual-content";
import { t } from "../../shared/localization";
import { renderMarkdown } from "./markdown";
import { validateMarkdown } from "../../schemas/knowledge-content";
import { referenceEntryElement } from "./reference-entry";
import { isReferenceType, referencePrefix } from "../../shared/reference-number";
import { markReaderSource } from "./reader-source";

/** Use canonical types and persisted relations; imported Markdown keeps its own path. */
export function renderStructuredContent(doc: Document, content: AttachmentMarkdown, openURL: (url: string) => void) {
  validateMarkdown(content.markdown);
  const blocks = content.blocks;
  if (content.origin !== "parse" || !blocks?.length || blocks.map(block => block.markdown).join("\n\n") !== content.markdown
    || new Set(blocks.map(block => block.id)).size !== blocks.length) return renderMarkdown(doc, content.markdown, openURL, content.assets);
  const fragment = doc.createDocumentFragment(), headings: MarkdownHeading[] = [];
  const indices = new Map(blocks.map((block, index) => [block.id, index])), byID = new Map(blocks.map(block => [block.id, block]));
  const references = (content.references ?? []).filter(reference => (reference.markdown.trim() || reference.number !== null) && reference.blockIds.length
    && reference.blockIds.every(id => isReferenceType(byID.get(id)?.type ?? "")));
  const referenceOwners = new Map<string, typeof references>();
  const referenceMembers = new Set(references.flatMap(reference => reference.blockIds));
  for (const reference of references) {
    const first = reference.blockIds[0], entries = referenceOwners.get(first) ?? [];
    entries.push(reference); referenceOwners.set(first, entries);
  }
  const links = (content.visualLinks ?? []).filter(link => ["image", "table"].includes(byID.get(link.visualBlockId)?.type ?? "")
    && (!link.relatedBlockId || ["caption", "footnote"].includes(byID.get(link.relatedBlockId)?.type ?? "")));
  const memberOwner = new Map<string, string>(), groups = new Map<string, Set<string>>();
  for (const link of links) {
    const members = groups.get(link.visualBlockId) ?? new Set([link.visualBlockId]);
    if (link.relatedBlockId) {
      const start = Math.min(indices.get(link.visualBlockId)!, indices.get(link.relatedBlockId)!);
      const end = Math.max(indices.get(link.visualBlockId)!, indices.get(link.relatedBlockId)!);
      if (blocks.slice(start + 1, end).some(block => !["caption", "footnote", "image", "table"].includes(block.type))) continue;
      if (memberOwner.has(link.relatedBlockId)) continue;
      members.add(link.relatedBlockId); memberOwner.set(link.relatedBlockId, link.visualBlockId);
    }
    groups.set(link.visualBlockId, members);
  }
  for (const [owner, members] of groups) {
    const positions = [...members].map(id => indices.get(id)!);
    if (blocks.slice(Math.min(...positions), Math.max(...positions) + 1).some(block => !members.has(block.id))) {
      groups.delete(owner); for (const id of members) if (memberOwner.get(id) === owner) memberOwner.delete(id);
    }
  }
  const render = (markdown: string, parent: HTMLElement | DocumentFragment, caption = false, sources?: ReaderContentBlock[]) => {
    if (!markdown.trim()) return;
    let line = 0;
    const sourceSpans = sources?.map(source => { const startLine = line; line += source.markdown.split(/\r?\n/).length + 1;
      return { blockId: source.id, startLine, endLine: line - 1, pageStart: source.pageStart, pageEnd: source.pageEnd, isDocumentTitle: source.label === "doc_title" }; });
    const rendered = renderMarkdown(doc, markdown, openURL, content.assets, { headingOffset: headings.length, caption, sourceSpans });
    if (caption) for (const heading of rendered.headings) {
      const original = rendered.fragment.querySelector(`#${heading.id}`); if (!original) continue;
      const paragraph = doc.createElement("p"); paragraph.append(...Array.from(original.childNodes)); original.replaceWith(paragraph);
    }
    else headings.push(...rendered.headings);
    parent.append(rendered.fragment);
  };
  const caption = (markdown: string, parent: HTMLElement, blockID?: string, sources: ReaderContentBlock[] = []) => {
    const element = doc.createElement("div"); element.className = "km-visual-caption";
    if (blockID) element.dataset.blockId = blockID;
    markReaderSource(element, sources); render(markdown, element, true); parent.append(element);
  };
  const note = (markdown: string, parent: HTMLElement, blockID?: string, sources: ReaderContentBlock[] = []) => {
    const last = parent.lastElementChild;
    // Quote every provider note line so blank-line continuations cannot escape
    // their disclosure. This is display-only; canonical Markdown stays intact.
    const quoted = markdown.split(/\r?\n/).map(line => line.startsWith(">") ? line : `> ${line}`).join("\n");
    const rendered = renderMarkdown(doc, quoted, openURL, content.assets, { headingOffset: headings.length });
    headings.push(...rendered.headings);
    for (const detail of Array.from(rendered.fragment.querySelectorAll("details.km-reader-note"))) detail.classList.add("km-visual-note");
    const first = rendered.fragment.firstElementChild;
    if (blockID && first) (first as HTMLElement).dataset.blockId = blockID;
    if (first) markReaderSource(first as HTMLElement, sources);
    if (last?.matches("details.km-visual-note") && first?.matches("details.km-visual-note")) {
      markReaderSource(last as HTMLElement, sources);
      last.append(...Array.from(first.children).filter(child => child.tagName !== "SUMMARY")); first.remove();
    }
    parent.append(rendered.fragment);
  };
  const embedded = (parts: VisualLink[], parent: HTMLElement, sources: ReaderContentBlock[]) => {
    for (const part of parts.sort((a, b) => a.ordinal - b.ordinal)) {
      if (part.role === "caption") caption(part.markdown ?? "", parent, undefined, sources);
      else if (part.role === "note") note(part.markdown ?? "", parent, undefined, sources);
    }
  };
  const emitBlock = (block: ReaderContentBlock, parent: HTMLElement) => {
    if (block.type === "caption") caption(block.markdown, parent, block.id, [block]);
    else if (block.type === "footnote") note(block.markdown, parent, block.id, [block]);
    else {
      const parts = links.filter(link => link.visualBlockId === block.id && !link.relatedBlockId && link.markdown !== null);
      const body = parts.find(part => part.role === "body");
      // Embedded content is usable only when its complete provider reconstruction
      // matches the canonical block. Otherwise preserve the original block.
      const before = parts.filter(part => part.position === "before").sort((a, b) => a.ordinal - b.ordinal);
      const after = parts.filter(part => part.position === "after").sort((a, b) => a.ordinal - b.ordinal);
      if (body && [...before.map(part => part.markdown), body.markdown, ...after.map(part => part.markdown)].filter(Boolean).join("\n\n") === block.markdown) {
        embedded(before, parent, [block]); render(body.markdown ?? "", parent, false, [block]); embedded(after, parent, [block]);
      } else render(block.markdown, parent, false, [block]);
    }
  };
  const emitted = new Set<string>(); let pending: ReaderContentBlock[] = [];
  let abstract: HTMLElement | undefined;
  const flush = () => { if (pending.length) render(pending.map(block => block.markdown).join("\n\n"), fragment, false, pending); pending = []; };
  for (const block of blocks) {
    if (block.type !== "abstract") abstract = undefined;
    if (emitted.has(block.id)) continue;
    if (referenceMembers.has(block.id)) {
      flush();
      for (const reference of referenceOwners.get(block.id) ?? []) {
        // Protected manual records keep their stored text; normalize their label
        // for display only when it agrees with the separately stored number.
        const prefix = referencePrefix(reference.markdown);
        const recognized = prefix && (reference.number === null || reference.number === prefix.number) ? prefix : undefined;
        const body = doc.createDocumentFragment(); render(recognized?.content ?? reference.markdown, body);
        const source = recognized ? reference.markdown : byID.get(reference.blockIds[0])?.markdown ?? "";
        const numberStyle = /^\s*[*_]*(?:[（(]|\d+[)）])/u.test(source) ? "round" : "bracket";
        const entry = referenceEntryElement(doc, reference.number ?? recognized?.number ?? reference.order + 1, body, reference.number ?? recognized?.number ?? null, numberStyle);
        markReaderSource(entry, reference.blockIds.flatMap(id => byID.has(id) ? [byID.get(id)!] : []));
        entry.dataset.referenceId = reference.id; entry.dataset.blockId = block.id; fragment.append(entry);
      }
      continue;
    }
    const owner = memberOwner.get(block.id) ?? (groups.has(block.id) ? block.id : undefined);
    if (owner) {
      flush(); const group = doc.createElement("figure"); group.className = `km-visual-group km-visual-${byID.get(owner)!.type}`; group.dataset.blockId = owner;
      for (const member of blocks.filter(candidate => groups.get(owner)!.has(candidate.id))) { emitBlock(member, group); emitted.add(member.id); }
      fragment.append(group);
    } else if (block.type === "caption") { flush(); const standalone = doc.createElement("div"); caption(block.markdown, standalone, block.id, [block]); fragment.append(...Array.from(standalone.childNodes)); }
    else if (block.type === "abstract") {
      flush();
      if (!abstract) {
        abstract = doc.createElement("section"); abstract.className = "km-abstract"; abstract.dataset.blockId = block.id;
        abstract.setAttribute("aria-label", t("reader-abstract")); fragment.append(abstract);
      }
      markReaderSource(abstract, [block]); render(block.markdown, abstract, false, [block]);
    } else pending.push(block);
  }
  flush(); return { fragment, headings };
}
