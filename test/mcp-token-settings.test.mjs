import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { parsingFixture } from "./fixtures/parsing.mjs";

const compiled = await build({ stdin: { contents: 'export * from "./src/ui/mcp-settings.ts"; export * from "./src/security/mcp-tokens.ts";', resolveDir: process.cwd(), loader: "ts" }, bundle: true, platform: "browser", format: "esm", target: "firefox140", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const f = await parsingFixture(t), tokens = new api.McpTokens(f.db);
  const firstLibrary = f.target.libraryID, secondLibrary = await f.repo.create("Second library");
  const first = await tokens.create({ name: "Reader <img>", libraryIds: [firstLibrary], scopes: ["knowledge:read"], expiresInDays: 30 });
  const second = await tokens.create({ name: "Research client", libraryIds: [firstLibrary, secondLibrary], scopes: ["knowledge:search", "knowledge:read"], expiresInDays: 90 });
  const service = {
    snapshot: () => ({ enabled: false, port: 23126, endpoint: "http://127.0.0.1:23126/mcp/knowledge", status: "stopped", error: "" }),
    listTokens: () => tokens.list(), libraries: async () => [{ id: firstLibrary, name: "First library" }, { id: secondLibrary, name: "Second library" }],
    createToken: input => tokens.create(input), updateToken: (id, input) => tokens.update(id, input), revokeToken: id => tokens.revoke(id),
  };
  Zotero.__knowledgeMCPAccess = service;
  const dom = new JSDOM('<section id="km-settings"></section>'), host = dom.window.document.querySelector("section");
  let dispose;
  t.after(() => { dispose?.(); dom.window.close(); });
  const mount = async () => { dispose = await api.mountMcpSettings(host); };
  const row = id => Array.from(host.querySelectorAll("li[data-token-id]")).find(node => node.dataset.tokenId === id);
  const button = text => Array.from(host.querySelectorAll("button")).find(node => node.textContent === text);
  const click = async node => {
    assert.ok(node); node.click();
    for (let attempt = 0; attempt < 100 && host.querySelector('[aria-busy="true"]'); attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(host.querySelector('[aria-busy="true"]'), null);
  };
  const select = (name, selected) => { for (const input of host.querySelectorAll(`input[name="${name}"]`)) input.checked = selected.includes(input.value); };
  return { ...f, tokens, first, second, firstLibrary, secondLibrary, service, dom, host, mount, row, button, click, select, dispose: () => dispose?.() };
}

test("connection address and Codex command copy their full text and allow retry after clipboard failure", async t => {
  const f = await fixture(t), copied = [];
  let fail = false;
  Object.defineProperty(f.dom.window.navigator, "clipboard", { value: { writeText: async value => {
    if (fail) throw Error("Clipboard unavailable"); copied.push(value);
  } } });
  await f.mount();
  const address = f.host.querySelector("#km-mcp-address"), command = f.host.querySelector("#km-mcp-command");
  assert.equal(address.previousElementSibling.textContent, "MCP address");
  const endpoint = f.service.snapshot().endpoint;
  address.querySelector("button").click(); await settle();
  command.querySelector("button").click(); await settle();
  assert.deepEqual(copied, [endpoint, `codex mcp add zotero-knowledge --url ${endpoint} --bearer-token-env-var ZOTERO_KNOWLEDGE_MCP_TOKEN`]);
  for (const block of [address, command]) {
    assert.equal(block.querySelector('[role="status"]').textContent, "Copied");
    assert.equal(block.querySelector("button").disabled, false);
  }
  fail = true; address.querySelector("button").click(); await settle();
  assert.equal(address.querySelector('[role="status"]').textContent, "Could not copy. Try again.");
  assert.equal(address.querySelector("button").disabled, false);
  fail = false; address.querySelector("button").click(); await settle();
  assert.equal(copied.at(-1), endpoint); assert.equal(address.querySelector('[role="status"]').textContent, "Copied");
});

test("connection state follows the enabled checkbox and updates after applying settings", async t => {
  const f = await fixture(t);
  let snapshot = f.service.snapshot();
  f.service.snapshot = () => snapshot;
  f.service.configure = async enabled => { snapshot = { ...snapshot, enabled, status: enabled ? "running" : "stopped" }; };
  await f.mount();
  const state = () => f.host.querySelector(".km-mcp-connection-state");
  assert.equal(state().textContent, "(Stopped)");
  assert.equal(state().dataset.state, "stopped");
  assert.equal(state().previousElementSibling.querySelector("input").id, "km-mcp-enabled");
  assert.equal(f.host.querySelector(".km-mcp-connection-heading").children.length, 1);
  f.host.querySelector("#km-mcp-enabled").checked = true;
  await f.click(f.button("Apply connection settings"));
  assert.equal(state().textContent, "(Running)"); assert.equal(state().dataset.state, "running");
  f.host.querySelector("#km-mcp-enabled").checked = false;
  await f.click(f.button("Apply connection settings"));
  assert.equal(state().textContent, "(Stopped)"); assert.equal(state().dataset.state, "stopped");
});

test("token management lists authorization, permissions, dates and terminal states without exposing secrets", async t => {
  const f = await fixture(t);
  await f.db.updateTable("mcp_tokens").set({ expires_at: Date.now() - 1 }).where("id", "=", f.second.id).execute();
  const revoked = await f.tokens.create({ name: "Revoked", libraryIds: [f.firstLibrary], scopes: ["knowledge:read"] });
  await f.db.updateTable("mcp_tokens").set({ revoked_at: 0 }).where("id", "=", revoked.id).execute();
  await f.mount();
  assert.equal(f.host.querySelector("table"), null); assert.equal(f.host.querySelector(".km-mcp-token-editor"), null);
  const row = f.row(f.first.id), saved = (await f.tokens.list()).find(token => token.id === f.first.id);
  assert.match(row.textContent, /First library/); assert.match(row.textContent, /Read literature/);
  assert.equal(row.querySelector("h4").textContent, "Reader <img>"); assert.equal(row.querySelector("img"), null);
  assert.deepEqual(Array.from(row.querySelectorAll("dt"), node => node.textContent), ["Access scope", "Permissions", "Created", "Expires"]);
  assert.deepEqual(Array.from(row.querySelectorAll("time"), node => node.dateTime), [saved.createdAt, saved.expiresAt].map(time => new Date(time).toISOString()));
  assert.equal(row.dataset.state, "mcp-active"); assert.equal(f.row(f.second.id).dataset.state, "mcp-expired");
  assert.equal(f.row(revoked.id), undefined); assert.ok((await f.tokens.list()).some(token => token.id === revoked.id));
  assert.equal(f.host.querySelector("details,summary,h2"), null);
  assert.match(f.host.querySelector(".km-mcp-connection-settings").textContent, /Connection settings/);
  assert.match(f.host.querySelector(".km-mcp-connect-help").textContent, /Connect Codex/);
  assert.ok(!f.host.textContent.includes(f.first.secret)); assert.equal(f.host.querySelector("#km-mcp-secret"), null);
});

test("editing one token changes only its selected libraries and scopes while keeping its secret and expiry", async t => {
  const f = await fixture(t); await f.mount();
  const before = await f.tokens.list(), port = f.host.querySelector("#km-mcp-port"); port.value = "30123";
  port.dispatchEvent(new f.dom.window.Event("input"));
  await f.click(f.row(f.first.id).querySelector('[data-action="edit"]'));
  assert.equal(f.host.querySelector("#km-mcp-port").value, "30123");
  assert.equal(f.host.querySelector("#km-mcp-name").value, "Reader <img>");
  assert.equal(f.host.querySelector(".km-mcp-token-editor").closest("li"), f.row(f.first.id));
  assert.deepEqual(Array.from(f.host.querySelectorAll('input[name="library"]:checked'), input => input.value), [f.firstLibrary]);
  assert.deepEqual(Array.from(f.host.querySelectorAll('input[name="scope"]:checked'), input => input.value), ["knowledge:read"]);
  assert.equal(f.host.querySelector("#km-mcp-expiry"), null);
  f.select("library", [f.secondLibrary]); f.select("scope", ["knowledge:search"]);
  await f.click(f.button("Save token changes"));
  const after = await f.tokens.list(), principal = await f.tokens.authenticate(f.first.secret);
  assert.deepEqual(principal.libraries, [f.secondLibrary]); assert.deepEqual(principal.scopes, ["knowledge:search"]);
  const original = before.find(token => token.id === f.first.id), updated = after.find(token => token.id === f.first.id);
  assert.equal(updated.createdAt, original.createdAt); assert.equal(updated.expiresAt, original.expiresAt);
  assert.deepEqual(after.find(token => token.id === f.second.id), before.find(token => token.id === f.second.id));
  assert.match(f.row(f.first.id).textContent, /Second library/); assert.match(f.row(f.first.id).textContent, /Discover and search/);
  assert.match(f.host.querySelector("#km-mcp-status").textContent, /permissions saved/);
});

test("revocation requires confirmation, cancellation retains the draft and only the confirmed token loses access", async t => {
  const f = await fixture(t); await f.mount();
  let calls = 0; f.service.revokeToken = async id => { calls++; await f.tokens.revoke(id); };
  await f.click(f.button("New token"));
  f.host.querySelector("#km-mcp-name").value = "Unsaved new token";
  await f.click(f.row(f.first.id).querySelector('[data-action="revoke"]'));
  assert.equal(calls, 0); assert.match(f.host.querySelector(".km-mcp-token-confirmation").textContent, /Reader <img>/);
  await f.click(f.button("Cancel")); assert.equal(calls, 0);
  assert.equal(f.host.querySelector("#km-mcp-name").value, "Unsaved new token");
  await f.tokens.authenticate(f.first.secret);
  await f.click(f.row(f.first.id).querySelector('[data-action="revoke"]'));
  const confirm = f.host.querySelector('[data-action="confirm-revoke"]'); confirm.click(); confirm.click(); await settle();
  assert.equal(calls, 1); await assert.rejects(f.tokens.authenticate(f.first.secret), /expired or revoked/);
  await f.tokens.authenticate(f.second.secret);
  assert.equal(f.row(f.first.id), undefined);
});

test("failed edits retain the token draft and restore controls without changing authorization", async t => {
  const f = await fixture(t); await f.mount(); const before = await f.tokens.list();
  await f.click(f.row(f.first.id).querySelector('[data-action="edit"]'));
  f.select("library", []); await f.click(f.button("Save token changes"));
  assert.match(f.host.querySelector("#km-mcp-status").textContent, /operation failed/);
  assert.equal(f.host.querySelector("#km-mcp-name").value, "Reader <img>");
  assert.equal(f.button("Save token changes").disabled, false); assert.deepEqual(await f.tokens.list(), before);
  f.select("library", [f.firstLibrary]); f.select("scope", []); await f.click(f.button("Save token changes"));
  assert.deepEqual(await f.tokens.list(), before);
});

test("a successful creation retains its one-time secret even when the list refresh fails", async t => {
  const f = await fixture(t); await f.mount();
  let created;
  f.service.createToken = async input => { created = await f.tokens.create(input); f.service.listTokens = async () => { throw Error("Read unavailable"); }; return created; };
  await f.click(f.button("New token"));
  f.host.querySelector("#km-mcp-name").value = "New client"; f.select("library", [f.firstLibrary]);
  await f.click(f.button("Create token"));
  assert.ok(created); assert.equal(f.host.querySelector("#km-mcp-secret").value, created.secret);
  assert.equal(f.host.querySelector("#km-mcp-secret").type, "password"); assert.ok(!f.host.textContent.includes(created.secret));
  assert.equal(f.host.querySelector("#km-mcp-secret").closest("li").dataset.tokenId, created.id);
  assert.equal(f.row(created.id).querySelector("time"), null);
  assert.match(f.host.querySelector("#km-mcp-status").textContent, /change was saved/);
  await f.tokens.authenticate(created.secret);
  f.dispose(); f.service.listTokens = () => f.tokens.list(); await f.mount();
  assert.equal(f.host.querySelector("#km-mcp-secret"), null); assert.match(f.row(created.id).textContent, /New client/);
});

test("inline editors switch immediately without requests and restore drafts until explicit cancellation", async t => {
  const f = await fixture(t); let reads = 0;
  f.service.listTokens = async () => { reads++; return f.tokens.list(); };
  await f.mount(); const initialReads = reads, port = f.host.querySelector("#km-mcp-port");
  await f.click(f.row(f.first.id).querySelector('[data-action="edit"]'));
  f.host.querySelector("#km-mcp-name").value = "Unsaved reader"; f.select("library", [f.secondLibrary]);
  await f.click(f.row(f.second.id).querySelector('[data-action="edit"]'));
  assert.equal(f.host.querySelector("#km-mcp-name").value, "Research client");
  await f.click(f.row(f.first.id).querySelector('[data-action="edit"]'));
  assert.equal(f.host.querySelector("#km-mcp-name").value, "Unsaved reader");
  assert.equal(f.host.querySelector('input[name="library"]:checked').value, f.secondLibrary);
  assert.equal(f.host.querySelectorAll("#km-mcp-name").length, 1);
  assert.equal(f.host.querySelector("#km-mcp-port"), port); assert.equal(reads, initialReads);
  await f.click(f.button("Cancel editing")); assert.equal(f.host.querySelector("#km-mcp-name"), null);
  await f.click(f.row(f.first.id).querySelector('[data-action="edit"]'));
  assert.equal(f.host.querySelector("#km-mcp-name").value, "Reader <img>");
  assert.equal(reads, initialReads);
  const escape = new f.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  f.host.querySelector("#km-mcp-name").dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true); assert.equal(f.host.querySelector("#km-mcp-name"), null);
  await f.click(f.button("New token"));
  assert.equal(f.host.querySelector("#km-mcp-new-token").textContent, "Cancel editing");
  await f.click(f.host.querySelector("#km-mcp-new-token"));
  assert.equal(f.host.querySelector("#km-mcp-name"), null);
});

test("unavailable libraries stay explicit and cannot silently grant a different library", async t => {
  const f = await fixture(t); f.service.libraries = async () => [{ id: f.secondLibrary, name: "Second library" }];
  await f.mount(); assert.match(f.row(f.first.id).textContent, /Unavailable knowledge library/);
  await f.click(f.row(f.first.id).querySelector('[data-action="edit"]'));
  assert.match(f.host.querySelector(".km-mcp-token-editor").textContent, /Unavailable knowledge libraries cannot be authorized/);
  assert.equal(f.host.querySelector('input[name="library"]').checked, false);
  await f.click(f.button("Save token changes"));
  assert.deepEqual((await f.tokens.current(f.first.id)).libraries, [f.firstLibrary]);
});

test("a committed revocation removes row actions even if the following list refresh fails", async t => {
  const f = await fixture(t); await f.mount();
  f.service.revokeToken = async id => { await f.tokens.revoke(id); f.service.listTokens = async () => { throw Error("Read unavailable"); }; };
  await f.click(f.row(f.first.id).querySelector('[data-action="revoke"]'));
  await f.click(f.host.querySelector('[data-action="confirm-revoke"]'));
  assert.equal(f.row(f.first.id), undefined);
  assert.match(f.host.querySelector("#km-mcp-status").textContent, /change was saved/);
  await assert.rejects(f.tokens.authenticate(f.first.secret));
});

test("new secrets belong below their token's dates and do not appear under another token", async t => {
  const f = await fixture(t); await f.mount();
  await f.click(f.button("New token")); f.host.querySelector("#km-mcp-name").value = "New client";
  f.select("library", [f.firstLibrary]); await f.click(f.button("Create token"));
  const token = (await f.tokens.list()).find(token => token.name === "New client"), row = f.row(token.id);
  const secretHost = row.querySelector("#km-mcp-secret-container"), metadata = row.querySelector(".km-mcp-token-metadata");
  assert.ok(secretHost); assert.equal(secretHost.querySelector("input").type, "password");
  assert.ok(metadata.compareDocumentPosition(secretHost) & f.dom.window.Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(f.row(f.first.id).querySelector("#km-mcp-secret-container"), null);
  assert.equal(f.host.querySelectorAll("#km-mcp-secret-container").length, 1);
});

test("a list containing only revoked tokens shows the empty state without deleting records", async t => {
  const f = await fixture(t); await f.tokens.revoke(f.first.id); await f.tokens.revoke(f.second.id);
  await f.mount(); assert.equal(f.host.querySelectorAll("li[data-token-id]").length, 0);
  assert.equal(f.host.querySelector(".km-mcp-token-list").hidden, true);
  assert.match(f.host.querySelector("#km-mcp-token-empty").textContent, /No personal access tokens/);
  assert.equal((await f.tokens.list()).length, 2);
});

test("closing settings during an accepted token update does not remount the disposed interface", async t => {
  const f = await fixture(t); await f.mount();
  await f.click(f.row(f.first.id).querySelector('[data-action="edit"]'));
  let release, calls = 0; const gate = new Promise(resolve => { release = resolve; });
  f.service.updateToken = async (id, input) => { calls++; await gate; await f.tokens.update(id, input); };
  f.select("scope", ["knowledge:search"]);
  const save = f.button("Save token changes"); save.click(); save.click();
  assert.equal(calls, 1); f.dispose(); release(); await settle();
  assert.equal(f.host.children.length, 0);
  assert.deepEqual((await f.tokens.current(f.first.id)).scopes, ["knowledge:search"]);
});
