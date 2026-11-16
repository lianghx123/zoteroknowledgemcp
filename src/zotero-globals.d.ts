// Zotero API declarations used by Zotero Knowledge MCP.
// Replace/extend with zotero-types as Zotero APIs are introduced.

/** Gecko's native synchronous Fluent formatter, also available in plugin globals. */
declare class Localization {
  constructor(resourceIDs: string[], sync: boolean);
  formatMessagesSync(messages: Array<{ id: string; args?: Record<string, string | number> }>): Array<{
    value: string | null;
    attributes: Array<{ name: string; value: string }> | null;
  } | null>;
}

declare const Services: {
  logins: {
    findLogins(origin: string, form: string | null, realm: string): ModelLogin[];
    addLoginAsync(login: ModelLogin): Promise<ModelLogin>;
    modifyLogin(oldLogin: ModelLogin, newLogin: ModelLogin): void;
    removeLogin(login: ModelLogin): void;
  };
  scriptloader: { loadSubScript(url: string, target: Window): void };
  prompt: {
    BUTTON_POS_0: number; BUTTON_POS_1: number; BUTTON_POS_2: number; BUTTON_POS_2_DEFAULT: number; BUTTON_TITLE_IS_STRING: number; BUTTON_TITLE_CANCEL: number; BUTTON_POS_1_DEFAULT: number;
    confirmEx(parent: Window | null, title: string, message: string, flags: number, button0: string, button1: string | null,
      button2: string | null, checkLabel: string | null, checkState: { value: boolean }): number;
  };
};
interface ModelLogin { username: string; password: string; init(origin: string, form: null, realm: string, username: string, password: string, usernameField: string, passwordField: string): void; }
declare const ChromeUtils: {
  importESModule(uri: "resource://gre/modules/LoginInfo.sys.mjs"): { nsLoginInfo: new () => ModelLogin };
  importESModule(uri: "resource://gre/modules/Timer.sys.mjs"): { setTimeout(callback: () => void, delay: number): number; clearTimeout(id: number): void };
  importESModule(uri: "chrome://remote/content/server/httpd.sys.mjs"): { HttpServer: new () => import("./connections/mcp-http").NativeHttpServer };
  importESModule(uri: "resource://gre/modules/NetUtil.sys.mjs"): { NetUtil: { readInputStreamToString(stream: unknown, count: number): string } };
};
declare const Components: { utils: {
  getGlobalForObject(object: object): typeof globalThis;
  cloneInto<T>(value: T, targetScope: object): T;
} };
declare const ChromeWorker: new (url: string) => {
  onmessage: ((event: MessageEvent<{ id: number; value: unknown; error?: string }>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(value: unknown, transfer?: Transferable[]): void; terminate(): void;
};
interface NativeHash { SHA256: number; init(kind: number): void; update(bytes: Uint8Array, length: number): void; finish(ascii: boolean): string; }
declare const Cc: { "@mozilla.org/security/hash;1": { createInstance(type: unknown): NativeHash } };
declare const Ci: { nsICryptoHash: unknown };
declare const Zotero: {
  closing?: boolean;
  uiReadyPromise?: Promise<void>;
  debug(message: string): void;
  Prefs?: {
    get(name: string, global?: boolean): unknown;
    set(name: string, value: string, global?: boolean): void;
  };
  DataDirectory: { dir: string };
  Utilities?: { Internal: { openPreferences(paneID?: string): void } };
  PreferencePanes?: {
    register(options: { pluginID: string; id: string; src: string; label: string; image: string; scripts: string[]; stylesheets?: string[] }): Promise<string>;
    unregister(id: string): void;
  };
  /** Independent native SQLite connection, inspected in Zotero 10.0.6 xpcom/db.js. */
  DBConnection: new (absolutePath: string) => import("./database/zotero-driver").NativeDatabase;
  /** Only used to release owned temporary native search tables, not plugin storage. */
  DB?: { queryAsync(sql: string, parameters: false, options: { noCache: true }): Promise<unknown> };
  isWin: boolean;
  /** Plugin-owned registry shared by bundle globals in the same Zotero process. */
  __knowledgeMCPDatabaseOwners?: Map<string, { retryClose?: () => Promise<void> }>;
  __knowledgeMCPConfigWrites?: Map<string, Promise<void>>;
  __knowledgeMCPAccess?: import("./services/mcp").McpService;
  __knowledgeMCPRetrieval?: {
    clear(config: import("./shared/contracts/retrieval").RetrievalConfig, publish?: () => Promise<void>): Promise<void>;
    rebuild(): Promise<void>; enqueueAll(): Promise<void>; status(): string;
    startup?(): import("./services/startup-recovery").RecoverySnapshot;
    retryStartup?(): void;
    configuration?(): { revision: number; error: boolean };
  };
  Items: {
    get(id: number): ZoteroItem | false;
    getAsync?(id: number): Promise<ZoteroItem | false>;
    getByLibraryAndKeyAsync?(libraryID: number, key: string): Promise<ZoteroItem | false>;
  };
  Collection?: new () => import("./ui/knowledge/native-types").NativeCollectionObject;
  Collections?: {
    get(id: number): ZoteroCollection | false;
    getByLibraryAndKeyAsync(libraryID: number, key: string): Promise<ZoteroCollection | false>;
  };
  getMainWindows?(): import("./ui/knowledge/native-types").KnowledgeMainWindow[];
  Libraries?: {
    userLibraryID: number;
    get(id: number): { libraryID: number; libraryType: string; name: string; editable: boolean; filesEditable: boolean;
      getDataLoaded(type: string): boolean; waitForDataLoad(type: string): Promise<void> } | false;
  };
  Users?: { getCurrentUserID(): number | null | false };
  Groups?: { getGroupIDFromLibraryID(id: number): number };
  DragDrop?: {
    currentOrientation: number;
    currentDropEffect: string | null;
    currentDragSource: import("./ui/knowledge/native-types").NativeCollectionRow | null;
    getDragSource(transfer?: DataTransfer): import("./ui/knowledge/native-types").NativeCollectionRow | null;
    getDataFromDataTransfer(transfer: DataTransfer): { dataType: string; data: unknown[] } | false;
  };
  ItemFields?: { getItemTypeFields(type: number): number[]; getName(id: number): string };
  CreatorTypes?: { getName(id: number): string };
  Search?: {
    new (): import("./ui/knowledge/native-types").NativeSearch;
    idsToTempTable(ids: number[], options?: { idColumn: "id" | "itemID" }): Promise<string>;
  };
  CollectionTreeRow?: new (view: import("./ui/knowledge/native-types").NativeCollectionView, type: string,
    ref: { libraryID: number; name: string; treeViewID: string }, level?: number, open?: boolean) => import("./ui/knowledge/native-types").NativeCollectionRow;
  Notifier?: {
    registerObserver(observer: { notify(action: string, type: string, ids: Array<number | string>): void }, types: string[], name: string, priority?: number): string;
    unregisterObserver(id: string): void;
  };
  ItemPaneManager?: {
    registerSection(options: { paneID: string; pluginID: string; header: { l10nID: string; icon: string };
      sidenav: { l10nID: string; icon: string }; onInit?(props: import("./ui/knowledge/native-types").NativeSectionProps): void;
      onDestroy?(props: import("./ui/knowledge/native-types").NativeSectionProps): void;
      onItemChange?(props: import("./ui/knowledge/native-types").NativeSectionProps): void;
      onRender(props: import("./ui/knowledge/native-types").NativeSectionProps): void }): string | false;
    unregisterSection(id: string): boolean;
  };
  MenuManager?: {
    registerMenu(options: { menuID: string; pluginID: string; target: string; menus: import("./ui/knowledge/native-types").NativeMenuEntry[] }): string | false;
    unregisterMenu(id: string): boolean;
    updateMenuPopup(popup: Element, target: string, options?: object): void;
  };
  launchURL(url: string): void;
  File: { reveal(path: string): void };
  Reader?: {
    open(itemID: number, location?: { pageIndex: number }): Promise<unknown>;
    registerEventListener(type: "renderToolbar", handler: (event: ZoteroReaderEvent) => void, pluginID: string): void;
    unregisterEventListener(type: "renderToolbar", handler: (event: ZoteroReaderEvent) => void): void;
    /** Internal reader list inspected in Zotero 10.0.6; isolate use to UI registration. */
    _readers: ZoteroReader[];
  };
};

interface ZoteroAttachment {
  id: number;
  key: string;
  libraryID: number;
  attachmentReaderType: string | false;
}

interface ZoteroCollection {
  id: number;
  key: string;
  libraryID: number;
  name: string;
  deleted: boolean;
  parentID: number | false;
  getChildItems(asIDs: true, includeTrashed?: boolean): number[];
  getChildCollections(asIDs: true): number[];
}

interface ZoteroItem extends ZoteroAttachment {
  itemTypeID: number;
  itemType: string;
  version: number;
  deleted: boolean;
  parentItemID: number | false;
  attachmentContentType: string;
  attachmentLinkMode: number;
  getField(name: string): string | number;
  getCreators(): Array<{ creatorTypeID: number; firstName: string; lastName: string; fieldMode: number }>;
  getTags(): Array<{ tag: string; type?: number }>;
  getAttachments(includeTrashed?: boolean): number[];
  isRegularItem(): boolean;
  isAttachment(): boolean;
  isNote(): boolean;
  isAnnotation(): boolean;
  getFilePathAsync(): Promise<string | false>;
}

interface ZoteroReaderPageStats { pageIndex?: number; pagesCount?: number; }
interface ZoteroReaderPDFView {
  _iframeWindow?: { PDFViewerApplication?: { pdfDocument?: { numPages?: number; getProcessedData(): Promise<unknown> } } };
}

interface ZoteroReader {
  itemID: number;
  /** Internal hooks inspected in Zotero 10.0.6; recheck on compatibility changes. */
  _type: string;
  _window?: Window;
  /** Native PDF menu host, inspected in Zotero 10.0.7. */
  _popupset?: Element;
  _iframeWindow?: Window;
  _initPromise?: Promise<void>;
  /** Public navigation clones arguments into the reader's content compartment. */
  navigate?(location: { pageIndex: number }): Promise<void>;
  /** Read-only native citation evidence; inspected in Zotero 10.0.7. */
  _internalReader?: {
    _primaryView?: ZoteroReaderPDFView;
    _secondaryView?: ZoteroReaderPDFView;
    _lastView?: ZoteroReaderPDFView;
    /** Live physical-page stats; the view's initial saved state is not current. */
    _state?: { primaryViewStats?: ZoteroReaderPageStats; secondaryViewStats?: ZoteroReaderPageStats };
  };
}

interface ZoteroReaderEvent {
  reader: ZoteroReader;
  doc: Document;
  params: Record<string, unknown>;
  append(...elements: Element[]): void;
}

declare const PathUtils: {
  join(...parts: string[]): string;
  parent(path: string): string;
};

declare const IOUtils: {
  exists(path: string): Promise<boolean>;
  getChildren(path: string): Promise<string[]>;
  stat(path: string): Promise<{ size: number }>;
  readUTF8(path: string): Promise<string>;
  read(path: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array, options?: { tmpPath?: string; mode?: "append"; flush?: boolean }): Promise<number>;
  move(source: string, target: string, options?: { noOverwrite?: boolean }): Promise<void>;
  remove(path: string, options?: { ignoreAbsent?: boolean; recursive?: boolean }): Promise<void>;
  writeUTF8(path: string, contents: string, options?: { tmpPath?: string }): Promise<number>;
  makeDirectory(path: string, options?: { ignoreExisting?: boolean }): Promise<void>;
};
