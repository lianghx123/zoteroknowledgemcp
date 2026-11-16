Services.scriptloader.loadSubScript("chrome://zotero/content/include.js", window);
Services.scriptloader.loadSubScript("chrome://zotero/content/customElements.js", window);

// Native dialog bootstrap; state and behavior remain in the owning application.
window.addEventListener("load", () => {
  (window as unknown as Window & { arguments: [{ mount(window: Window): void }] }).arguments[0].mount(window);
}, { once: true });
