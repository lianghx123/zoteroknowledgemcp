import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { posix } from "node:path";
import { mockNativeFactory, MockNativeDatabase } from "./helpers/native-database.mjs";

const path = "./.scaffold/build/addon";
const manifest = JSON.parse(readFileSync(resolve(path, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const bootstrap = readFileSync(resolve(path, "bootstrap.js"), "utf8");
const bundle = readFileSync(resolve(path, "content/main.js"), "utf8");

test("plugin metadata and Zotero compatibility", () => {
  assert.equal(pkg.name, "zotero-knowledge-mcp");
  assert.equal(manifest.name, "Zotero Knowledge MCP");
  assert.equal(manifest.description, pkg.description);
  assert.equal(manifest.author, pkg.author.name);
  assert.equal(manifest.homepage_url, pkg.homepage);
  assert.equal(readFileSync(resolve(path, "content/licenses/project.txt"), "utf8"), readFileSync(resolve("LICENSE"), "utf8"));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.applications.zotero.id, "zotero-knowledge-mcp@local.dev");
  assert.equal(manifest.applications.zotero.strict_min_version, "10.0");
  assert.equal(manifest.applications.zotero.strict_max_version, "10.0.*");
  // Stable updates retain the feed URL already installed in the first preview.
  assert.equal(manifest.applications.zotero.update_url,
    "https://raw.githubusercontent.com/lianghx123/zoteroknowledgemcp/main/updates.json");
  const updates = JSON.parse(readFileSync(resolve("updates.json"), "utf8"));
  const advertised = updates.addons[manifest.applications.zotero.id].updates;
  assert.ok(Array.isArray(advertised));
  for (const update of advertised) {
    assert.match(update.version, /^\d+\.\d+\.\d+$/);
    assert.equal(update.update_link, `https://github.com/lianghx123/zoteroknowledgemcp/releases/download/v${update.version}/zotero-knowledge-mcp.xpi`);
    assert.match(update.update_hash, /^sha256:[a-f0-9]{64}$/);
    assert.ok(update.applications.zotero.strict_min_version);
    assert.ok(update.applications.zotero.strict_max_version);
  }
  for (const icon of Object.values(manifest.icons)) {
    assert.match(readFileSync(resolve(path, icon), "utf8"), /<svg\b/);
  }
});

test("bootstrap loads TypeScript entry and releases it on shutdown", async () => {
  const logs = [];
  const sandbox = createContext({
    Uint8Array,
    Zotero: { debug: message => logs.push(message), DataDirectory: { dir: "/isolated" }, ...mockNativeFactory() },
    PathUtils: { join: posix.join },
    IOUtils: { async makeDirectory() {} },
  });
  let chromeRegistrations = 0;
  sandbox.Cc = { "@mozilla.org/addons/addon-manager-startup;1": { getService: () => ({ registerChrome: () => { chromeRegistrations++; return { destruct() { chromeRegistrations--; } }; } }) } };
  sandbox.Ci = { amIAddonManagerStartup: {} };
  sandbox.Services = {
    io: { newURI: uri => uri, getProtocolHandler: () => ({ QueryInterface() { return this; }, setSubstitution() {} }) },
    scriptloader: {
      loadSubScript(uri) {
        assert.equal(uri, "file:///dev/content/main.js");
        runInContext(bundle, sandbox);
      },
    },
  };
  runInContext(bootstrap, sandbox);

  assert.equal(typeof sandbox.install, "function");
  assert.equal(typeof sandbox.uninstall, "function");
  await sandbox.install({ id: manifest.applications.zotero.id }, 5);
  await sandbox.startup({
    id: manifest.applications.zotero.id,
    version: pkg.version,
    rootURI: "file:///dev/",
  });
  assert.equal(typeof sandbox.ZoteroKnowledgeMCP.startup, "function");
  sandbox.onMainWindowLoad({ window: {} });
  sandbox.onMainWindowUnload({ window: {} });
  await sandbox.shutdown();
  await sandbox.uninstall({ id: manifest.applications.zotero.id }, 6);

  assert.deepEqual(logs, [
    `[ZoteroKnowledgeMCP] started, version ${pkg.version}`,
    "[ZoteroKnowledgeMCP] stopped",
  ]);
  assert.equal(sandbox.ZoteroKnowledgeMCP, undefined);
  assert.equal(chromeRegistrations, 0);
});

test("failed database readiness releases ownership and can restart without registering duplicate UI", async () => {
  const listeners = new Set();
  const instances = [];
  let fail = true;
  const sandbox = createContext({ Uint8Array,
    Zotero: {
      debug() {}, DataDirectory: { dir: "/isolated" },
      DBConnection: class extends MockNativeDatabase {
        constructor() { super(":memory:", { fail: sql => fail && sql.startsWith("CREATE TABLE plugin_state") }); instances.push(this); }
      },
      Reader: { _readers: [], registerEventListener(_type, fn) { listeners.add(fn); }, unregisterEventListener(_type, fn) { listeners.delete(fn); } },
    },
    PathUtils: { join: posix.join }, IOUtils: { async makeDirectory() {} },
  });
  runInContext(bundle, sandbox);
  const api = sandbox.ZoteroKnowledgeMCP;
  const context = { id: "test", version: "test", rootURI: "file:///test/" };
  await assert.rejects(() => api.startup(context), /Injected/);
  assert.equal(instances[0].closed, true);
  assert.equal(instances[1].closed, true);
  assert.equal(sandbox.Zotero.__knowledgeMCPDatabaseOwners.size, 0);
  assert.equal(listeners.size, 0);
  fail = false;
  await api.startup(context);
  assert.equal(listeners.size, 1);
  await api.shutdown();
  assert.equal(listeners.size, 0);
  assert.ok(instances.every(instance => instance.closed));
  assert.equal(sandbox.Zotero.__knowledgeMCPDatabaseOwners.size, 0);
});

test("shutdown requested during asynchronous startup waits and then closes database ownership", async () => {
  const factory = mockNativeFactory();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const sandbox = createContext({ Uint8Array,
    Zotero: { debug() {}, DataDirectory: { dir: "/isolated" }, ...factory },
    PathUtils: { join: posix.join }, IOUtils: { async makeDirectory() { await gate; } },
  });
  runInContext(bundle, sandbox);
  const api = sandbox.ZoteroKnowledgeMCP;
  const starting = api.startup({ id: "test", version: "test", rootURI: "file:///test/" });
  const stopping = api.shutdown();
  release();
  await Promise.all([starting, stopping]);
  assert.equal(factory.instances.length, 2);
  assert.ok(factory.instances.every(instance => instance.closed));
  assert.equal(sandbox.Zotero.__knowledgeMCPDatabaseOwners.size, 0);
});

for (const failingRole of ["main", "owner"]) {
  test(`application retains its database after a ${failingRole} close failure and can restart`, async () => {
    const instances = [];
    const listeners = new Set();
    let fail = true;
    const sandbox = createContext({ Uint8Array,
      Zotero: { debug() {}, DataDirectory: { dir: "/isolated" },
        DBConnection: class extends MockNativeDatabase {
          constructor(file) { super(); this.role = file.endsWith(".owner.sqlite") ? "owner" : "main"; this.closeCalls = 0; instances.push(this); }
          async closeDatabase() { this.closeCalls++; if (this.role === failingRole && fail) throw new Error("Transient close failure"); await super.closeDatabase(); }
        },
        Reader: { _readers: [], registerEventListener(_type, fn) { listeners.add(fn); }, unregisterEventListener(_type, fn) { listeners.delete(fn); } },
      }, PathUtils: { join: posix.join }, IOUtils: { async makeDirectory() {} },
    });
    runInContext(bundle, sandbox);
    const api = sandbox.ZoteroKnowledgeMCP;
    const context = { id: "test", version: "test", rootURI: "file:///test/" };
    try {
      await api.startup(context);
      await assert.rejects(api.shutdown(), /Transient close failure/);
      assert.equal(listeners.size, 0); assert.equal(sandbox.Zotero.__knowledgeMCPDatabaseOwners.size, 1);
      fail = false;
      await api.startup(context);
      assert.equal(instances.length, 4); assert.equal(listeners.size, 1);
      assert.ok(instances.slice(0, 2).every(instance => instance.closed));
      assert.equal(instances.find(instance => instance.role === failingRole).closeCalls, 2);
      await api.shutdown(); assert.equal(listeners.size, 0); assert.equal(sandbox.Zotero.__knowledgeMCPDatabaseOwners.size, 0);
      assert.ok(instances.every(instance => instance.closed));
    } finally { fail = false; await api.shutdown(); }
  });
}
