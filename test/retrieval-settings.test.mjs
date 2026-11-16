import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t) {
  const f = await parsingFixture(t), logins = new Map();
  globalThis.Services = { logins: {
    findLogins: () => [...logins.values()], addLoginAsync: async login => { logins.set(login.username, login); },
    modifyLogin: (_old, login) => logins.set(login.username, login), removeLogin: login => logins.delete(login.username),
  }, prompt: { confirmEx: () => 0 } };
  globalThis.ChromeUtils = { importESModule: () => ({ nsLoginInfo: class { init(_origin, _form, _realm, username, password) { this.username=username;this.password=password; } } }) };
  const config = new api.RetrievalConfigFile();await config.start();t.after(()=>config.close());
  const dom = new JSDOM('<section id="km-settings"></section>');t.after(()=>dom.window.close());
  const host = dom.window.document.querySelector("section");
  const mount = async () => {const cleanup=await api.mountRetrievalSettings(host);t.after(cleanup);return cleanup;};
  const input = (key, value) => {const node=host.querySelector(`#km-vector-${key}`);if(node.type==="checkbox")node.checked=value;else node.value=value;node.dispatchEvent(new dom.window.Event("input",{bubbles:true}));return node;};
  return {...f,config,dom,host,logins,mount,input,save:()=>host.querySelector("#km-vector-save").click(),status:()=>host.querySelector("#km-vector-save-status").textContent};
}

test("model timeout settings display seconds, retain millisecond precision and validate in seconds", async t => {
  const f = await fixture(t); await f.config.save({ ...f.config.current, timeoutMs: 60001 });
  await f.mount(); assert.equal(f.host.querySelector("#km-vector-timeoutMs").value, "60.001");
  f.save(); await settle(); await f.config.reload(); assert.equal(f.config.current.timeoutMs, 60001);
  f.input("timeoutMs", "1.001"); f.save(); await settle(); await f.config.reload();
  assert.equal(f.config.current.timeoutMs, 1001);
  for (const value of ["0.999", "600.001", "1.0001", ""]) {
    f.input("timeoutMs", value); f.save(); await settle();
    assert.match(f.status(), /1 to 600 seconds/);
    assert.equal(f.host.querySelector("#km-vector-timeoutMs").getAttribute("aria-invalid"), "true");
    assert.equal(f.host.querySelector("#km-vector-timeoutMs").closest("details").open, true);
    await f.config.reload(); assert.equal(f.config.current.timeoutMs, 1001);
  }
  f.host.querySelector("#km-vector-reload").click(); await settle();
  assert.equal(f.host.querySelector("#km-vector-timeoutMs").value, "1.001");
  for (const seconds of ["1", "600"]) {
    f.input("timeoutMs", seconds); f.save(); await settle(); await f.config.reload();
    assert.equal(f.config.current.timeoutMs, Number(seconds) * 1000);
  }
});

test("model settings show saved, shared and pending keys without exposing them and retain keys after reopening", async t => {
  const f=await fixture(t);let dispose=await f.mount();
  assert.match(f.host.querySelector("#km-vector-embedding-key-state").textContent,/No key/);
  assert.equal(f.host.querySelector("#km-vector-rerank-key").disabled,true);
  f.input("embedding-key","embedding-secret");assert.match(f.host.querySelector("#km-vector-embedding-key-state").textContent,/not saved/);
  f.save();await settle();assert.match(f.status(),/settings and api keys saved/i);
  assert.equal(f.logins.get("embedding").password,"embedding-secret");assert.equal(f.logins.has("rerank"),false);
  assert.equal(f.host.querySelector("#km-vector-embedding-key").value,"");assert.match(f.host.querySelector("#km-vector-embedding-key-state").textContent,/saved securely/);
  assert.match(f.host.querySelector("#km-vector-rerank-key-state").textContent,/embedding key:.*saved securely/);
  assert.ok(!JSON.stringify(JSON.parse(await IOUtils.readUTF8(f.config.path))).includes("embedding-secret"));
  dispose();dispose=await f.mount();assert.match(f.host.querySelector("#km-vector-embedding-key-state").textContent,/saved securely/);
  f.input("shareCredential",false);f.input("rerank-key","rerank-secret");f.save();await settle();
  assert.equal(f.logins.get("rerank").password,"rerank-secret");f.save();await settle();assert.equal(f.logins.get("embedding").password,"embedding-secret");
});

test("model settings locate validation errors, report conflicts and restore saved settings without maintenance side effects", async t => {
  const f=await fixture(t);let enqueued=0;
  Zotero.__knowledgeMCPRetrieval={status:()=>"idle",configuration:()=>({revision:0,error:false}),enqueueAll:async()=>{enqueued++;},rebuild:async()=>{},clear:async()=>{}};
  await f.mount();f.input("candidates","10");f.save();await settle();assert.match(f.status(),/at least.*20/);assert.equal(f.host.querySelector("#km-vector-candidates").getAttribute("aria-invalid"),"true");
  f.input("candidates","100");f.input("embedding-endpoint","not-an-endpoint");f.save();await settle();assert.match(f.status(),/full HTTPS/);
  f.host.querySelector("#km-vector-reload").click();await settle();assert.match(f.status(),/restored/);assert.equal(f.host.querySelector("#km-vector-candidates").value,"100");
  await f.config.reload();await f.config.save({...f.config.current,results:10});
  f.input("embedding-key","unsaved-secret");f.save();await settle();assert.match(f.status(),/another window/);assert.equal(f.logins.size,0,"conflict checked before updating keys");
  assert.equal(f.host.querySelector("#km-vector-enqueue").disabled,true);f.host.querySelector("#km-vector-enqueue").click();assert.equal(enqueued,0);
});

test("connection tests immediately show progress, validate only their service, prevent repeats and fence stale responses", async t => {
  const f=await fixture(t);await f.mount();f.input("embedding-key","temporary-secret");f.input("candidates","0");f.input("rerank-endpoint","");
  const original=api.ModelGateway.prototype.embed;let resolve,calls=0,signal;
  api.ModelGateway.prototype.embed=function(_text,value){assert.equal(this.config().timeoutMs,15000);assert.equal(this.maximumRetries,0);calls++;signal=value;return new Promise(done=>{resolve=done;});};t.after(()=>{api.ModelGateway.prototype.embed=original;});
  let button=f.host.querySelector("#km-vector-embedding-test");button.click();
  assert.equal(button.disabled,true);assert.match(button.textContent,/Testing/);assert.match(f.host.querySelector("#km-vector-embedding-test-status").textContent,/Connecting/);button.click();assert.equal(calls,1);
  resolve([]);await settle();assert.match(f.host.querySelector("#km-vector-embedding-test-status").textContent,/verified/);assert.equal(f.logins.size,0,"testing does not save the key");
  button.click();f.input("embedding-model","another-model");assert.equal(signal.aborted,true);resolve([]);await settle();assert.equal(f.host.querySelector("#km-vector-embedding-test-status").textContent,"");
  button.click();f.host.querySelector("#km-vector-embedding-test-cancel").click();assert.equal(signal.aborted,true);resolve([]);await settle();assert.match(f.host.querySelector("#km-vector-embedding-test-status").textContent,/cancelled/);
  api.ModelGateway.prototype.embed=async()=>{throw new api.ModelError("credentials");};button.click();await settle();assert.match(f.host.querySelector("#km-vector-embedding-test-status").textContent,/failed.*key|failed.*credential/i);
  api.ModelGateway.prototype.embed=async()=>{throw new api.ModelError("http-404");};button.click();await settle();assert.match(f.host.querySelector("#km-vector-embedding-test-status").textContent,/HTTP 404/);
});

test("credential staging rolls back failed writes and cannot leave new keys behind after a settings write failure", async t => {
  const f=await fixture(t),credentials=new api.ModelCredentials();await credentials.set("embedding","old-secret");await f.mount();f.input("embedding-key","replacement-secret");
  const write=IOUtils.writeUTF8;IOUtils.writeUTF8=async()=>{throw Error("disk write failed");};f.save();await settle();IOUtils.writeUTF8=write;
  assert.match(f.status(),/Could not save/);assert.equal(credentials.get("embedding"),"old-secret");
  const add=Services.logins.addLoginAsync;Services.logins.addLoginAsync=async()=>{throw Error("key store failed");};
  await assert.rejects(credentials.stage(new Map([["embedding","replacement-secret"],["rerank","new-secret"]])),error=>error.code==="credentials-store");
  Services.logins.addLoginAsync=add;assert.equal(credentials.get("embedding"),"old-secret");assert.equal(credentials.status("rerank"),"missing");
});

test("a lost file-write acknowledgement preserves the committed credential and configuration pair", async t => {
  const f=await fixture(t),credentials=new api.ModelCredentials();await f.mount();f.input("embedding-key","committed-secret");
  const write=IOUtils.writeUTF8;IOUtils.writeUTF8=async(...args)=>{await write(...args);throw Error("ack lost");};f.save();await settle();IOUtils.writeUTF8=write;
  assert.match(f.status(),/settings and api keys saved/i);assert.equal(credentials.get("embedding"),"committed-secret");
  assert.equal(JSON.parse(await IOUtils.readUTF8(f.config.path)).revision,1);
});

test("restoring the last valid model configuration clears a transient read error", async t => {
  const f=await fixture(t),original=await IOUtils.readUTF8(f.config.path);
  await IOUtils.writeUTF8(f.config.path,"{broken");await f.config.reload();assert.equal(f.config.error,true);
  await IOUtils.writeUTF8(f.config.path,original);await f.config.reload();assert.equal(f.config.error,false);
});

test("relevance threshold accepts fractional values, persists, and focuses invalid input",async t=>{
  const f=await fixture(t);await f.mount();const field=f.host.querySelector("#km-vector-relevanceThreshold");assert.equal(field.value,"0.5");assert.equal(field.step,"0.01");
  f.input("relevanceThreshold","1.1");f.save();await settle();assert.match(f.status(),/from 0 to 1/);assert.equal(field.getAttribute("aria-invalid"),"true");
  f.input("relevanceThreshold","0.65");f.save();await settle();assert.equal(JSON.parse(await IOUtils.readUTF8(f.config.path)).relevanceThreshold,.65);
});
