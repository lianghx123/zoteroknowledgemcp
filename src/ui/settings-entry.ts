import { mountSettings } from "./settings";

// Zotero loads pane scripts before inserting the XHTML fragment.
let cleanup: (() => void) | undefined, closed = false;
let mountedHost: HTMLElement | undefined;
const observer = new MutationObserver(() => {
  if (mountedHost) {
    if (!mountedHost.isConnected) { closed = true; observer.disconnect(); cleanup?.(); cleanup = undefined; }
    return;
  }
  const host = document.getElementById("km-settings");
  if (!host) return;
  mountedHost = host;
  void mountSettings(host).then(dispose => { if (closed) dispose(); else cleanup = dispose; }).catch(() => {
    Zotero.debug("[ZoteroKnowledgeMCP] Settings initialization failed.");
  });
});
observer.observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("unload", () => { closed = true; observer.disconnect(); cleanup?.(); }, { once: true });
