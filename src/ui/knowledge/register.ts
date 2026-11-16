import { mountSyncSettings } from "./sync-settings";
import { t } from "../../shared/localization";
import type { KnowledgeLibraryController, KnowledgeTarget } from "../../shared/contracts/knowledge-library";
import { KnowledgeLibraryTree, isKnowledgeRow, isKnowledgeTrashRow } from "./library-tree";
import { KnowledgeTitleStatus } from "./title-status";
import { confirmTrashPurge } from "./trash-list";
import { renderKnowledgeDetails } from "./details";
import { indexFolders } from "./folder-index";
import { knowledgeErrorMessage } from "../../shared/knowledge-errors";
import type { KnowledgeMainWindow, NativeMenuContext, NativeMenuEntry, NativeSectionProps } from "./native-types";
import type { ParsingService } from "../../services/parsing";
import type { CollectionSyncService } from "../../services/collection-sync";
import type { ImportTaskSource } from "../../shared/contracts/import-tasks";
import type { EmbeddingService } from "../../services/embedding";
import { CollectionSyncBadges, bindingsForSyncRoot, canConfigureCollectionSync } from "./collection-sync";
import styles from "../../../addon/content/ui/knowledge-library.css";

interface WindowUI { tree: KnowledgeLibraryTree; title: KnowledgeTitleStatus; sync?: CollectionSyncBadges }

export class KnowledgeLibraryUI {
  private readonly windows = new Map<KnowledgeMainWindow, WindowUI>();
  private readonly pending = new Map<KnowledgeMainWindow, ReturnType<typeof setTimeout>>();
  private readonly documents = new Map<Document, Element>();
  private readonly sections = new Map<HTMLElement, { refresh: () => Promise<void> }>();
  private menus: string[] = [];
  private readonly syncDialogs = new Set<Window>();
  private structure = "";
  private paneID: string | false = false;
  private unsubscribe: (() => void) | undefined;
  private active = false;

  constructor(private readonly pluginID: string, private readonly rootURI: string, private readonly controller: KnowledgeLibraryController, private readonly parsing?: ParsingService,
    private readonly sync?: CollectionSyncService, private readonly tasks: ImportTaskSource | undefined = parsing, private readonly embeddings?: EmbeddingService) {}

  start(): void {
    if (this.active || !Zotero.ItemPaneManager || !Zotero.MenuManager || !Zotero.CollectionTreeRow || !Zotero.Search) return;
    this.active = true;
    this.paneID = Zotero.ItemPaneManager.registerSection({ paneID: "knowledge-info", pluginID: this.pluginID,
      header: { l10nID: "knowledgemcp-info-header", icon: `${this.rootURI}content/ui/knowledge.svg` },
      sidenav: { l10nID: "knowledgemcp-info-sidenav", icon: `${this.rootURI}content/ui/knowledge.svg` },
      onInit: props => {
        this.localize(props.doc);
        this.sections.set(props.body, { refresh: props.refresh });
      },
      onDestroy: props => {
        this.sections.delete(props.body);
        if (![...this.windows.keys()].some(window => window.document === props.doc)
          && ![...this.sections.keys()].some(body => body.ownerDocument === props.doc)) this.releaseDocument(props.doc);
      },
      onItemChange: props => {
        props.setEnabled(Boolean(props.item?.isRegularItem() || props.item?.isAttachment()));
      },
      onRender: props => this.renderSection(props)
    });
    if (!this.paneID) throw new Error("Knowledge item-pane registration failed.");
    this.unsubscribe = this.controller.subscribe(() => this.changed());
    this.registerMenus();
    for (const window of Zotero.getMainWindows?.() ?? []) this.loadWindow(window);
  }

  private localize(document: Document): void {
    if (this.documents.has(document)) return;
    (document as KnowledgeMainWindow["document"]).l10n?.addResourceIds(["knowledgemcp.ftl"]);
    const style = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    style.textContent = `${styles}\n.icon-km-knowledge { --km-knowledge-icon: url("${this.rootURI}content/ui/knowledge.svg"); }\n.icon-km-import-tasks { --km-import-tasks-icon: url("${this.rootURI}content/ui/import-tasks.svg"); }`;
    style.setAttribute("data-knowledgemcp", "knowledge-library");
    (document.head ?? document.documentElement).append(style);
    this.documents.set(document, style);
  }

  private releaseDocument(document: Document): void {
    const style = this.documents.get(document);
    if (!style) return;
    this.documents.delete(document);
    try { style?.remove(); } catch { /* The owning window may already be destroyed. */ }
    try { (document as KnowledgeMainWindow["document"]).l10n?.removeResourceIds(["knowledgemcp.ftl"]); } catch { /* Detached documents need no localization cleanup. */ }
  }

  loadWindow(window: Window, attempt = 0): void {
    const native = window as KnowledgeMainWindow;
    if (!this.active || native.closed || this.windows.has(native)) return;
    const previous = this.pending.get(native);
    if (previous) clearTimeout(previous);
    this.pending.delete(native);
    if (!native.ZoteroPane?.itemsView?.tree || !native.ZoteroPane.collectionsView?.tree) {
      if (attempt < 100) this.pending.set(native, setTimeout(() => { this.pending.delete(native); this.loadWindow(native, attempt + 1); }, 100));
      return;
    }
    this.localize(native.document);
    let tree: KnowledgeLibraryTree | undefined;
    let title: KnowledgeTitleStatus | undefined;
    let sync: CollectionSyncBadges | undefined;
    try {
      tree = new KnowledgeLibraryTree(native, this.controller,
        target => this.run(native, () => this.controller.remove(native.ZoteroPane.getSelectedItems().map(item => item.id), target)),
        (ids, target) => this.add(native, ids, target), this.tasks);
      title = new KnowledgeTitleStatus(native, this.controller);
      if (this.sync) sync = new CollectionSyncBadges(native, this.sync);
      this.windows.set(native, { tree, title, sync });
    } catch {
      try { this.cleanup([() => sync?.dispose(), () => title?.dispose(), () => tree?.dispose()]); }
      catch { Zotero.debug("[ZoteroKnowledgeMCP] Partial window cleanup needs retry."); }
      Zotero.debug("[ZoteroKnowledgeMCP] Native knowledge-list integration is unavailable; registered menus and item details remain available.");
    }
  }

  unloadWindow(window: Window): void {
    const native = window as KnowledgeMainWindow;
    const timer = this.pending.get(native);
    if (timer) clearTimeout(timer);
    this.pending.delete(native);
    const view = this.windows.get(native);
    this.windows.delete(native);
    this.cleanup([() => view?.sync?.dispose(), () => view?.title.dispose(), () => view?.tree.dispose(),
      () => this.releaseDocument(native.document)]);
  }

  private run(window: KnowledgeMainWindow, operation: () => Promise<unknown>): void {
    if (!this.active) return;
    void operation().catch(error => {
      if (this.active && !window.closed) window.alert(knowledgeErrorMessage(error));
    });
  }

  private async add(window: KnowledgeMainWindow, items: number[], target: KnowledgeTarget, batch?: { title: string; sourceCollection: string }): Promise<void> {
    const results = await this.controller.add(items, target);
    await this.parsing?.enqueue(results.filter(result => !result.error).map(result => result.itemID), target, batch);
    const errors = results.filter(result => result.error);
    if (errors.length && this.active && !window.closed) window.alert(`${t("admission-summary", { added: results.length - errors.length, failed: errors.length })}\n\n${errors.slice(0, 8).map(result => t("admission-item-error", { id: result.itemID, error: result.error! })).join("\n")}`);
  }

  private selectedTarget(context: NativeMenuContext): KnowledgeTarget | undefined { return this.windows.get(context.menuElem.ownerGlobal)?.tree.selectedTarget(); }

  private selectedItemTrashIDs(context: NativeMenuContext): string[] {
    return this.windows.get(context.menuElem.ownerGlobal)?.tree.selectedTrashIDs() ?? [];
  }

  private defaultTarget(): KnowledgeTarget {
    const library = this.controller.snapshot.libraries.find(row => row.isDefault) ?? this.controller.snapshot.libraries[0];
    if (!library) throw new Error("No active knowledge library is available.");
    return { libraryID: library.id, nodeID: null };
  }

  private deleteLibrary(context: NativeMenuContext): void {
    const target = this.selectedTarget(context);
    if (!target || target.nodeID) return;
    const library = this.controller.snapshot.libraries.find(row => row.id === target.libraryID);
    if (!library) return;
    const window = context.menuElem.ownerGlobal;
    const prompt = Services.prompt;
    const checked = { value: false };
    const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL + prompt.BUTTON_POS_1_DEFAULT;
    const result = prompt.confirmEx(window, t("delete-library-title"), t("delete-library-message", { name: library.name }),
      flags, t("delete-library-button"), null, null, t("delete-exclusive"), checked);
    if (result === 0) this.run(window, () => this.controller.deleteLibrary(library.id, checked.value));
  }

  private deleteFolder(context: NativeMenuContext): void {
    const target = this.selectedTarget(context);
    const folder = this.controller.snapshot.folders.find(row => row.id === target?.nodeID && row.libraryID === target.libraryID);
    if (!target?.nodeID || !folder) return;
    const window = context.menuElem.ownerGlobal;
    const prompt = Services.prompt;
    const flags = prompt.BUTTON_POS_0 * prompt.BUTTON_TITLE_IS_STRING + prompt.BUTTON_POS_1 * prompt.BUTTON_TITLE_CANCEL + prompt.BUTTON_POS_1_DEFAULT;
    const result = prompt.confirmEx(window, t("delete-folder-title"), t("delete-folder-message", { name: folder.name }),
      flags, t("delete-folder-button"), null, null, null, { value: false });
    if (result === 0) this.run(window, () => this.controller.deleteFolder(target));
  }

  private targetMenus(action: (context: NativeMenuContext, target: KnowledgeTarget) => void): NativeMenuEntry[] {
    const byLibrary = indexFolders(this.controller.snapshot.folders);
    const folders = (target: KnowledgeTarget, seen: Set<string>): NativeMenuEntry[] => (byLibrary.get(target.libraryID)?.get(target.nodeID) ?? [])
      .filter(folder => !seen.has(folder.id))
      .map(folder => { const child = { libraryID: target.libraryID, nodeID: folder.id }; return {
        menuType: "submenu", l10nID: "knowledgemcp-target", l10nArgs: JSON.stringify({ name: folder.name }),
        menus: [{ menuType: "menuitem", l10nID: "knowledgemcp-target-root", onCommand: (_event, context) => action(context, child) }, ...folders(child, new Set([...seen, folder.id]))]
      }; });
    return this.controller.snapshot.libraries.map(library => {
      const target = { libraryID: library.id, nodeID: null };
      return { menuType: "submenu", l10nID: "knowledgemcp-target", l10nArgs: JSON.stringify({ name: library.name }), menus: [
        { menuType: "menuitem", l10nID: "knowledgemcp-target-root", onCommand: (_event, context) => action(context, target) }, ...folders(target, new Set())
      ] };
    });
  }

  private registerMenus(): void {
    const signature = JSON.stringify([this.controller.snapshot.libraries, this.controller.snapshot.folders]);
    if (this.structure === signature) return;
    this.structure = signature;
    for (const key of this.menus) Zotero.MenuManager!.unregisterMenu(key);
    this.menus = [];
    const eligible = (_event: Event, context: NativeMenuContext) => {
      const window = context.menuElem.ownerGlobal;
      const rows = context.collectionTreeRows ?? window.ZoteroPane.getCollectionTreeRows();
      const items = context.items ?? window.ZoteroPane.getSelectedItems();
      context.setVisible(Boolean(this.controller.snapshot.libraries.length && !rows.some(isKnowledgeRow)
        && items.some(item => item.isRegularItem() || item.isAttachment())));
    };
    const add = (context: NativeMenuContext, target: KnowledgeTarget) => {
      const window = context.menuElem.ownerGlobal;
      this.run(window, () => this.add(window, (context.items ?? window.ZoteroPane.getSelectedItems()).map(item => item.id), target));
    };
    const itemMenus: NativeMenuEntry[] = [
      { menuType: "menuitem", l10nID: "knowledgemcp-parse-selected", onShowing: (_event, context) => {
        const items = context.items ?? context.menuElem.ownerGlobal.ZoteroPane.getSelectedItems();
        context.setVisible(Boolean(this.parsing && items.some(item => this.controller.snapshot.itemResources.has(item.id)) && !this.selectedItemTrashIDs(context).length));
      }, onCommand: (_event, context) => {
        const window = context.menuElem.ownerGlobal;
        this.run(window, () => this.parsing!.parse((context.items ?? window.ZoteroPane.getSelectedItems()).map(item => item.id), this.selectedTarget(context)));
      } },
      { menuType: "menuitem", l10nID: "knowledgemcp-restore-items", onShowing: (_event, context) => {
        context.setVisible(this.selectedItemTrashIDs(context).length > 0);
      }, onCommand: (_event, context) => {
        const window = context.menuElem.ownerGlobal;
        this.run(window, () => this.controller.restoreTrash(this.selectedItemTrashIDs(context)));
      } },
      { menuType: "menuitem", l10nID: "knowledgemcp-purge-items", onShowing: (_event, context) => {
        context.setVisible(this.selectedItemTrashIDs(context).length > 0);
      }, onCommand: (_event, context) => {
        const window = context.menuElem.ownerGlobal;
        this.run(window, () => confirmTrashPurge(window, this.controller, this.selectedItemTrashIDs(context)));
      } },
      { menuType: "menuitem", l10nID: "knowledgemcp-remove-library", onShowing: (_event, context) => {
        const window = context.menuElem.ownerGlobal;
        const libraries = this.windows.get(window)?.tree.selectedLibraryIDs() ?? [];
        context.setVisible(Boolean(libraries.length && (context.items ?? window.ZoteroPane.getSelectedItems()).length));
      }, onCommand: (_event, context) => {
        const window = context.menuElem.ownerGlobal;
        const libraries = this.windows.get(window)?.tree.selectedLibraryIDs() ?? [];
        if (libraries.length) this.run(window, () => this.controller.moveToTrash((context.items ?? window.ZoteroPane.getSelectedItems()).map(item => item.id), libraries));
      } },
      { menuType: "menuitem", l10nID: "knowledgemcp-add-default", onShowing: eligible, onCommand: (_event, context) => add(context, this.defaultTarget()) },
      { menuType: "submenu", l10nID: "knowledgemcp-add-to", onShowing: eligible, menus: this.targetMenus(add) }
    ];
    itemMenus.push({ menuType: "menuitem", l10nID: "knowledgemcp-remove-folder",
      onShowing: (_event, context) => { const target = this.selectedTarget(context); context.setVisible(Boolean(target?.nodeID)); },
      onCommand: (_event, context) => {
        const target = this.selectedTarget(context); const window = context.menuElem.ownerGlobal;
        if (target) this.run(window, () => this.controller.remove((context.items ?? window.ZoteroPane.getSelectedItems()).map(item => item.id), target));
      } });
    const collectionMenus: NativeMenuEntry[] = [
      { menuType: "menuitem", l10nID: "knowledgemcp-sync-settings", onShowing: (_event, context) => {
        const rows = context.collectionTreeRows ?? context.menuElem.ownerGlobal.ZoteroPane.getCollectionTreeRows();
        context.setVisible(Boolean(this.sync && rows.length && rows.every(row => canConfigureCollectionSync(this.sync!.snapshot(), row))));
      }, onCommand: (_event, context) => {
        const window = context.menuElem.ownerGlobal, rows = context.collectionTreeRows ?? window.ZoteroPane.getCollectionTreeRows();
        if (!this.sync || !rows.length || !rows.every(row => canConfigureCollectionSync(this.sync!.snapshot(), row))) return;
        const bindings = this.sync.snapshot().filter(binding => rows.some(row => bindingsForSyncRoot([binding], row).length));
        const options = { sync: this.sync!, snapshot: this.controller.snapshot, bindings,
          collectionIDs: rows.filter(row => row.isCollection()).flatMap(row => row.ref.id ? [row.ref.id] : []), defaultTarget: this.defaultTarget() };
        const native = window as typeof window & { openDialog(url: string, name: string, features: string, args: unknown): Window };
        const dialog = native.openDialog("chrome://knowledgemcp/content/sync-settings.xhtml", "", "chrome,centerscreen,resizable,dialog", { mount: (child: Window) => mountSyncSettings(child, options) });
        this.syncDialogs.add(dialog); dialog.addEventListener("unload", () => this.syncDialogs.delete(dialog), { once: true });
      } },
      { menuType: "menuitem", l10nID: "knowledgemcp-sync-location", onShowing: (_event, context) => {
        const rows = context.collectionTreeRows ?? context.menuElem.ownerGlobal.ZoteroPane.getCollectionTreeRows();
        const bindings = this.sync?.snapshot().filter(binding => rows.some(row => bindingsForSyncRoot([binding], row).length)) ?? [];
        context.setVisible(Boolean(bindings.length)); context.setEnabled(false);
        context.menuElem.setAttribute("data-l10n-args", JSON.stringify({ target: bindings.map(row => row.location).join("; ") }));
      } },
      { menuType: "menuitem", l10nID: "knowledgemcp-empty-trash", onShowing: (_event, context) => {
        context.setVisible(Boolean(context.collectionTreeRows?.some(isKnowledgeTrashRow))); context.setEnabled(this.controller.snapshot.trash.length > 0);
      }, onCommand: (_event, context) => {
        const window = context.menuElem.ownerGlobal;
        this.run(window, () => confirmTrashPurge(window, this.controller, this.controller.snapshot.trash.map(entry => entry.id)));
      } },
      { menuType: "menuitem", l10nID: "knowledgemcp-restore-trash", onShowing: (_event, context) => {
        context.setVisible(Boolean(context.collectionTreeRows?.some(isKnowledgeTrashRow))); context.setEnabled(this.controller.snapshot.trash.length > 0);
      }, onCommand: (_event, context) => {
        const window = context.menuElem.ownerGlobal;
        const ids = this.controller.snapshot.trash.map(entry => entry.id);
        this.run(window, () => this.controller.restoreTrash(ids));
      } },
      { menuType: "submenu", l10nID: "knowledgemcp-add-collection", onShowing: (_event, context) => context.setVisible(Boolean(this.controller.snapshot.libraries.length && context.collectionTreeRows?.length && context.collectionTreeRows.every(row => row.isCollection()))),
        menus: this.targetMenus((context, target) => {
          const window = context.menuElem.ownerGlobal;
          const ids = window.ZoteroPane.getSelectedCollections().flatMap(collection => collection.getChildItems(true, false));
          const name = context.collectionTreeRows?.map(row => row.getName()).join(", ") || t("parse-folder");
          this.run(window, () => this.add(window, ids, target, { title: name, sourceCollection: name }));
        }) },
      { menuType: "menuitem", l10nID: "knowledgemcp-new-library", onCommand: (_event, context) => {
        const window = context.menuElem.ownerGlobal; const name = window.prompt(t("new-library-name"), "");
        if (name !== null) this.run(window, async () => {
          const id = await this.controller.createLibrary(name);
          if (this.active) await this.windows.get(window)?.tree.select(`Kknowledgemcp:library:${id}`);
        });
      } },
      { menuType: "menuitem", l10nID: "knowledgemcp-new-folder", onShowing: (_event, context) => context.setVisible(Boolean(this.selectedTarget(context))),
        onCommand: (_event, context) => {
          const window = context.menuElem.ownerGlobal; const target = this.selectedTarget(context); const name = window.prompt(t("new-folder-name"), "");
          if (target && name !== null) this.run(window, async () => {
            const id = await this.controller.createFolder(name, target);
            if (this.active) await this.windows.get(window)?.tree.select(`Kknowledgemcp:folder:${id}`);
          });
        } },
      { menuType: "menuitem", l10nID: "knowledgemcp-delete-library", onShowing: (_event, context) => {
        const target = this.selectedTarget(context); context.setVisible(Boolean(target && !target.nodeID));
      }, onCommand: (_event, context) => this.deleteLibrary(context) },
      { menuType: "menuitem", l10nID: "knowledgemcp-delete-folder", onShowing: (_event, context) => context.setVisible(Boolean(this.selectedTarget(context)?.nodeID)),
        onCommand: (_event, context) => this.deleteFolder(context) },
      { menuType: "menuitem", l10nID: "knowledgemcp-refresh", onShowing: (_event, context) => context.setVisible(Boolean(context.collectionTreeRows?.some(isKnowledgeRow))),
        onCommand: (_event, context) => this.run(context.menuElem.ownerGlobal, () => this.controller.refresh()) }
    ];
    for (const [target, menus] of [["main/library/item", itemMenus], ["main/library/collection", collectionMenus]] as const) {
      const branded = menus.map(entry => entry.menuType === "separator" ? entry : { ...entry, icon: `${this.rootURI}content/ui/knowledge.svg` });
      const id = Zotero.MenuManager!.registerMenu({ menuID: `knowledge-${target}`, pluginID: this.pluginID, target, menus: branded });
      if (!id) throw new Error("Knowledge context-menu registration failed.");
      this.menus.push(id);
    }
  }

  private renderSection(props: NativeSectionProps): void {
    const { body, doc, item } = props;
    body.replaceChildren();
    if (!item) return;
    const snapshot = this.controller.snapshot;
    const { content, resourceID, indexStatus } = renderKnowledgeDetails(doc, snapshot, item);
    body.append(content);
    const resource = snapshot.resources.find(row => row.id === resourceID);
    if (resource && this.embeddings && indexStatus) {
      const embedding = this.embeddings;
      void Promise.all([
        embedding.repository.db.selectFrom("search_documents as d").innerJoin("resource_sources as s", "s.active_generation_id", "d.generation_id")
          .innerJoin("content_generations as g", "g.id", "d.generation_id").select("d.rowid").where("d.resource_id", "=", resource.id)
          .where("s.deleted_at", "is", null).whereRef("g.source_version", "=", "s.source_version").limit(1).executeTakeFirst(),
        embedding.profile ? embedding.repository.activeVectors(embedding.profile).where("s.resource_id", "=", resource.id).limit(1).executeTakeFirst() : Promise.resolve(undefined),
      ]).then(([fulltext, vector]) => {
        if (!this.active || !body.contains(indexStatus)) return;
        const states = [fulltext ? t("vector-channel-fulltext") : "", vector ? `${t("vector-channel-vector")}: ${t(`vector-status-${embedding.store.status}`)}` : ""].filter(Boolean);
        indexStatus.textContent = states.length ? states.join(" / ") : t("not-created");
      }).catch(() => { /* A detached pane cannot keep database ownership alive. */ });
    }
    const actions = doc.createElementNS("http://www.w3.org/1999/xhtml", "div"); actions.className = "km-knowledge-actions"; content.append(actions);
    const window = doc.defaultView as KnowledgeMainWindow | null;
    if (!window) return;
    const button = (label: string, action: () => void, disabled = false) => {
      const node = doc.createElementNS("http://www.w3.org/1999/xhtml", "button") as HTMLButtonElement; node.textContent = label; node.type = "button";
      node.addEventListener("click", () => { if (this.active) action(); }); actions.append(node);
      node.disabled = disabled;
    };
    if (!resource) button(t("add-default"), () => this.run(window, () => this.add(window, [item.id], this.defaultTarget())), !snapshot.libraries.length);
    if (resource && this.parsing) button(t("parse-selected"), () => this.run(window, () => this.parsing!.parse([item.id])));
    if (resource && this.embeddings) button(t("vector-enqueue"), () => this.run(window, () => this.embeddings!.enqueue([resource.id])), !this.embeddings.config.current.enabled);
    button(t("refresh-metadata"), () => this.run(window, () => this.controller.refresh()));
    if (resource) button(t("locate-original"), () => this.run(window, async () => {
      const main = (window.ZoteroPane ? window : Zotero.getMainWindows?.().find(candidate => !candidate.closed)) as KnowledgeMainWindow | undefined;
      if (!main?.ZoteroPane) throw new Error("Open a Zotero library window to locate the original item.");
      main.focus(); main.Zotero_Tabs.select("zotero-pane");
      if (resource.itemID) await main.ZoteroPane.selectItem(resource.itemID, { inLibraryRoot: true });
    }));
  }

  private changed(): void {
    if (!this.active) return;
    this.registerMenus();
    for (const [window, view] of this.windows) {
      view.title.refresh();
      this.run(window, () => view.tree.refresh());
    }
    for (const state of this.sections.values()) void state.refresh().catch(() => {});
  }

  dispose(): void {
    this.active = false;
    const actions: Array<() => void> = [...this.syncDialogs].map(dialog => () => { if (!dialog.closed) dialog.close(); });
    this.syncDialogs.clear();
    actions.push(() => { this.unsubscribe?.(); this.unsubscribe = undefined; });
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    actions.push(...[...this.windows.keys()].map(window => () => this.unloadWindow(window)));
    actions.push(() => { if (this.paneID) Zotero.ItemPaneManager?.unregisterSection(this.paneID); this.paneID = false; });
    for (const key of [...this.menus]) actions.push(() => {
      Zotero.MenuManager?.unregisterMenu(key); this.menus = this.menus.filter(menu => menu !== key);
    });
    for (const window of Zotero.getMainWindows?.() ?? []) for (const [id, target] of [["zotero-itemmenu", "main/library/item"], ["zotero-collectionmenu", "main/library/collection"]]) {
      actions.push(() => { const popup = window.document.getElementById(id); if (popup) Zotero.MenuManager?.updateMenuPopup(popup, target); });
    }
    actions.push(...[...this.documents.keys()].map(document => () => this.releaseDocument(document)));
    this.sections.clear();
    this.cleanup(actions);
  }

  private cleanup(actions: Array<() => void>): void {
    const errors: unknown[] = [];
    for (const action of actions) { try { action(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, "Knowledge UI cleanup failed.");
  }
}
