// Developer-driven checks against an isolated Zotero; never use a daily library.
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import net from "node:net";
import http from "node:http";
import { evaluate as nativeEvaluate } from "./verify-vector-native.mjs";
import { readdir } from "node:fs/promises";

export const folder = path.resolve(".scaffold/mcp-acceptance");
const port = Number(process.env.ZOTERO_DEBUG_PORT ?? 9253);
// The debugger loses its main-window global when the final main window closes.
export const evaluate = source => nativeEvaluate(`(()=>{const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");return eval(${JSON.stringify(source)});})()`, port);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function prepare() {
  await fs.mkdir(folder, { recursive: true });
  const probe = path.join(folder, `native-probe-${process.pid}-${Date.now()}.js`);
  await build({ stdin: { contents: `
import { mountMcpSettings } from "./src/ui/mcp-settings.ts";
import { purgeResource } from "./src/repositories/permanent-delete.ts";
import { EmbeddingRepository } from "./src/repositories/embeddings.ts";
import { BrowserParseTransport } from "./src/parsers/transport.ts";
import { hostRuntime } from "./src/core/host-runtime.ts";
export async function checkProcessTransport(url){
 const original=Zotero.getMainWindows;Zotero.getMainWindows=()=>[];
 try{const response=await new BrowserParseTransport().request(url,{method:"POST",headers:{Authorization:"Bearer synthetic-native-probe"}},5000,1024,new (hostRuntime().AbortController)().signal);
 return {text:new TextDecoder().decode(response.bytes),windowLookupCount:Zotero.getMainWindows().length};}finally{Zotero.getMainWindows=original;}
}
export async function closeMainWindows(){
 if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated profile required");
 Services.startup.enterLastWindowClosingSurvivalArea();Zotero.__mcpWindowSurvival=true;
 for(const window of Zotero.getMainWindows())window.close();
 const runtime=hostRuntime();for(let i=0;i<200&&Zotero.getMainWindows().length;i++)await new runtime.Promise(resolve=>runtime.setTimeout(resolve,50));
 if(Zotero.getMainWindows().length)throw Error("Main windows did not close");return true;
}
export async function restoreMainWindow(){
 if(!Zotero.__mcpWindowSurvival)return true;
 if(!Zotero.getMainWindows().length)await Zotero.openMainWindow();const runtime=hostRuntime();
 for(let i=0;i<200&&!Zotero.getMainWindows().some(window=>window.document.readyState==="complete"&&window.ZoteroPane?.itemsView);i++)await new runtime.Promise(resolve=>runtime.setTimeout(resolve,50));
 if(!Zotero.getMainWindows().some(window=>window.document.readyState==="complete"&&window.ZoteroPane?.itemsView))throw Error("Main window did not reopen");
 Services.startup.exitLastWindowClosingSurvivalArea();delete Zotero.__mcpWindowSurvival;return true;
}
export function runOperation(method,args){
 const operations={closeMainWindows,restoreMainWindow,checkProcessTransport,cleanup};
 delete Zotero.__mcpProbeOperation;
 void Promise.resolve().then(()=>operations[method](...args)).then(value=>Zotero.__mcpProbeOperation={value}).catch(error=>Zotero.__mcpProbeOperation={error:String(error)});
}
export async function inspectSettings(host){
 const dispose=await mountMcpSettings(host);try{return {description:host.querySelector(".km-settings-description")?.textContent,port:host.querySelector("#km-mcp-port")?.value,translated:!host.textContent.includes("knowledgemcp-")};}finally{dispose();}
}
export async function setup(){
 if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");
 const s=Zotero.__knowledgeMCPAccess,db=s.tokens.db,crypto=s.tokens.crypto,now=Date.now(),library=crypto.uuid(),resource=crypto.uuid(),source=crypto.uuid(),generation=crypto.uuid(),node=crypto.uuid(),block=crypto.uuid(),footnote=crypto.uuid(),rejected=crypto.uuid();
 const markdown="MCP native synthetic evidence. 中文 😀 "+"Unrelated native introduction. ".repeat(600)+"ÉCOLOGIE importante. ＥＣＯＬＯＧＹ native tail evidence.",hash=await crypto.hash(markdown);
 const original=s.snapshot();
 await db.transaction().execute(async tx=>{
  await tx.insertInto("knowledge_libraries").values({id:library,name:"MCP isolated acceptance",description:null,created_at:now,updated_at:now,deleted_at:null}).execute();
  await tx.insertInto("knowledge_resources").values({id:resource,title:"MCP synthetic acceptance paper",subtitle:null,resource_type:"journalArticle",language:"en",abstract:"Native published abstract",summary:"Native maintained summary",contributors_json:JSON.stringify([{firstName:"Synthetic",lastName:"Author",role:"author"}]),publication_date:"2026",metadata_authority:"local",canonical_source_id:null,metadata_fingerprint:null,created_at:now,updated_at:now,deleted_at:null,publication_title:"Synthetic Journal",volume:null,issue:null,doi:"10.0000/native"}).execute();
  await tx.insertInto("library_resources").values({id:crypto.uuid(),library_id:library,resource_id:resource,added_at:now,deleted_at:null}).execute();
  await tx.insertInto("resource_sources").values({id:source,resource_id:resource,source_type:"manual",source_role:"primary_document",availability:"available",text_content:markdown,stored_file_id:null,uri:null,media_type:"text/markdown",version_label:null,source_fingerprint:hash,fingerprint_algorithm:"sha256",active_generation_id:null,last_checked_at:now,error_code:null,created_at:now,updated_at:now,deleted_at:null}).execute();
  await tx.insertInto("content_generations").values({id:generation,resource_id:resource,source_id:source,parse_run_id:null,base_generation_id:null,base_content_version:0,content_version:1,source_version:1,source_fingerprint:hash,origin:"manual",content_fingerprint:hash,normalizer_version:"acceptance-1",created_by_type:"system",created_by:null,created_at:now,published_at:null}).execute();
  await tx.insertInto("structure_nodes").values({id:node,generation_id:generation,parent_id:null,node_type:"root",label:"Synthetic evidence",path:"/",depth:0,sort_order:0,canonical_order_start:0,canonical_order_end:2,page_start:1,page_end:1,source_type:"manual",source_ref_id:null,confidence:null,created_at:now}).execute();
  await tx.insertInto("content_blocks").values({id:block,generation_id:generation,structure_node_id:node,parent_block_id:null,supersedes_block_id:null,block_type:"text",canonical_order:0,local_order:0,content_markdown:markdown,content_normalized:markdown,content_hash:hash,source_type:"manual",page_start:1,page_end:1,confidence:null,created_at:now}).execute();
  for(const [id,order,role,status,value] of [[footnote,1,"note","auto","NATIVE_SCIENTIFIC_FOOTNOTE: estimates exclude withdrawn observations."],[rejected,2,"body","rejected","NATIVE_REJECTED_CONTENT"]]){
   await tx.insertInto("content_blocks").values({id,generation_id:generation,structure_node_id:node,parent_block_id:null,supersedes_block_id:null,block_type:role==="note"?"footnote":"text",content_role:role,canonical_order:order,local_order:order,content_markdown:value,content_normalized:value,content_hash:await crypto.hash(value),source_type:"manual",review_status:status,page_start:1,page_end:1,confidence:null,created_at:now}).execute();
  }
  await tx.updateTable("content_generations").set({state:"ready",published_at:now}).where("id","=",generation).execute();
  await tx.updateTable("resource_sources").set({active_generation_id:generation,content_version:1}).where("id","=",source).execute();
  await tx.updateTable("knowledge_resources").set({canonical_source_id:source}).where("id","=",resource).execute();
  await tx.insertInto("resource_references").values({id:crypto.uuid(),resource_id:resource,source_id:source,generation_id:generation,source_block_id:block,
   target_resource_id:null,target_source_id:null,target_generation_id:null,target_block_id:null,reference_type:"bibliography",label:"Native synthetic reference",raw_text:"Native synthetic reference.",confidence:null,created_at:now,updated_at:now,deleted_at:null}).execute();
 });
 const token=await s.createToken({name:"MCP isolated acceptance",libraryIds:[library],scopes:["knowledge:search","knowledge:read","knowledge:annotate","knowledge:update-summary"]});
 await s.configure(true,23126);
 Zotero.__mcpAcceptance={library,resource,source,generation,node,block,token,original};
 await new EmbeddingRepository(db).projectFulltext();
 await s.refreshKnowledgeView();
 const w=Zotero.getMainWindows()[0],host=w.document.createElementNS("http://www.w3.org/1999/xhtml","section");
 w.document.documentElement.append(host);const dispose=await mountMcpSettings(host);
 const ui={mounted:!!host.querySelector("#km-mcp-settings"),port:host.querySelector("#km-mcp-port")?.value,endpoint:host.textContent.includes("/mcp/knowledge"),secretAbsent:!host.textContent.includes(token.secret),locales:[]};dispose();host.remove();
 for(const locale of ["en-US","zh-CN","zh-TW","de","fr-FR","es-ES","ja-JP"]){
  function ScopedLocalization(ids,sync){return new Localization(ids,sync,undefined,[locale]);}
  const target={Zotero,Services,ChromeUtils,Components,Localization:ScopedLocalization,Promise,Map,URL};
  Services.scriptloader.loadSubScript(Zotero.__mcpProbeURL,target);
  const host=w.document.createElementNS("http://www.w3.org/1999/xhtml","section");w.document.documentElement.append(host);
  try{const result=await target.McpNativeProbe.inspectSettings(host);const expected=new Localization(["knowledgemcp.ftl"],true,undefined,[locale]).formatValueSync("knowledgemcp-mcp-description");if(result.description!==expected||!result.translated)throw Error("Native locale mismatch: "+locale);ui.locales.push({locale,...result});}finally{host.remove();}
 }
 return {library,resource,node,block,footnote,rejected,ui,status:s.snapshot(),migrationCount:(await db.selectFrom("kysely_migration").select("name").execute()).length};
}
export async function cleanup(){
 await restoreMainWindow();
 const state=Zotero.__mcpAcceptance;if(!state)return;
 const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");for(let i=0;i<200&&!Zotero.__knowledgeMCPAccess;i++)await new Promise(resolve=>timer.setTimeout(resolve,50));
 const s=Zotero.__knowledgeMCPAccess;await s.revokeToken(state.token.id);await s.configure(state.original.enabled,state.original.port);
 const db=s.tokens.db;
 await db.transaction().execute(async tx=>{
  await tx.deleteFrom("library_resources").where("resource_id","=",state.resource).execute();
  if(await tx.selectFrom("knowledge_resources").select("id").where("id","=",state.resource).executeTakeFirst())await purgeResource(tx,state.resource);
  await tx.deleteFrom("mutation_receipts").where("authority_key","=","mcp:"+state.token.id).execute();
  await tx.deleteFrom("change_outbox").where("aggregate_id","=",state.resource).execute();
  await tx.deleteFrom("mcp_token_libraries").where("token_id","=",state.token.id).execute();
  await tx.deleteFrom("mcp_token_scopes").where("token_id","=",state.token.id).execute();
  await tx.deleteFrom("mcp_tokens").where("id","=",state.token.id).execute();
  await tx.deleteFrom("knowledge_libraries").where("id","=",state.library).execute();
 });
 await s.refreshKnowledgeView();
 const remaining=await db.selectFrom("knowledge_libraries").select("id").where("id","=",state.library).executeTakeFirst();
 const visible=()=>Zotero.getMainWindows().some(w=>Array.from(w.document.querySelectorAll("span")).some(node=>node.textContent.trim()==="MCP isolated acceptance"));
 for(let i=0;i<100&&visible();i++)await new Promise(resolve=>timer.setTimeout(resolve,50));
 if(remaining||visible())throw Error("MCP acceptance cleanup did not remove its library from storage and the native view");
 delete Zotero.__mcpAcceptance;
}`, loader: "ts", resolveDir: process.cwd() }, bundle: true, platform: "browser", target: "firefox140", format: "iife", globalName: "McpNativeProbe", outfile: probe });
  // A unique acceptance copy avoids locking the next build's XPI on Windows
  // and prevents same-version JAR cache reuse across candidate installations.
  const xpi = path.join(folder, `candidate-${process.pid}-${Date.now()}.xpi`);
  await fs.copyFile(path.resolve(".scaffold/build/zotero-knowledge-mcp.xpi"), xpi);
  await evaluate(`delete Zotero.__mcpAcceptanceResult;delete Zotero.__mcpAcceptanceCleanup;void(async()=>{try{
if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated profile required");
const runtime=Components.utils.getGlobalForObject(ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout);
const target=Components.utils.Sandbox(Services.scriptSecurityManager.getSystemPrincipal(),{sandboxName:"Knowledge MCP native acceptance",sandboxPrototype:runtime,wantXrays:false});
Object.assign(target,{Zotero,Services,Localization});
Zotero.__mcpProbeURL=${JSON.stringify(new URL(`file:///${probe.replaceAll("\\", "/")}`).href)};Services.scriptloader.loadSubScript(Zotero.__mcpProbeURL,target);Zotero.__mcpAcceptanceProbe=target.McpNativeProbe;
if(Zotero.__mcpAcceptance)await Zotero.__mcpAcceptanceProbe.cleanup();
const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"),file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(xpi)});await AddonManager.installTemporaryAddon(file);
const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");for(let i=0;i<200&&!Zotero.__knowledgeMCPAccess;i++)await new Promise(resolve=>timer.setTimeout(resolve,50));
const result=await Zotero.__mcpAcceptanceProbe.setup();Zotero.__mcpAcceptanceResult=result;
}catch(error){Zotero.__mcpAcceptanceResult={error:String(error),stack:error.stack};}})()`);
  for (let i = 0; i < 200; i++) {
    const raw = await evaluate("JSON.stringify(Zotero.__mcpAcceptanceResult??null)"), result = JSON.parse(raw);
    if (result) { if (result.error) throw Error(JSON.stringify(result)); return result; } await wait(100);
  } throw Error("Native setup timed out");
}
export async function secret() { return evaluate("Zotero.__mcpAcceptance.token.secret"); }
export async function cleanup() {
  await probeOperation("cleanup");
}
const clientIds = new Map();
export async function rpc(token, method, params = {}, id = 1, extra = {}, retry = true) {
  if(method!=="initialize"&&!clientIds.has(token))await rpc(token,"initialize",{protocolVersion:"2025-11-25",capabilities:{},clientInfo:{name:"native-acceptance",version:"1"}});
  const response = await fetch("http://127.0.0.1:23126/mcp/knowledge", { method: "POST", headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json", "MCP-Protocol-Version": "2025-11-25", ...(method!=="initialize"&&clientIds.has(token)?{"Mcp-Session-Id":clientIds.get(token)}:{}), ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(15000) });
  const body = await response.text(), match = /^data: (.+)$/m.exec(body);
  if(method==="initialize"&&response.ok&&response.headers.get("mcp-session-id"))clientIds.set(token,response.headers.get("mcp-session-id"));
  if(method!=="initialize"&&response.status===404&&retry){clientIds.delete(token);return rpc(token,method,params,id,extra,false);}
  return { status: response.status, contentType: response.headers.get("content-type"), message: match ? JSON.parse(match[1]) : body };
}
async function probeOperation(method, args = []) {
  await evaluate(`Zotero.__mcpAcceptanceProbe.runOperation(${JSON.stringify(method)},${JSON.stringify(args)})`);
  for(let i=0;i<240;i++){
    const result=JSON.parse(await evaluate("JSON.stringify(Zotero.__mcpProbeOperation??null)"));
    if(result){if(result.error)throw Error(result.error);return result.value;}await wait(50);
  }throw Error("Native operation timed out: "+method);
}
async function verifyProcessTransport() {
  const server=http.createServer((_request,response)=>{response.setHeader("Content-Type","text/plain; charset=utf-8");response.end("Process transport 中文 😀");});
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  try {
    const result=await probeOperation("checkProcessTransport",[`http://127.0.0.1:${server.address().port}/probe`]);
    if(result?.text!=="Process transport 中文 😀"||result.windowLookupCount!==0)throw Error("Process network transport failed: "+JSON.stringify(result));
  }finally{await new Promise(resolve=>server.close(resolve));}
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/verify-mcp-native.mjs")) {
  const report = { runtime: "isolated Zotero 10; real Gecko listener", checks: [] };
  try {
    const fixture = await prepare(), token = await secret(); report.fixture = fixture;
    for (const [method, params] of [["initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "native-acceptance", version: "1" } }], ["tools/list", {}], ["tools/call", { name: "get_resource_content", arguments: { resourceId: fixture.resource } }]]) {
      const response = await rpc(token, method, params);
      if (response.status !== 200 || !response.contentType?.startsWith("text/event-stream") || !response.message.result) throw Error(JSON.stringify(response)); report.checks.push(`${method}: SSE`);
      if(method==="initialize"){
        const identity=response.message.result._meta?.["zotero-knowledge-mcp/identity"];
        if(identity?.applicationContract!=="2.4.0"||!/^[a-f0-9]{64}$/.test(identity.schemaFingerprint)||!/^[a-f0-9]{64}$/.test(identity.build?.sourceFingerprint))throw Error("Missing built implementation identity");
        report.identity=identity;
      }
    }
    const content = (await rpc(token, "tools/call", { name: "get_resource_content", arguments: { resourceId: fixture.resource } })).message.result.structuredContent;
    if (!content.contentMarkdown.includes("中文 😀")) throw Error("UTF-8 mismatch"); report.checks.push("UTF-8 content");
    const invoke=async(name,args)=>{
      const result=(await rpc(token,"tools/call",{name,arguments:args})).message.result;
      if(result?.isError||!result?.structuredContent)throw Error(JSON.stringify(result));return result.structuredContent;
    };
    const detail=(await invoke("get_resources",{resourceIds:[fixture.resource]})).items[0];
    if(detail.abstract!=="Native published abstract"||detail.summary!=="Native maintained summary"||detail.metadata?.doi!=="10.0000/native"||!detail.contributors.length||!detail.capabilities.content)throw Error("Native detail defaults incomplete");
    report.checks.push("bibliographic detail and current capabilities");
    const references=await invoke("list_references",{resourceId:fixture.resource,includeTotal:true});
    const noUrls=await invoke("list_references",{resourceId:fixture.resource,referenceType:"url",includeTotal:true});
    if(references.total!==1||noUrls.returnedCount!==0||noUrls.total!==0||!noUrls.structuredReferencesAvailable||noUrls.warnings.length)throw Error("Native reference type filter confused document availability");
    report.checks.push("empty reference type preserves document-wide availability");
    const notRequested=(await rpc(token,"tools/call",{name:"search_content",arguments:{scopeType:"authorized",query:"Synthetic",mode:"metadata",rerank:false,minScoreBasis:"rerank",minScore:0.5}})).message.result;
    if(!notRequested?.isError||notRequested.structuredContent?.error?.code!=="INVALID_ARGUMENT"||!notRequested.structuredContent.error.message.includes("reranking was not requested"))throw Error("Unrequested rerank threshold was not rejected");
    report.checks.push("unrequested rerank threshold rejected before retrieval");
    const whole=await invoke("get_resource_content",{resourceId:fixture.resource,maxChars:50000});
    const node=await invoke("get_resource_nodes",{nodeIds:[fixture.node],maxChars:50000});
    if(!whole.contentMarkdown.includes("NATIVE_SCIENTIFIC_FOOTNOTE")||whole.contentMarkdown.includes("NATIVE_REJECTED_CONTENT")||node.items[0].contentMarkdown!==whole.contentMarkdown||!whole.selection.originalNotesIncluded)throw Error("Native document/node content selection mismatch");
    report.checks.push("scientific footnotes preserved; rejected blocks excluded; node/document selection agrees");
    let cursor,blockText="",blockChars=0;
    do{
      const page=await invoke("get_content_blocks_text",{resourceId:fixture.resource,blockIds:[fixture.block],maxCharsPerBlock:10000,maxTotalChars:10000,responseMode:"compact",...(cursor?{cursors:{[fixture.block]:cursor}}:{})});
      const item=page.items[0];if(item.textOffset!==Array.from(blockText).length)throw Error("Native block offset mismatch");blockText+=item.contentMarkdown;blockChars=item.originalCharCount;cursor=item.nextCursor;
    }while(cursor);
    if(Array.from(blockText).length!==blockChars||!blockText.includes("native tail evidence."))throw Error("Native long block continuation lost text");
    report.checks.push("long Unicode block continuation to completion");
    const invalid=(await rpc(token,"tools/call",{name:"list_folders",arguments:{libraryId:fixture.library,includeFields:["unknownField"]}})).message.result;
    if(!invalid?.isError||invalid.structuredContent?.error?.code!=="INVALID_FIELD")throw Error("Empty result bypassed field validation");
    const rejected=(await rpc(token,"tools/call",{name:"add_annotation",arguments:{resourceId:fixture.resource,contentBlockId:fixture.rejected,annotationType:"evidence",text:"Rejected anchor",quote:"NATIVE_REJECTED_CONTENT",expectedVersion:content.resourceVersion,operationId:"rejected-native-note"}})).message.result;
    if(!rejected?.isError||rejected.structuredContent?.error?.code!=="INVALID_ARGUMENT")throw Error("Rejected anchor accepted");
    report.checks.push("empty field validation and rejected annotation anchor");
    for(const query of ["écologie","ecology"]){
      const result=(await rpc(token,"tools/call",{name:"search_content",arguments:{scopeType:"authorized",query,mode:"fulltext",snippetMaxChars:100}})).message.result?.structuredContent;
      if(result?.returnedCount!==1||!result.items[0].matches.some(match=>query==="écologie"?match.snippet.includes("ÉCOLOGIE"):match.snippet.includes("ＥＣＯＬＯＧＹ")))throw Error("Native Unicode evidence mismatch: "+JSON.stringify(result));
    }report.checks.push("Unicode normalized fulltext tail windows");
    const migrationCount=(await readdir(path.resolve("src/database/migrations"))).filter(name=>/^\d{4}-.+\.ts$/.test(name)).length;
    if(fixture.migrationCount!==migrationCount)throw Error("Native migration history differs from the current source");report.checks.push("current native migration history");
    await verifyProcessTransport();report.checks.push("real process network request with empty main-window lookup");
    const occupied=net.createServer();await new Promise((resolve,reject)=>{occupied.once("error",reject);occupied.listen(0,"127.0.0.1",resolve);});
    try{
      const port=occupied.address().port;
      await evaluate(`delete Zotero.__mcpPortResult;void Zotero.__knowledgeMCPAccess.configure(true,${port}).then(()=>Zotero.__mcpPortResult=Zotero.__knowledgeMCPAccess.snapshot())`);
      let state;for(let i=0;i<100;i++){state=JSON.parse(await evaluate("JSON.stringify(Zotero.__mcpPortResult??null)"));if(state)break;await wait(50);}
      if(state?.status!=="failed"||state?.error!=="PORT_UNAVAILABLE")throw Error("Occupied port was not reported");report.checks.push("occupied port rejected");
      await evaluate("delete Zotero.__mcpPortResult;void Zotero.__knowledgeMCPAccess.configure(true,23126).then(()=>Zotero.__mcpPortResult=Zotero.__knowledgeMCPAccess.snapshot())");
      for(let i=0;i<100;i++){state=JSON.parse(await evaluate("JSON.stringify(Zotero.__mcpPortResult??null)"));if(state)break;await wait(50);}
      if(state?.status!=="running")throw Error("Port recovery failed");report.checks.push("port reconfiguration");
    }finally{await new Promise(resolve=>occupied.close(resolve));}
    const noteText="Native annotation 😀 ".repeat(700).trim(),noteQuote=blockText.slice(0,6000);
    const noteArgs={resourceId:fixture.resource,contentBlockId:fixture.block,annotationType:"evidence",text:noteText,quote:noteQuote,expectedVersion:content.resourceVersion,operationId:"native-note-1"};
    const annotation=await invoke("add_annotation",noteArgs),replay=await invoke("add_annotation",noteArgs);
    if(!annotation.annotationId||!replay.replayed)throw Error("Native quoted annotation/replay failed");
    let text="",quote="",cursors,rounds=0;
    do{
      const response=await invoke("list_annotations",{resourceId:fixture.resource,annotationIds:[annotation.annotationId],textMaxChars:1000,maxTotalChars:1500,...(cursors?{cursors}:{})});
      const item=response.items[0];if(response.totalCharsReturned>1500)throw Error("Native annotation budget exceeded");text+=item.text;quote+=item.quote;
      cursors=item.nextCursor||item.quoteNextCursor?{[annotation.annotationId]:{text:item.nextCursor,quote:item.quoteNextCursor}}:undefined;
      if(++rounds>100)throw Error("Native annotation continuation did not finish");
    }while(cursors);
    if(text!==noteText||quote!==noteQuote)throw Error("Native annotation/quote text lost");
    report.checks.push("quoted annotation transaction/replay and complete budgeted text/quote reading");
    for(let cycle=0;cycle<2;cycle++){
      await evaluate(`delete Zotero.__mcpReload;void(async()=>{try{const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs"),addon=await AddonManager.getAddonByID("zotero-knowledge-mcp@local.dev");await addon.disable();const stopped=!Zotero.__knowledgeMCPAccess;await addon.enable();const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");for(let i=0;i<200&&!Zotero.__knowledgeMCPAccess;i++)await new Promise(resolve=>timer.setTimeout(resolve,50));Zotero.__mcpReload={stopped,status:Zotero.__knowledgeMCPAccess?.snapshot()};}catch(error){Zotero.__mcpReload={error:String(error)};}})()`);
      let state;
      for(let i=0;i<100;i++){state=JSON.parse(await evaluate("JSON.stringify(Zotero.__mcpReload??null)"));if(state)break;await wait(50);}
      if(!state?.stopped||state.status?.status!=="running")throw Error("Reload failed: "+JSON.stringify(state));
      const read=await rpc(token,"tools/call",{name:"get_resource_content",arguments:{resourceId:fixture.resource}});
      if(!read.message.result?.structuredContent?.contentMarkdown)throw Error("Reading after reload failed");report.checks.push("reload lifecycle "+(cycle+1));
    }
    try{
      await probeOperation("closeMainWindows");
      const read=(await rpc(token,"tools/call",{name:"get_resource_content",arguments:{resourceId:fixture.resource}})).message.result?.structuredContent;
      if(!read?.contentMarkdown?.includes("中文 😀"))throw Error("Reading with all main windows closed failed");
      let search;for(let attempt=0;attempt<100;attempt++){
        search=(await rpc(token,"tools/call",{name:"search_content",arguments:{scopeType:"authorized",query:"écologie",mode:"fulltext",snippetMaxChars:100}})).message.result?.structuredContent;
        if(search?.returnedCount===1||!["INDEX_UNAVAILABLE","CURSOR_STALE"].includes(search?.error?.code))break;await wait(100);
      }
      if(search?.returnedCount!==1)throw Error("Searching with all main windows closed failed: "+JSON.stringify(search));
      await verifyProcessTransport();report.checks.push("actual main-window closure: MCP reading, searching and process HTTP remain available");
    }finally{await probeOperation("restoreMainWindow");}
    if ((await rpc(token, "tools/list", {}, 1, { Origin: "https://invalid.example" })).status !== 403) throw Error("Origin accepted"); report.checks.push("Origin rejected");
    await evaluate("void Zotero.__knowledgeMCPAccess.revokeToken(Zotero.__mcpAcceptance.token.id).then(()=>Zotero.__mcpAcceptanceRevoked=true)");
    for (let i = 0; i < 50 && !await evaluate("Zotero.__mcpAcceptanceRevoked??false"); i++) await wait(50);
    if ((await rpc(token, "tools/list")).status !== 401) throw Error("Revoked token accepted"); report.checks.push("revocation enforced");
    report.status = "passed";
  } catch (error) { report.status = "failed"; report.error = String(error); process.exitCode = 1; }
  finally { try { await cleanup(); report.cleanup = "passed"; } catch (error) { report.cleanup = String(error); process.exitCode = 1; } }
  await fs.writeFile(path.join(folder, "native.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
