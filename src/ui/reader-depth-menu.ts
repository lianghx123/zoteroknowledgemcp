import { t } from "../shared/localization";

/** Small themed menu, kept outside the directory's scrolling/clipping surface. */
export class ReaderDepthMenu {
  readonly button: HTMLButtonElement;
  private readonly menu: HTMLElement;
  private maximum = 0;
  private selected = 0;
  private disposed = false;
  private readonly outside = (event: Event) => {
    const target = event.target as Node | null;
    if (target && !this.menu.contains(target) && !this.button.contains(target)) this.close();
  };
  private readonly reposition = () => this.close();

  constructor(private readonly doc: Document, private readonly changed: (depth: number) => void) {
    this.button = doc.createElement("button"); this.button.type = "button";
    this.button.className = "km-contents-depth";
    this.button.title = t("reader-contents-depth");
    this.button.setAttribute("aria-haspopup", "menu"); this.button.setAttribute("aria-expanded", "false");
    this.menu = doc.createElement("div"); this.menu.className = "km-depth-menu";
    this.menu.id = "knowledgemcp-contents-depth-menu"; this.menu.hidden = true;
    this.menu.setAttribute("role", "menu"); this.menu.setAttribute("aria-label", t("reader-contents-depth"));
    this.button.setAttribute("aria-controls", this.menu.id);
    this.button.addEventListener("click", () => { if (this.menu.hidden) this.open(); else this.close(true); });
    this.button.addEventListener("keydown", event => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); event.stopPropagation(); this.open(event.key === "ArrowUp");
      }
    });
    this.menu.addEventListener("pointerdown", event => event.stopPropagation());
    this.menu.addEventListener("keydown", event => this.keydown(event));
    doc.body.append(this.menu);
    this.setOptions(0, 0);
  }

  setOptions(maximum: number, depth: number): void {
    this.close(); this.maximum = maximum; this.selected = depth ? Math.min(depth, maximum) : 0;
    this.button.textContent = this.label(this.selected);
    this.button.setAttribute("aria-label", `${t("reader-contents-depth")}: ${this.label(this.selected)}`);
    this.button.disabled = maximum < 2;
    this.menu.replaceChildren();
    for (const value of [...Array.from({ length: maximum }, (_, index) => index + 1), 0]) {
      if (value === 0 && maximum) {
        const separator = this.doc.createElement("div"); separator.className = "km-depth-menu-separator";
        separator.setAttribute("role", "separator"); this.menu.append(separator);
      }
      const item = this.doc.createElement("button"); item.type = "button"; item.tabIndex = -1;
      item.dataset.depth = String(value); item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(value === this.selected));
      const label = this.doc.createElement("span"); label.textContent = this.label(value);
      const check = this.doc.createElement("span"); check.className = "km-depth-menu-check";
      check.setAttribute("aria-hidden", "true"); check.textContent = value === this.selected ? "✓" : "";
      item.append(label, check);
      item.addEventListener("click", () => {
        if (this.disposed) return;
        this.setOptions(this.maximum, value); this.button.focus(); this.changed(value);
      }); this.menu.append(item);
    }
  }

  private label(depth: number): string {
    return depth ? t("reader-contents-depth-level", { depth }) : t("reader-contents-depth-all");
  }

  private open(last = false): void {
    if (this.disposed || this.button.disabled || !this.menu.hidden) return;
    this.menu.hidden = false; this.button.setAttribute("aria-expanded", "true");
    const anchor = this.button.getBoundingClientRect(), bounds = this.menu.getBoundingClientRect(), win = this.doc.defaultView!;
    this.menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, win.innerWidth - bounds.width - 8))}px`;
    const top = anchor.bottom + 6;
    this.menu.style.top = `${Math.max(8, top + bounds.height <= win.innerHeight - 8 ? top : anchor.top - bounds.height - 6)}px`;
    const items = Array.from(this.menu.querySelectorAll<HTMLButtonElement>("button"));
    (last ? items.at(-1) : items.find(item => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
    this.doc.addEventListener("pointerdown", this.outside, true);
    this.doc.addEventListener("focusin", this.outside, true);
    this.doc.addEventListener("scroll", this.reposition, true);
    win.addEventListener("resize", this.reposition);
  }

  private keydown(event: KeyboardEvent): void {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); this.close(true); return; }
    if (event.key === "Tab") { this.close(true); return; }
    const items = Array.from(this.menu.querySelectorAll<HTMLButtonElement>("button"));
    const index = items.indexOf(this.doc.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
      : event.key === "ArrowDown" ? (index + 1) % items.length
        : event.key === "ArrowUp" ? (index + items.length - 1) % items.length : -1;
    if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
  }

  close(restoreFocus = false): void {
    this.menu.hidden = true; this.button.setAttribute("aria-expanded", "false");
    this.doc.removeEventListener("pointerdown", this.outside, true);
    this.doc.removeEventListener("focusin", this.outside, true);
    this.doc.removeEventListener("scroll", this.reposition, true);
    this.doc.defaultView?.removeEventListener("resize", this.reposition);
    if (restoreFocus) this.button.focus();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.close(); this.menu.remove(); this.button.remove();
  }
}
