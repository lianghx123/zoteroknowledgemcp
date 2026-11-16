// Developer-driven packaged-plugin recovery against existing isolated vectors. Never re-embed the corpus.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { evaluate as nativeEvaluate } from "./verify-vector-native.mjs";

const port = Number(process.env.ZOTERO_DEBUG_PORT ?? 9253);
const resourceId = process.env.ZOTERO_VECTOR_TEST_RESOURCE_ID;
const query = process.env.ZOTERO_VECTOR_TEST_QUERY ?? "research";
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(resourceId ?? "")) throw Error("Set ZOTERO_VECTOR_TEST_RESOURCE_ID to an existing isolated resource UUID");
const folder = path.resolve(".scaffold/vector-startup-mcp");
await fs.mkdir(folder, { recursive: true });
const evaluate = source => nativeEvaluate(`(()=>{const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");return eval(${JSON.stringify(source)});})()`, port);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { runtime: "isolated Zotero; existing populated vector snapshot; real MCP/Gecko/model query", checks: [] };
let token, session, endpoint, original, installed = false;
const stamp = `${process.pid}-${Date.now()}`;
const runnerFile = path.join(folder, `controller-${stamp}.js`);
await fs.writeFile(runnerFile, `var VectorRepairRunner={async run(source){try{Zotero.__vectorRepairOperation={value:await eval("(async()=>{"+source+"})()")};}catch(error){Zotero.__vectorRepairOperation={error:String(error),stack:error.stack};}}};`);
const runnerURI = new URL(`file:///${runnerFile.replaceAll("\\", "/")}`).href;
await evaluate(`(()=>{const runtime=Components.utils.getGlobalForObject(ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout);
 delete Zotero.__vectorRepairRunner;delete Zotero.__vectorRepairSandbox;
 const sandbox=Components.utils.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{sandboxName:"Window-independent vector acceptance controller",sandboxPrototype:runtime,wantXrays:false});
 Object.assign(sandbox,{Zotero,Services});Services.scriptloader.loadSubScript(${JSON.stringify(runnerURI)},sandbox);Zotero.__vectorRepairSandbox=sandbox;Zotero.__vectorRepairRunner=sandbox.VectorRepairRunner;return true;})()`);
const candidate = path.join(folder, `candidate-${stamp}.xpi`), instrumented = path.join(folder, `instrumented-${stamp}.xpi`);
await fs.copyFile(path.resolve(".scaffold/build/zotero-knowledge-mcp.xpi"), candidate);
const zip = new AdmZip(candidate), anchor = "return __toCommonJS(index_exports);";
let main = zip.readAsText("content/main.js");
if (!main.includes(anchor)) throw Error("Unexpected production bundle");
main = main.replace(anchor, `
const vectorRepairStart=PluginApplication.prototype.start;
PluginApplication.prototype.start=async function(...args){
 await vectorRepairStart.apply(this,args);const control=Zotero.__vectorRepairControl;if(!control)return;
 control.states=[];control.attempts=0;control.unsubscribe=this.recovery.subscribe(()=>control.states.push(this.recovery.snapshot()));
 const restore=this.recovery.steps.index;
 this.recovery.steps.index=async()=>{control.attempts++;if(control.attempts===1)await new (hostRuntime().Promise)(resolve=>{control.release=resolve;});
  if(control.failOnce){control.failOnce=false;throw Error("index-worker");}return restore();};
};
` + anchor);
zip.updateFile("content/main.js", Buffer.from(main)); zip.writeZip(instrumented);

async function until(source, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = JSON.parse(await evaluate(`JSON.stringify(${source})`));
    if (result) return result;
    await wait(50);
  }
  throw Error(`Native condition timed out: ${source}`);
}
async function operation(source) {
  await evaluate(`delete Zotero.__vectorRepairOperation;void Zotero.__vectorRepairRunner.run(${JSON.stringify(source)});true`);
  const result = await until("Zotero.__vectorRepairOperation??null");
  if (result.error) throw Error(result.error);
  return result.value;
}
async function install(file) {
  session = undefined;
  await operation(`const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(file)});await AddonManager.installTemporaryAddon(file);return true;`);
  await until("!!Zotero.__knowledgeMCPAccess"); installed = true;
}
async function rpc(method, params, retried = false) {
  if (method !== "initialize" && !session) await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "vector-startup-acceptance", version: "1" } });
  const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${token.secret}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25",
    ...(method !== "initialize" && session ? { "Mcp-Session-Id": session } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(60000) });
  const body = await response.text();
  if (response.status === 404 && !retried) { session = undefined; return rpc(method, params, true); }
  assert.equal(response.status, 200, `MCP HTTP ${response.status}`);
  if (method === "initialize") session = response.headers.get("mcp-session-id");
  const match = /^data: (.+)$/m.exec(body); assert.ok(match, "SSE response required");
  const message = JSON.parse(match[1]); assert.ok(!message.error, "JSON-RPC success required"); return message.result;
}
const call = (mode, resourceId) => rpc("tools/call", { name: "search_content", arguments: { scopeType: "resource", scopeId: resourceId, query, mode, limit: 3, includeDiagnostics: true, rerank: false } });
async function reopen() {
  await operation(`if(!Zotero.__vectorRepairSurvival)return true;
   if(!Zotero.getMainWindows().length)await Zotero.openMainWindow();const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
   for(let i=0;i<200&&!Zotero.getMainWindows().some(w=>w.document.readyState==="complete"&&w.ZoteroPane?.itemsView);i++)await new Promise(resolve=>timer.setTimeout(resolve,50));
   if(!Zotero.getMainWindows().some(w=>w.document.readyState==="complete"&&w.ZoteroPane?.itemsView))throw Error("Window restore failed");
   Services.startup.exitLastWindowClosingSurvivalArea();delete Zotero.__vectorRepairSurvival;return true;`);
}

try {
  const initial = await operation(`if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated profile required");
   const s=Zotero.__knowledgeMCPAccess,db=s.tokens.db,e=s.tools.search.embeddings;
   const resource=await db.selectFrom("knowledge_resources").select("id").where("id","=",${JSON.stringify(resourceId)}).where("deleted_at","is",null).executeTakeFirstOrThrow();
   const links=await db.selectFrom("library_resources").select("library_id").where("resource_id","=",resource.id).where("deleted_at","is",null).execute();
   const token=await s.createToken({name:"Vector recovery acceptance ${stamp}",libraryIds:links.map(row=>row.library_id),scopes:["knowledge:read","knowledge:search"],expiresInDays:30});
   const count=await db.selectFrom("block_embeddings").select(eb=>eb.fn.countAll().as("count")).where("state","=","active").executeTakeFirstOrThrow();
   return {resource:resource.id,token,settings:s.snapshot(),count:Number(count.count),runtime:Zotero.version};`);
  token = initial.token; original = initial.settings; endpoint = original.endpoint;
  report.runtimeVersion = initial.runtime; report.vectorsBefore = initial.count;
  assert.ok(initial.count > 0, "Populated vector corpus required");
  await evaluate("Zotero.__vectorRepairControl={failOnce:true};true"); await install(instrumented);
  await until("!!Zotero.__vectorRepairControl?.release");
  const blocked = await call("vector", initial.resource);
  assert.equal(blocked.structuredContent.error.code, "INDEX_UNAVAILABLE"); assert.equal(blocked.structuredContent.error.details.reason, "initializing");
  const degraded = await call("hybrid", initial.resource);
  assert.ok(!degraded.isError); assert.ok(degraded.structuredContent.returnedCount > 0);
  assert.deepEqual(degraded.structuredContent.diagnostics.channels, ["fulltext", "metadata"]);
  assert.equal(degraded.structuredContent.warnings[0].code, "VECTOR_UNAVAILABLE"); report.checks.push("hybrid text fallback during actual blocked startup");
  await until("!!Zotero.getMainWindows()[0]?.document.getElementById('zotero-tb-search')?.searchModePopup?.querySelector('#km-search-fusion')");
  const ui = await operation(`const w=Zotero.getMainWindows()[0],doc=w.document,popup=doc.getElementById("zotero-tb-search").searchModePopup,fusion=popup.querySelector("#km-search-fusion"),semantic=popup.querySelector("#km-search-semantic"),rows=w.ZoteroPane.itemsView.collectionTreeRows;
   return {applicable:rows.length>0&&rows.every(row=>!row.advancedSearch&&!/import-tasks/.test(row.id)),fusionEnabled:fusion?.getAttribute("disabled")==="false",semanticEnabled:semantic?.getAttribute("disabled")==="false",localized:Boolean(fusion?.getAttribute("label"))&&!fusion.getAttribute("label").includes("knowledgemcp-")};`);
  report.ui = ui;
  if(ui.applicable)assert.equal(ui.fusionEnabled, true);
  assert.equal(ui.semanticEnabled, false); assert.equal(ui.localized, true); report.checks.push(ui.applicable?"localized native fusion menu available before vector readiness":"localized native menus preserve unavailable-view gates");
  await operation(`Services.startup.enterLastWindowClosingSurvivalArea();Zotero.__vectorRepairSurvival=true;
   for(const w of Zotero.getMainWindows())w.close();const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
   for(let i=0;i<200&&Zotero.getMainWindows().length;i++)await new Promise(resolve=>timer.setTimeout(resolve,25));
   if(Zotero.getMainWindows().length)throw Error("Windows did not close");return true;`);
  await evaluate("Zotero.__vectorRepairControl.release();true");
  await until("Zotero.__vectorRepairControl.states.some(state=>state.state==='failed')");
  const failed = await call("vector", initial.resource);
  assert.equal(failed.structuredContent.error.code, "INDEX_RECOVERY_FAILED"); assert.equal(failed.structuredContent.error.details.failureCode, "index-worker");
  report.checks.push("failed recovery exposes safe cause rather than initialization");
  await until("Zotero.__knowledgeMCPRetrieval.startup().state==='ready'");
  const recovered = await operation(`const e=Zotero.__knowledgeMCPAccess.tools.search.embeddings;return {windows:Zotero.getMainWindows().length,status:e.store.status,stats:await e.store.index.stats(),attempts:Zotero.__vectorRepairControl.attempts};`);
  assert.equal(recovered.windows, 0); assert.equal(recovered.status, "ready"); assert.ok(recovered.stats.count > 0); assert.equal(recovered.attempts, 2);
  report.headlessRecovery = recovered; report.checks.push("automatic local retry restores populated snapshot with all main windows closed");
  for (const mode of ["vector", "hybrid"]) {
    const result = await call(mode, initial.resource); assert.ok(!result.isError, JSON.stringify(result.structuredContent.error));
    assert.ok(result.structuredContent.returnedCount > 0); assert.ok(result.structuredContent.diagnostics.channels.includes("vector"));
    report.checks.push(`${mode}: actual MCP query embedding and populated index search with no main window`);
  }
  await reopen();
  await evaluate("Zotero.__vectorRepairControl.unsubscribe?.();delete Zotero.__vectorRepairControl;true"); await install(candidate);
  await until("Zotero.__knowledgeMCPRetrieval.startup().state==='ready'");
  for (const mode of ["vector", "hybrid"]) {
    const result = await call(mode, initial.resource); assert.ok(!result.isError, JSON.stringify(result.structuredContent.error)); assert.ok(result.structuredContent.returnedCount > 0);
    assert.ok(result.structuredContent.diagnostics.channels.includes("vector"));
  }
  report.checks.push("uninstrumented final XPI reload restores vector and hybrid retrieval");
  const final = await operation(`const e=Zotero.__knowledgeMCPAccess.tools.search.embeddings,db=e.repository.db;
   const row=await db.selectFrom("block_embeddings").select(eb=>eb.fn.countAll().as("count")).where("state","=","active").executeTakeFirstOrThrow();
   return {count:Number(row.count),status:e.store.status,recovery:Zotero.__knowledgeMCPRetrieval.startup()};`);
  assert.equal(final.count, initial.count); report.final = final; report.status = "passed";
} catch (error) { report.status = "failed"; report.error = String(error); process.exitCode = 1; }
finally {
  try {
    await evaluate("Zotero.__vectorRepairControl?.release?.();true"); await reopen();
    const control = JSON.parse(await evaluate("JSON.stringify(!!Zotero.__vectorRepairControl)"));
    if (control) { await evaluate("Zotero.__vectorRepairControl.unsubscribe?.();delete Zotero.__vectorRepairControl;true"); if (installed) { await install(candidate); await until("Zotero.__knowledgeMCPRetrieval.startup().state==='ready'"); } }
    if (token) await operation(`const s=Zotero.__knowledgeMCPAccess;await s.tokens.revoke(${JSON.stringify(token.id)});await s.tokens.db.transaction().execute(async tx=>{
     await tx.deleteFrom("mcp_token_scopes").where("token_id","=",${JSON.stringify(token.id)}).execute();await tx.deleteFrom("mcp_token_libraries").where("token_id","=",${JSON.stringify(token.id)}).execute();await tx.deleteFrom("mcp_tokens").where("id","=",${JSON.stringify(token.id)}).execute();});return true;`);
    // No worker is owned by this controller; release its process-scope references after the final operation has drained.
    await evaluate("delete Zotero.__vectorRepairOperation;delete Zotero.__vectorRepairRunner;delete Zotero.__vectorRepairSandbox;true"); report.cleanup = "passed";
  } catch (error) { report.cleanup = String(error); process.exitCode = 1; }
  await fs.writeFile(path.join(folder, "native.json"), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
