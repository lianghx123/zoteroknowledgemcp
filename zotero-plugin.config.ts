import { defineConfig } from "zotero-plugin-scaffold";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";

// Build-time only: no Git, filesystem or Node process dependency enters the plugin.
function buildIdentity() {
  let commit: string | null = null, dirty: boolean | null = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { /* Source archives have no Git checkout; the source fingerprint remains available. */ }
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) { hash.update(path); hash.update("\0"); hash.update(readFileSync(path)); hash.update("\0"); }
    }
  };
  visit("src"); visit("addon");
  for (const path of ["package.json", "zotero-plugin.config.ts"]) { hash.update(path); hash.update("\0"); hash.update(readFileSync(path)); }
  return { commit, dirty, sourceFingerprint: hash.digest("hex") };
}

export default defineConfig({
  // Keep project identity independent of the supported Zotero version.
  name: "Zotero Knowledge MCP",
  id: "zotero-knowledge-mcp@local.dev",
  namespace: "knowledgemcp",
  source: ["src", "addon"],
  build: {
    assets: ["addon/**/*.*", "addon/content/vector/LICENSE", "addon/content/vector/NOTICE"],
    // Preserve the manifest's explicit compatibility range.
    makeManifest: { enable: false },
    // Preserve the shared Fluent filename/IDs across all locale directories.
    fluent: {
      prefixLocaleFiles: false,
      prefixFluentMessages: false,
      dts: false,
    },
    prefs: { prefixPrefKeys: false, dts: false },
    esbuildOptions: [
      { entryPoints: ["src/worker/vector-worker/runtime.ts"], outfile: ".scaffold/build/addon/content/vector/worker.js", bundle: true, format: "iife", target: "firefox140", platform: "browser", define: { "import.meta.url": "'about:blank'" } },
      { entryPoints: ["src/ui/sync-settings-entry.ts"], outfile: ".scaffold/build/addon/content/sync-settings.js", bundle: true, format: "iife", target: "firefox140", platform: "browser" },
      {
        entryPoints: ["src/ui/settings-entry.ts"], outfile: ".scaffold/build/addon/content/settings.js", bundle: true,
        format: "iife", target: "firefox140", platform: "browser",
      },
      {
        entryPoints: ["src/index.ts"],
        outfile: ".scaffold/build/addon/content/main.js",
        bundle: true,
        format: "iife",
        globalName: "ZoteroKnowledgeMCP",
        target: "firefox140",
        platform: "browser",
        loader: { ".css": "text" },
        define: { __MCP_BUILD__: JSON.stringify(buildIdentity()) },
        sourcemap: process.env.NODE_ENV === "development" ? "inline" : false,
      },
    ],
  },
  server: {
    // Hot reload via Remote Debugging Protocol (not a profile proxy).
    asProxy: false,
    devtools: false,
    debugOutputFile: true,
    // Do not override Scaffold's default local HTTP port (23124).
  },
});
