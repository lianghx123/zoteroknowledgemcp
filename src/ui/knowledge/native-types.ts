export interface NativeSearch {
  libraryID: number | null;
  addCondition(name: string, operator: string, value?: string | number): number;
  setScope(search: NativeSearch, includeChildren?: boolean): void;
  search(): Promise<number[]>;
  clone(libraryID?: number): NativeSearch;
}

export interface NativeCollectionRow {
  id: string;
  type: string;
  level: number;
  isOpen: boolean;
  ref: { libraryID: number; id?: number; key?: string; name?: string; getChildItems?(asIDs?: boolean, includeTrashed?: boolean): ZoteroItem[] | number[] };
  editable: boolean;
  filesEditable: boolean;
  searchText: string;
  searchMode: string;
  knowledgeRetrieval?: boolean;
  tags: Set<string>;
  advancedSearch?: NativeSearch | null;
  isContainer(): boolean;
  isCollection(): boolean;
  isLibrary(includeGroup?: boolean): boolean;
  isTrash(): boolean;
  getName(): string;
  getItems(options?: { unfiltered?: boolean }): Promise<NativeListObject[]>;
  getSearchResults(asTempTable?: boolean, options?: { unfiltered?: boolean }): Promise<number[] | string>;
  getSearchObject(options?: { unfiltered?: boolean }): Promise<NativeSearch>;
  setAdvancedSearch(search: NativeSearch | null): void;
  clearCache(): void;
}

export interface NativeCollectionObject {
  readonly id: number | string | false;
  readonly treeViewID: string;
  libraryID: number;
  name: string;
  deleted: boolean;
  isRegularItem(): boolean;
  isAttachment(): boolean;
  isNote(): boolean;
  isAnnotation(): boolean;
}

/** Unsaved native collection reference used only to render a knowledge Trash row. */
export interface KnowledgeTrashObject extends NativeCollectionObject {
  readonly id: string;
  readonly knowledgeTrashID: string;
  readonly knowledgeTrashKind: "item" | "folder" | "library";
  readonly knowledgeTrashResourceID?: string;
}

export type NativeListObject = ZoteroItem | KnowledgeTrashObject;

export interface NativeItemRow {
  id?: number | string;
  type?: string;
  isOpen?: boolean;
  level?: number;
  isObjectRow: boolean;
  ref: NativeListObject;
  getTypeLabel?(): string;
  getIcon?(): Element;
  isContainer?(): boolean;
  isContainerEmpty?(): boolean;
  getChildItems?(options?: unknown): NativeListObject[];
  renderRow?(div: HTMLElement, ...args: unknown[]): void;
}

export interface NativeTreeSelection {
  selected: Set<number>;
  focused: number;
  pivot: number;
  selectEventsSuppressed: boolean;
  select(index: number): void;
}

export interface NativeCollectionView {
  _expandRowOnHoverTimer?: ReturnType<typeof setTimeout>;
  _expandedRowsOnDrag?: Set<string>;
  _dropRow: number | null;
  _flashingRow: number | null;
  _rows: NativeCollectionRow[];
  selection: NativeTreeSelection;
  tree: { invalidate(): void };
  forceUpdate(callback?: () => void): void;
  refresh(): Promise<void>;
  reload(): Promise<void>;
  _refreshRowMap(): void;
  getSelectedRows(): NativeCollectionRow[];
  getRow(index: number): NativeCollectionRow;
  getIconName(index: number): string;
  isContainerEmpty(index: number): boolean;
  toggleOpenState(index: number): Promise<void>;
  selectWait(index: number): Promise<void>;
  selectByID(id: string): Promise<boolean>;
  canDropCheck(...args: unknown[]): boolean;
  canDropCheckAsync(...args: unknown[]): Promise<boolean>;
  onDragStart(event: NativeDropEvent, index: number): void;
  onDragEnd(event: NativeDropEvent, index?: number): void;
  onDrop(...args: unknown[]): Promise<void>;
  onDragOver(event: NativeDropEvent, index: number): unknown;
  setDropEffect(event: NativeDropEvent, effect: "copy" | "move" | "none"): void;
}

export interface NativeDropEvent {
  dataTransfer: DataTransfer;
  preventDefault(): void;
  stopPropagation(): void;
}

export interface NativeWindowedList {
  itemHeight: number;
  scrollOffset: number;
  innerElem: HTMLElement;
  _renderedRows: Map<number, HTMLElement>;
  _getItemPosition(index: number): number;
  getItemCount(): number;
  getWindowHeight(): number;
  getFirstVisibleRow(): number;
  getLastVisibleRow(): number;
  render(): void;
}

export interface NativeItemsView {
  readonly id?: string;
  _dropRow: number | null;
  _rows: NativeItemRow[];
  collectionTreeRows: NativeCollectionRow[];
  tree: { invalidate(): void; invalidateRow(index: number): void; updateCustomRowHeights?(heights: Array<[number, number]>): unknown; _getWindowedListOptions?(): object;
    _jsWindow?: NativeWindowedList };
  isSelectable?(index: number, selectAll?: boolean): boolean;
  _renderItem?(index: number, selection: unknown, oldDiv?: HTMLElement | null, columns?: unknown[]): HTMLElement;
  _renderCell(index: number, data: unknown, column: { dataKey: string }, first: boolean): Element;
  getRow(index: number): NativeItemRow;
  getSelectedObjects?(): NativeListObject[];
  rowProvider?: { createRow(ref: NativeListObject, level: number, open: boolean): NativeItemRow; _sort(itemIDs?: number[]): void; toggleOpenState?(index: number, skipRowMapRefresh?: boolean): void; _toggleOpenState?(index: number, skipRowMapRefresh?: boolean): void; _rows: NativeItemRow[]; refreshRowMap(): void };
  setFilter(type: string, value: string): Promise<void>;
  sort(itemIDs?: number[]): Promise<void>;
  _handleColumnSort(...args: unknown[]): unknown;
  selectItems(ids: number[]): Promise<void>;
  refreshAndMaintainSelection(): Promise<void>;
  canDropCheck(...args: unknown[]): boolean;
  onDrop(...args: unknown[]): Promise<void>;
  onDragOver(event: NativeDropEvent, index: number): unknown;
  setDropEffect(event: NativeDropEvent, effect: "copy" | "move" | "none"): void;
}

export interface KnowledgeMainWindow extends Window {
  require?(id: "components/icons"): { getCSSIcon(name: string): Element; getCSSItemTypeIcon(name: string): Element };
  document: Document & { createXULElement?(name: string): Element; l10n?: { addResourceIds(ids: string[]): void; removeResourceIds(ids: string[]): void } };
  ZoteroPane: {
    collectionsView: NativeCollectionView;
    itemsView: NativeItemsView;
    getSelectedItems(): ZoteroItem[];
    selectItem(itemID: number, options?: { inLibraryRoot?: boolean }): Promise<boolean>;
    getCollectionTreeRows(): NativeCollectionRow[];
    getSelectedCollections(): Array<{ id: number; getChildItems(asIDs: true, includeTrashed?: boolean): number[] }>;
    deleteSelectedItems(...args: unknown[]): Promise<void>;
    onCollectionSelected(): Promise<void>;
    search(runAdvanced?: boolean): Promise<void>;
    deleteSelectedCollection(...args: unknown[]): Promise<void>;
    editSelectedCollection(...args: unknown[]): Promise<void>;
    itemPane?: {
      data: NativeListObject[];
      updateItemPaneButtons(): void;
      getCurrentPane(): { renderCustomHead(render?: (props: { doc: Document & { createXULElement(name: string): Element }; append(element: Element): void }) => void): void };
    };
  };
  Zotero_Tabs: { select(id: string): void };
}

export interface NativeMenuContext {
  menuElem: Element & { ownerGlobal: KnowledgeMainWindow };
  items?: ZoteroItem[];
  collectionTreeRows?: NativeCollectionRow[];
  setEnabled(enabled: boolean): void;
  setVisible(visible: boolean): void;
}

export interface NativeMenuEntry {
  menuType: "menuitem" | "submenu" | "separator";
  l10nID?: string;
  l10nArgs?: string;
  icon?: string;
  menus?: NativeMenuEntry[];
  onShowing?(event: Event, context: NativeMenuContext): void;
  onCommand?(event: Event, context: NativeMenuContext): void;
}

export interface NativeSectionProps {
  body: HTMLElement;
  doc: Document;
  item: ZoteroItem | null;
  paneID: string;
  setEnabled(enabled: boolean): void;
  refresh(): Promise<void>;
}
