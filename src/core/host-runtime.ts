/** Shared lifecycle values must outlive plugin scopes and main windows. */
export function hostRuntime(): typeof globalThis {
  if (typeof Components !== "undefined") {
    const timer = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    return Components.utils.getGlobalForObject(timer.setTimeout);
  }
  return globalThis;
}

/** Timer module exports remain callable when the last DOM window is gone. */
export function hostSetTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  return typeof Components === "undefined" ? globalThis.setTimeout(callback, delay)
    : ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(callback, delay);
}
export function hostClearTimeout(id: ReturnType<typeof setTimeout> | undefined): void {
  if (id === undefined) return;
  if (typeof Components === "undefined") globalThis.clearTimeout(id);
  else ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").clearTimeout(id);
}
