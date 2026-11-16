import { CitationIndex, numericSuperscript, type CitationMatch, type CitationReference, type NativeResolvedCitation } from "../../services/citation-matching";
import type { NativeCitationHint } from "../../shared/contracts/citations";
import { referencePrefix } from "../../shared/reference-number";
import { t } from "../../shared/localization";
import { isSafeExternalURL } from "./markdown";

interface SourceRange { node: Text; start: number; end: number; }
let nextPreview = 0;

/** One delegated controller per loaded article; no work occurs on mouse movement. */
export class CitationPreview {
  private readonly matches = new Map<string, { element: HTMLElement; match: CitationMatch }>();
  private readonly references = new Map<string, HTMLElement>();
  private readonly popup: HTMLDivElement;
  private readonly listeners: Array<() => void> = [];
  private active?: HTMLElement;
  private timer?: number;
  private disposed = false;

  constructor(private readonly article: HTMLElement, private readonly openURL: (url: string) => void, native: readonly NativeCitationHint[] = []) {
    const doc = article.ownerDocument;
    this.popup = doc.createElement("div"); this.popup.className = "km-citation-preview"; this.popup.id = `km-citation-preview-${++nextPreview}`;
    this.popup.setAttribute("role", "dialog"); this.popup.setAttribute("aria-label", t("reader-citation-preview")); this.popup.hidden = true;
    const sources: CitationReference[] = Array.from(article.querySelectorAll<HTMLElement>(".km-reference-entry")).map((entry, index) => {
      const id = String(index); this.references.set(id, entry);
      const original = entry.dataset.originalReferenceNumber;
      return { id, number: original === undefined ? null : Number(original), text: entry.querySelector(".km-reference-body")?.textContent ?? "",
        numberStyle: entry.dataset.referenceNumberStyle === "round" ? "round" : "bracket" };
    });
    const identity = (text: string) => (referencePrefix(text)?.content ?? text).normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    const identities = sources.map(source => ({ id: source.id, text: identity(source.text) }));
    const nativeIDs = new Map<string, string[]>();
    const evidence: NativeResolvedCitation[] = native.map(hint => ({ ...hint, referenceIds: hint.references.flatMap(text => {
      const key = identity(text), known = nativeIDs.get(key); if (known) return known;
      let ids = identities.filter(source => source.text === key || Math.min(source.text.length, key.length) >= 60
        && (source.text.includes(key) || key.includes(source.text))).map(source => source.id);
      if (!ids.length) {
        const id = `native-${nativeIDs.size}`, prefix = referencePrefix(text), entry = doc.createElement("div"), body = doc.createElement("div");
        entry.dataset.citationNative = "true"; body.className = "km-reference-body"; body.textContent = text; entry.append(body); this.references.set(id, entry);
        sources.push({ id, number: prefix?.number ?? null, text, numberStyle: /^\s*[（(]/u.test(text) ? "round" : "bracket" }); ids = [id];
      }
      nativeIDs.set(key, ids); return ids;
    }) }));
    if (!sources.length) return;
    this.decorate(sources, evidence);
    if (!this.matches.size) return;
    doc.body.append(this.popup);
    const listen = (target: EventTarget, name: string, handler: (event: Event) => void, capture = false) => {
      target.addEventListener(name, handler, capture); this.listeners.push(() => target.removeEventListener(name, handler, capture));
    };
    const trigger = (node: EventTarget | null) => {
      const element = node && "nodeType" in node ? node as Node : undefined;
      const found = element?.nodeType === 1 ? (element as Element).closest<HTMLElement>(".km-citation") : element?.parentElement?.closest<HTMLElement>(".km-citation");
      // Trusted Gecko events can expose a different compartment wrapper than
      // the one returned by createElement. DOM identity is not a Map key here.
      return found && this.article.contains(found) ? this.matches.get(found.dataset.citationId ?? "")?.element : undefined;
    };
    listen(article, "pointerover", event => { const target = trigger(event.target); if (target) this.show(target); });
    listen(article, "pointerout", event => {
      const related = (event as PointerEvent).relatedTarget as Node | null;
      if (trigger(event.target) && !trigger(related) && !this.popup.contains(related)) this.scheduleHide();
    });
    listen(article, "focusin", event => { const target = trigger(event.target); if (target) this.show(target); });
    listen(article, "focusout", event => {
      const related = (event as FocusEvent).relatedTarget as Node | null;
      if (!trigger(related) && !this.popup.contains(related)) this.scheduleHide();
    });
    listen(article, "click", event => {
      const target = trigger(event.target); if (!target) return;
      this.show(target); if ((event as MouseEvent).detail === 0) this.popup.querySelector<HTMLButtonElement>("button")?.focus();
    });
    listen(article, "keydown", event => {
      const key = event as KeyboardEvent, target = trigger(event.target);
      if (!target || (key.key !== "Enter" && key.key !== " ")) return;
      key.preventDefault(); if (key.repeat) return;
      this.show(target); this.popup.querySelector<HTMLButtonElement>("button")?.focus();
    });
    listen(this.popup, "pointerenter", () => this.cancelHide());
    listen(this.popup, "pointerdown", event => event.stopPropagation());
    listen(this.popup, "pointerleave", () => this.scheduleHide());
    listen(this.popup, "focusin", () => this.cancelHide());
    listen(this.popup, "focusout", event => {
      const related = (event as FocusEvent).relatedTarget as Node | null;
      if (!this.popup.contains(related) && !trigger(related)) this.scheduleHide();
    });
    listen(doc, "keydown", event => {
      if ((event as KeyboardEvent).key === "Escape" && this.active) { event.preventDefault(); this.active.focus({ preventScroll: true }); this.hide(); }
    });
    listen(doc, "pointerdown", event => { if (!trigger(event.target) && !this.popup.contains(event.target as Node)) this.hide(); });
    listen(doc, "scroll", event => { if (!this.popup.contains(event.target as Node)) this.hide(); }, true);
    if (doc.defaultView) listen(doc.defaultView, "resize", () => { if (this.active) this.position(this.active); });
  }

  private decorate(references: readonly CitationReference[], native: readonly NativeResolvedCitation[]): void {
    const doc = this.article.ownerDocument, walker = doc.createTreeWalker(this.article, 4);
    const groups = new Map<Element, { text: string; ranges: SourceRange[] }>();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node as Text, parent = text.parentElement;
      if (!parent || parent.closest(".km-reference-entry,h1,h2,h3,h4,h5,h6")) continue;
      const block = parent.closest("p,li,td,th,div.km-body-prose"); if (!block || !this.article.contains(block)) continue;
      const group = groups.get(block) ?? { text: "", ranges: [] };
      if (parent.closest("a,button,.km-citation,code,pre,math,.km-math,sup,svg,summary")) group.text += "\u0000";
      else { const start = group.text.length; group.text += text.data; group.ranges.push({ node: text, start, end: group.text.length }); }
      groups.set(block, group);
    }
    const index = new CitationIndex(references, native, { body: [...groups.values()].map(group => group.text).join("\n\n") });
    for (const [block, group] of groups) {
      const source = block.closest<HTMLElement>("[data-citation-page-start]");
      const context = { pageStart: Number(source?.dataset.citationPageStart) || undefined, pageEnd: Number(source?.dataset.citationPageEnd) || undefined };
      for (const match of index.matches(group.text, context).reverse()) {
        const start = group.ranges.find(range => range.start <= match.start && range.end > match.start);
        const end = group.ranges.find(range => range.start < match.end && range.end >= match.end);
        if (!start || !end) continue;
        const range = doc.createRange(); range.setStart(start.node, match.start - start.start); range.setEnd(end.node, match.end - end.start);
        // Native buttons remain atomic inline boxes in Gecko even with display:inline.
        // A text span preserves the paragraph's line breaking and justification.
        const button = doc.createElement("span"); button.setAttribute("role", "button"); button.tabIndex = 0; button.className = "km-citation";
        button.setAttribute("aria-label", t("reader-citation-trigger", { citation: group.text.slice(match.start, match.end) }));
        button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-controls", this.popup.id);
        const id = String(this.matches.size); button.dataset.citationId = id; button.dataset.citationSource = match.source;
        button.append(range.extractContents()); range.insertNode(button); this.matches.set(id, { element: button, match });
      }
    }
    for (const marker of Array.from(this.article.querySelectorAll<HTMLElement>("sup,.km-math-inline"))) {
      if (marker.closest(".km-reference-entry,a,button,.km-citation,code,pre,h1,h2,h3,h4,h5,h6") || marker.parentElement?.closest("sup,.km-math")) continue;
      const label = marker.matches("sup") ? marker.textContent ?? "" : numericSuperscript(marker.querySelector("annotation")?.textContent ?? "");
      if (!label) continue;
      const block = marker.closest("p,li,td,th,div.km-body-prose");
      let context: { before: string; after: string } | undefined;
      if (block) {
        const before = doc.createRange(), after = doc.createRange();
        before.selectNodeContents(block); before.setEndBefore(marker); after.selectNodeContents(block); after.setStartAfter(marker);
        context = { before: before.toString(), after: after.toString() };
      }
      const match = index.superscript(label, context); if (!match) continue;
      const button = doc.createElement("span"); button.setAttribute("role", "button"); button.tabIndex = 0; button.className = "km-citation";
      const id = String(this.matches.size); button.dataset.citationId = id; button.dataset.citationSource = match.source;
      button.setAttribute("aria-label", t("reader-citation-trigger", { citation: label }));
      button.setAttribute("aria-haspopup", "dialog"); button.setAttribute("aria-expanded", "false"); button.setAttribute("aria-controls", this.popup.id);
      marker.replaceWith(button); button.append(marker); this.matches.set(id, { element: button, match });
    }
  }

  private cancelHide(): void {
    if (this.timer !== undefined) this.article.ownerDocument.defaultView?.clearTimeout(this.timer);
    this.timer = undefined;
  }
  private scheduleHide(): void {
    this.cancelHide(); this.timer = this.article.ownerDocument.defaultView?.setTimeout(() => this.hide(), 180);
  }
  hide(): void {
    this.cancelHide(); this.active?.setAttribute("aria-expanded", "false"); this.active = undefined;
    this.popup.hidden = true; this.popup.replaceChildren();
  }

  private show(target: HTMLElement): void {
    if (this.disposed) return;
    this.cancelHide(); if (this.active === target && !this.popup.hidden) return;
    this.hide(); this.active = target; target.setAttribute("aria-expanded", "true");
    const doc = this.article.ownerDocument, match = this.matches.get(target.dataset.citationId!)!.match;
    const header = doc.createElement("div"); header.className = "km-citation-preview-header";
    const title = doc.createElement("strong"); title.textContent = t("reader-citation-preview");
    const close = doc.createElement("button"); close.type = "button"; close.textContent = t("reader-citation-close");
    close.addEventListener("click", () => { target.focus({ preventScroll: true }); this.hide(); }); header.append(title, close); this.popup.append(header);
    if (match.ambiguous) { const notice = doc.createElement("p"); notice.className = "km-citation-notice"; notice.textContent = t("reader-citation-ambiguous"); this.popup.append(notice); }
    if (match.missing) { const notice = doc.createElement("p"); notice.className = "km-citation-notice"; notice.textContent = t("reader-citation-missing", { count: match.missing }); this.popup.append(notice); }
    for (const id of match.referenceIds) {
      const source = this.references.get(id)!;
      const item = doc.createElement("section"); item.className = "km-citation-preview-entry";
      const body = source.querySelector(".km-reference-body")!.cloneNode(true) as HTMLElement;
      // Cloned sanitized source DOM preserves complete math, emphasis and links.
      // IDs and event handlers belong to the original article only.
      for (const element of Array.from(body.querySelectorAll("[id]"))) element.removeAttribute("id");
      for (const link of Array.from(body.querySelectorAll<HTMLAnchorElement>("a[href]"))) link.addEventListener("click", event => {
        event.preventDefault(); const href = link.getAttribute("href")!; if (isSafeExternalURL(href)) this.openURL(href);
      });
      if (source.dataset.citationNative === "true") {
        const origin = doc.createElement("p"); origin.className = "km-citation-notice"; origin.textContent = t("reader-citation-pdf-source"); item.append(origin);
      }
      item.append(body); this.popup.append(item);
      if (!this.article.contains(source)) continue;
      const go = doc.createElement("button"); go.type = "button"; go.className = "km-citation-go";
      go.textContent = t("reader-citation-open", { number: source.dataset.referenceNumber ?? "" });
      go.addEventListener("click", () => {
        this.hide(); for (let parent = source.parentElement; parent; parent = parent.parentElement) if (parent.matches("details")) (parent as HTMLDetailsElement).open = true;
        source.scrollIntoView({ block: "center" }); source.tabIndex = -1; source.focus({ preventScroll: true });
      });
      item.append(go);
    }
    this.popup.hidden = false; this.position(target);
  }

  private position(target: HTMLElement): void {
    const view = this.article.ownerDocument.defaultView; if (!view) return;
    const anchor = target.getBoundingClientRect(), width = view.innerWidth, height = view.innerHeight, margin = 10;
    this.popup.style.maxWidth = `${Math.max(0, Math.min(520, width - margin * 2))}px`;
    this.popup.style.maxHeight = `${Math.max(0, Math.min(440, height - margin * 2))}px`;
    const bounds = this.popup.getBoundingClientRect();
    this.popup.style.left = `${Math.max(margin, Math.min(anchor.left, width - bounds.width - margin))}px`;
    const below = anchor.bottom + 7;
    this.popup.style.top = `${Math.max(margin, below + bounds.height <= height - margin ? below : anchor.top - bounds.height - 7)}px`;
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true; this.hide();
    for (const stop of this.listeners) stop(); this.listeners.length = 0; this.popup.remove();
    for (const { element } of this.matches.values()) element.replaceWith(...Array.from(element.childNodes));
    this.matches.clear(); this.references.clear();
  }
}
