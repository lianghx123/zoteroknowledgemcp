export class DisposableStore {
  private callbacks: Array<() => void> = [];
  private disposed = false;

  add(callback: () => void): void {
    if (this.disposed) callback();
    else this.callbacks.push(callback);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const callback of this.callbacks.splice(0).reverse()) {
      try { callback(); }
      catch (error) { Zotero.debug(`[ZoteroKnowledgeMCP] Cleanup failed: ${String(error)}`); }
    }
  }
}
