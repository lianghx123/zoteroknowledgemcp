export interface ReaderOutlineTarget {
  heading: HTMLElement;
  button: HTMLButtonElement;
  level: number;
}

interface OutlineEntry extends ReaderOutlineTarget { parents: OutlineEntry[]; }

/** Tracks the reading line without scanning or rebuilding the directory on scroll. */
export class ReaderOutline {
  private readonly window: Window & typeof globalThis;
  private readonly entries: OutlineEntry[];
  private visible: OutlineEntry[] = [];
  private visibleEntries = new Set<OutlineEntry>();
  private current?: OutlineEntry;
  private marked: OutlineEntry[] = [];
  private frame?: number;
  private disposed = false;
  private reveal = false;
  private readonly intersection?: IntersectionObserver;
  private readonly resize?: ResizeObserver;
  private readonly schedule = () => this.refresh();
  private readonly disclosure = () => { this.collectVisible(); this.refresh(); };

  constructor(private readonly article: HTMLElement, private readonly directory: HTMLElement,
    private readonly toolbar: HTMLElement, targets: ReaderOutlineTarget[], depth = 0) {
    this.window = article.ownerDocument.defaultView!;
    const stack: OutlineEntry[] = [];
    this.entries = targets.map(target => {
      while (stack.length && stack[stack.length - 1].level >= target.level) stack.pop();
      const entry = { ...target, parents: [...stack] }; stack.push(entry); return entry;
    });
    this.collectVisible();
    this.setDepth(depth);
    article.addEventListener("scroll", this.schedule, { passive: true });
    article.addEventListener("load", this.schedule, true);
    article.addEventListener("toggle", this.disclosure, true);
    this.window.addEventListener("resize", this.schedule);
    // Scroll events also cover scrollbar jumps past headings that never intersect.
    if (this.window.IntersectionObserver) {
      this.intersection = new this.window.IntersectionObserver(this.schedule, { root: article });
      for (const entry of this.entries) this.intersection.observe(entry.heading);
    }
    if (this.window.ResizeObserver) {
      this.resize = new this.window.ResizeObserver(this.schedule);
      this.resize.observe(article);
      for (const entry of this.entries) this.resize.observe(entry.heading);
    }
    this.refresh();
  }

  get maxDepth(): number {
    return this.entries.reduce((maximum, entry) => Math.max(maximum, entry.parents.length + 1), 0);
  }

  setDepth(depth: number): void {
    if (this.disposed) return;
    for (const entry of this.entries) entry.button.hidden = depth > 0 && entry.parents.length >= depth;
    this.refresh(true);
  }

  private collectVisible(): void {
    this.visible = this.entries.filter(entry => !entry.heading.closest("details:not([open]), [hidden]"));
    this.visibleEntries = new Set(this.visible);
  }

  refresh(reveal = false): void {
    if (this.disposed) return;
    this.reveal ||= reveal;
    if (this.frame !== undefined) return;
    const callback = () => { this.frame = undefined; if (!this.disposed) this.update(); };
    this.frame = this.window.requestAnimationFrame
      ? this.window.requestAnimationFrame(callback) : this.window.setTimeout(callback, 16);
  }

  private update(): void {
    const viewport = this.article.getBoundingClientRect();
    if (!viewport.height) return;
    // Match the heading scroll margin, including fractional native scroll positions.
    const line = Math.max(viewport.top + 58, this.toolbar.getBoundingClientRect().bottom + 8) + 1;
    let low = 0, high = this.visible.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.visible[middle].heading.getBoundingClientRect().top <= line) low = middle + 1;
      else high = middle;
    }
    const atEnd = this.article.scrollHeight > this.article.clientHeight
      && this.article.scrollTop + this.article.clientHeight >= this.article.scrollHeight - 1;
    let next: OutlineEntry | undefined = this.visible[atEnd ? this.visible.length - 1 : low - 1];
    while (next?.button.hidden) next = next.parents.at(-1);
    const changed = next !== this.current;
    if (changed) {
      this.current?.button.removeAttribute("aria-current");
      for (const entry of this.marked) entry.button.classList.remove("km-contents-ancestor");
      this.current = next;
      this.marked = next?.parents.filter(parent => this.visibleEntries.has(parent) && !parent.button.hidden) ?? [];
      for (const entry of this.marked) entry.button.classList.add("km-contents-ancestor");
      next?.button.setAttribute("aria-current", "location");
    }
    if ((changed || this.reveal) && next && this.directory.getClientRects().length) {
      const bounds = this.directory.getBoundingClientRect(), item = next.button.getBoundingClientRect();
      if (item.top < bounds.top) this.directory.scrollTop += item.top - bounds.top;
      else if (item.bottom > bounds.bottom) this.directory.scrollTop += item.bottom - bounds.bottom;
    }
    this.reveal = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== undefined) {
      if (this.window.cancelAnimationFrame) this.window.cancelAnimationFrame(this.frame);
      else this.window.clearTimeout(this.frame);
    }
    this.intersection?.disconnect(); this.resize?.disconnect();
    this.article.removeEventListener("scroll", this.schedule);
    this.article.removeEventListener("load", this.schedule, true);
    this.article.removeEventListener("toggle", this.disclosure, true);
    this.window.removeEventListener("resize", this.schedule);
    this.current?.button.removeAttribute("aria-current");
    for (const entry of this.marked) entry.button.classList.remove("km-contents-ancestor");
  }
}
