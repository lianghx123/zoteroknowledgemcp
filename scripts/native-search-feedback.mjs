// Observe complete busy transitions, including searches that finish between polls.
export function submitFulltextSearch(window, quick, query, timeoutMs = 20000) {
  const input = quick.searchTextbox;
  if (input.getAttribute("aria-busy") === "true") return Promise.reject(new Error("search-already-running"));
  return new Promise((resolve, reject) => {
    let started = false, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      observer.disconnect(); window.clearTimeout(timer); window.removeEventListener("unload", unloaded);
      if (error) reject(error);
      else resolve({ feedback: input.getAttribute("aria-description") ?? "" });
    };
    const unloaded = () => finish(new Error("search-window-closed"));
    const observer = new window.MutationObserver(records => {
      started ||= input.getAttribute("aria-busy") === "true" || records.some(record => record.oldValue === "true");
      if (started && input.getAttribute("aria-busy") !== "true") finish();
    });
    const timer = window.setTimeout(() => finish(new Error("search-feedback-timeout")), timeoutMs);
    observer.observe(input, { attributes: true, attributeFilter: ["aria-busy"], attributeOldValue: true });
    window.addEventListener("unload", unloaded, { once: true });
    try {
      input.value = query;
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, cancelable: true }));
    } catch (error) { finish(error); }
  });
}
