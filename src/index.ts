/** Zotero Knowledge MCP entry point for the literature knowledge base and MCP integration. */

import { PluginApplication, type PluginContext } from "./app/plugin";
export type { PluginContext } from "./app/plugin";

let application: PluginApplication | undefined;
let lifecycle: Promise<void> = Promise.resolve();

function schedule(operation: () => Promise<void>): Promise<void> {
  const pending = lifecycle.then(operation);
  lifecycle = pending.catch(() => {});
  return pending;
}

export async function startup(context: PluginContext): Promise<void> {
  return schedule(async () => {
    await application?.dispose();
    application = new PluginApplication(context);
    try { await application.start(); }
    catch (error) { await application.dispose(); application = undefined; throw error; }
    Zotero.debug(`[ZoteroKnowledgeMCP] started, version ${context.version}`);
  });
}

export function onMainWindowLoad(window: Window): void {
  application?.loadWindow(window);
}

export function onMainWindowUnload(window: Window): void {
  application?.unloadWindow(window);
}

export async function shutdown(): Promise<void> {
  return schedule(async () => {
    await application?.dispose();
    application = undefined;
    Zotero.debug("[ZoteroKnowledgeMCP] stopped");
  });
}
