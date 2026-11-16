import { t } from "../../shared/localization";
import type { KnowledgeMainWindow } from "./native-types";

type PaneName = "info" | "progress" | "processing";
interface NativeSection extends Element { open: boolean }
interface NativeContainer extends HTMLElement {
  initialize?: () => void;
  release?: () => void;
  _paneParent: HTMLElement;
  _collapsed: boolean;
  _lastScrollPaneID?: string;
  sidenav: NativeSidenav;
  pinnedPane: string | null;
  render(): void;
  initPaneOrder(order: string[]): void;
  changePaneOrder(id: string, index: number, options?: { render?: boolean }): Promise<void>;
  getPanes(): HTMLElement[];
  getEnabledPane(id: string): HTMLElement | null;
  scrollToPane(id: string, behavior?: string): Promise<unknown>;
  _getMinScrollHeightForPane(pane: HTMLElement): number;
}
interface NativeSidenav extends Element {
  container: NativeContainer;
  render(): void;
  toggleDefaultStatus(value: boolean): void;
  removePane(id: string): void;
}
interface NativeDeck extends Element { selectedPanel: Element }
interface NativeHeader extends HTMLElement { editable: boolean; titleField?: { value: string; readOnly: boolean } }
const paneNames: PaneName[] = ["info", "progress", "processing"];
const tag = "knowledgemcp-task-pane";
const pinnedPreference = "extensions.zotero.knowledgemcp.importTaskPinnedPane";
const pluginIcon = "chrome://knowledgemcp/content/ui/knowledge.svg";

/** Task content shares Zotero's deck, container base, section widgets and sidenav. */
export class TaskDetailsPane {
  readonly content: HTMLElement;
  readonly header: HTMLElement;
  private readonly container: NativeContainer | undefined;
  private readonly deck: NativeDeck | undefined;
  private readonly sidenav: NativeSidenav | undefined;
  private readonly collapsedObserver: MutationObserver | undefined;
  private previousPanel: Element | undefined;
  private previousContainer: NativeContainer | undefined;
  private active = false;
  private disposed = false;
  private readonly sections = new Map<PaneName, { wrapper: HTMLElement; body: HTMLElement }>();
  constructor(private readonly window: KnowledgeMainWindow) {
    const doc = window.document;
    this.content = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
    this.content.id = "km-import-task-details";
    this.content.className = "km-import-task-details zotero-view-item";
    this.content.setAttribute("aria-label", t("tasks-details")); this.content.tabIndex = 0;
    this.header = doc.createElementNS("http://www.w3.org/1999/xhtml", "header") as HTMLElement;
    this.header.id = "km-import-task-header";
    try {
      const registry = window.customElements, itemDetails = registry?.get("item-details");
      const deck = doc.getElementById("zotero-item-pane-content") as NativeDeck | null;
      const sidenav = doc.getElementById("zotero-view-item-sidenav") as NativeSidenav | null;
      if (doc.createXULElement && itemDetails && deck && sidenav) {
        const Base = Object.getPrototypeOf(itemDetails) as new () => NativeContainer;
        if (!registry.get(tag)) {
          // Keep the registration independent of any addon instance or service.
          registry.define(tag, class extends Base {
            init(): void { this.initialize?.(); }
            destroy(): void { this.release?.(); }
          });
        }
        const container = doc.createXULElement(tag) as NativeContainer;
        container.setAttribute("tabType", "library");
        container.classList.add("km-task-native-container");
        const main = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
        if (registry.get("item-pane-header")) {
          this.header = doc.createXULElement("item-pane-header") as NativeHeader;
          this.header.id = "km-import-task-header";
        }
        main.className = "zotero-view-item-main"; main.append(this.header, this.content); container.append(main);
        container.initialize = () => { container._paneParent = this.content; };
        // Task snapshots own body rendering. Reordering must not reapply the old
        // sidenav preference before the native command has persisted its new order.
        container.render = () => {};
        // Reuse the host's ordering behavior rather than maintaining a second scheme.
        container.initPaneOrder = order => Reflect.apply(itemDetails.prototype.initPaneOrder, container, [order]);
        container.changePaneOrder = async () => {
          // The shared sidenav also retains hidden native buttons. Its raw index
          // does not match this container's three panes; use its resulting order.
          const ids = new Set(container.getPanes().map(pane => pane.dataset.pane));
          const order = Array.from(sidenav.querySelectorAll<HTMLElement>("[data-pane]"))
            .map(button => button.dataset.pane!).filter(id => ids.has(id));
          container.initPaneOrder(order);
        };
        let pinned = String(Zotero.Prefs?.get(pinnedPreference, true) || "");
        container.setAttribute("pinnedPane", pinned);
        Object.defineProperties(container, {
          supportsPinning: { get: () => true }, supportsReorder: { get: () => true },
          pinnedPane: { get: () => pinned, set: (value: string | null) => {
            pinned = value ?? ""; container.setAttribute("pinnedPane", pinned);
            Zotero.Prefs?.set(pinnedPreference, pinned, true);
            if (pinned && container.getEnabledPane(pinned)) void container.scrollToPane(pinned, "instant");
            if (this.active) sidenav.render();
          } },
        });
        this.container = container; this.deck = deck; this.sidenav = sidenav;
        this.collapsedObserver = new (doc.defaultView as Window & typeof globalThis).MutationObserver(() => {
          if (!this.active || container._collapsed || !container._lastScrollPaneID) return;
          const id = container._lastScrollPaneID; container._lastScrollPaneID = "";
          void container.scrollToPane(id, "instant");
        });
        const keydown = (event: KeyboardEvent) => {
          if (event.target === this.content && event.key === "Tab" && !event.shiftKey && container.pinnedPane) {
            const head = container.getEnabledPane(container.pinnedPane)?.querySelector<HTMLElement>("collapsible-section > .head");
            if (head) { head.focus(); event.preventDefault(); event.stopPropagation(); }
          } else if (event.key === "Escape") {
            doc.querySelector<HTMLElement>('#km-import-tasks .km-task-select[aria-pressed="true"]')?.focus();
            event.preventDefault(); event.stopPropagation();
          }
        };
        this.content.addEventListener("keydown", keydown);
        container.release = () => { this.collapsedObserver?.disconnect(); this.content.removeEventListener("keydown", keydown); };
        deck.append(container);
      } else {
        this.content.classList.add("km-task-fallback");
        this.content.hidden = true;
        this.content.append(this.header);
        doc.getElementById("zotero-item-pane")?.append(this.content);
      }
      this.setTitle(t("tasks-details"));
      this.reset();
    } catch (error) { this.dispose(); throw error; }
  }

  reset(): void {
    // Preserve the native sections and their open state through progress updates.
    for (const name of paneNames) {
      let section = this.sections.get(name);
      if (!section) {
        const doc = this.window.document;
        const wrapper = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
        wrapper.className = "km-task-pane-section"; wrapper.dataset.pane = `knowledgemcp-task-${name}`;
        wrapper.dataset.orderable = "true"; wrapper.tabIndex = -1;
        wrapper.dataset.sidenavOptions = JSON.stringify({ l10nID: `knowledgemcp-tasks-pane-${name}`,
          icon: pluginIcon });
        const body = doc.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLElement;
        body.className = "km-task-section-body";
        if (this.container && doc.createXULElement) {
          const native = doc.createXULElement("collapsible-section") as NativeSection;
          native.setAttribute("custom", "true"); native.setAttribute("data-pane", wrapper.dataset.pane);
          native.setAttribute("label", t(`tasks-pane-${name}`));
          // Native collapse clips its direct child. Keep padded content inside
          // that child so padding cannot increase the collapsed header height.
          const clip = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
          clip.className = "km-task-section-clip"; clip.append(body);
          native.setAttribute("open", "true"); native.append(clip); wrapper.append(native);
        } else {
          const heading = doc.createElementNS("http://www.w3.org/1999/xhtml", "h2");
          heading.textContent = t(`tasks-pane-${name}`); wrapper.append(heading, body);
        }
        section = { wrapper, body }; this.sections.set(name, section); this.content.append(wrapper);
      }
      section.wrapper.hidden = false; section.body.replaceChildren();
    }
  }
  setTitle(title: string): void {
    const header = this.header as NativeHeader;
    if (header.titleField) {
      header.editable = false; header.titleField.readOnly = true;
      if (header.titleField.value !== title) header.titleField.value = title;
    } else {
      this.header.classList.add("km-task-header-fallback");
      this.header.textContent = title;
    }
  }
  body(name: PaneName): HTMLElement { return this.sections.get(name)!.body; }
  hide(name: PaneName): void { this.sections.get(name)!.wrapper.hidden = true; }
  show(active: boolean): void {
    if (!this.container || !this.deck || !this.sidenav) {
      this.content.hidden = !active; return;
    }
    if (active) {
      if (!this.active) {
        this.previousPanel = this.deck.selectedPanel; this.previousContainer = this.sidenav.container;
        const right = this.content.ownerDocument.getElementById("zotero-item-pane");
        if (right) this.collapsedObserver?.observe(right, { attributes: true, attributeFilter: ["collapsed"] });
      }
      this.active = true;
      this.deck.selectedPanel = this.container;
      this.container.sidenav = this.sidenav;
      this.sidenav.toggleDefaultStatus(false);
    } else if (this.active) {
      this.active = false;
      this.collapsedObserver?.disconnect();
      if (this.deck.selectedPanel === this.container && this.previousPanel?.isConnected) this.deck.selectedPanel = this.previousPanel;
      if (this.sidenav.container === this.container && this.previousContainer) this.sidenav.container = this.previousContainer;
      this.sidenav.toggleDefaultStatus(this.content.ownerDocument.getElementById("zotero-item-pane")?.getAttribute("view-type") !== "item");
    }
  }
  refresh(): void { if (this.active) this.sidenav?.render(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.show(false);
    this.collapsedObserver?.disconnect();
    if (this.container) {
      for (const section of this.sections.values()) this.sidenav?.removePane(section.wrapper.dataset.pane!);
      this.container.remove(); this.container.initialize = undefined; this.container.release = undefined;
    } else this.content.remove();
  }
  get native(): boolean { return Boolean(this.container); }
}
