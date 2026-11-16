// Developer-only native idle/repaint/expansion probe. Never use against a production library.
import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { evaluate } from "./verify-vector-native.mjs";
const [action = "sample", label = "baseline", reference = ".scaffold/build/zotero-knowledge-mcp.xpi", mode = "plain", durationText = "16000"] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(label)) throw Error("Invalid label.");
const folder = path.resolve(".scaffold/idle-refresh-diagnostic"), archive = path.join(folder, `${label}-probe.xpi`), output = path.join(folder, `${label}-${mode}.json`);
await fs.mkdir(folder, { recursive: true });
if (action === "prepare") {
  const zip = new AdmZip(path.resolve(reference)), anchor = "return __toCommonJS(index_exports);";
  let main = zip.readAsText("content/main.js"); if (!main.includes(anchor)) throw Error("Unexpected bundle.");
  main = main.replace(anchor, `
const idleOriginalStart=PluginApplication.prototype.start;
PluginApplication.prototype.start=async function(...args){await idleOriginalStart.apply(this,args);Zotero.__idleRefreshApp=this;};
for(const [type,method,key]of [[ZoteroConnection,"executeQuery","queries"],[KnowledgeLibraryTree,"refresh","knowledgeTreeRefresh"],[ImportTasksView,"render","taskRender"],[KnowledgeLibraryService,"reconcile","metadataReconcile"],[EmbeddingService,"refreshTasks","embeddingProjection"],[VectorStore,"sync","indexSync"],[ModelGateway,"embed","embeddingCalls"],[ModelGateway,"rerank","rerankCalls"]]){
 const original=type.prototype[method];type.prototype[method]=function(...args){const s=Zotero.__idleRefreshCapture;if(s){s[key]=(s[key]??0)+1;if(key==="queries"&&/^\\s*(insert|update|delete|replace)\\b/i.test(args[0]?.sql??""))s.writeQueries=(s.writeQueries??0)+1;}return Reflect.apply(original,this,args);};
}
` + anchor);
  zip.updateFile("content/main.js", Buffer.from(main)); zip.writeZip(archive); console.log(archive);
} else if (action === "install") {
  await evaluate(`void(async()=>{if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");delete Zotero.__idleRefreshApp;const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");const previous=await AddonManager.getAddonByID("zotero-knowledge-mcp@local.dev");if(previous?.temporarilyInstalled)await previous.uninstall();const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(archive)});await(await AddonManager.getInstallForFile(file)).install();})()`);
} else if (action === "state") {
  console.log(await evaluate(`JSON.stringify({pid:Services.appinfo.processID,probe:!!Zotero.__idleRefreshApp,ready:Zotero.__knowledgeMCPRetrieval?.startup?.().state==="ready"})`));
} else if (action === "sample") {
  if (!["plain", "evidence", "native"].includes(mode)) throw Error("Unsupported mode.");
  const duration = Number(durationText); if (!Number.isFinite(duration) || duration < 2000 || duration > 60000) throw Error("Invalid duration.");
  await fs.rm(output, { force: true });
  await evaluate(`void(async()=>{const report={label:${JSON.stringify(label)},mode:${JSON.stringify(mode)},runtime:"Zotero native DOM; local fulltext; no model requests"},restores=[];
 const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs"),wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms));
 const wrap=(object,key,name)=>{const original=object[key];if(typeof original!=="function")return;object[key]=function(...args){const s=Zotero.__idleRefreshCapture;if(s)s[name]=(s[name]??0)+1;return Reflect.apply(original,this,args);};restores.push(()=>{object[key]=original;});};
 try{
  if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated library required");
  const app=Zotero.__idleRefreshApp,w=Zotero.getMainWindows()[0],v=w.ZoteroPane.itemsView;
  if(!app||app.recovery.snapshot().state!=="ready")throw Error("Probe application not ready");
  const search=app.retrievalUI.windows.get(w);await search.select(undefined);w.document.getElementById("zotero-tb-search").searchTextbox.value="";await w.ZoteroPane.search(true);
  await w.ZoteroPane.collectionsView.selectByID(${JSON.stringify(mode === "native" ? "L1" : "Kknowledgemcp:overview")});
  await w.ZoteroPane.search(true);
  if(${JSON.stringify(mode)}==="evidence"){await search.select("fulltext");w.document.getElementById("zotero-tb-search").searchTextbox.value="研究";await search.submit();}
  await wait(500);
  const previewButton=${JSON.stringify(mode)}==="evidence"&&w.document.querySelector(".km-inline-result .twisty");
  const position=v.rowProvider._rows.findIndex(r=>r.isObjectRow&&(previewButton||r.isContainer?.()&&!r.isContainerEmpty?.()));if(position<0)throw Error("Expandable fixture row missing");
  const ref=v.rowProvider._rows[position].ref.id;if(previewButton)previewButton.dispatchEvent(new w.MouseEvent("mouseup",{bubbles:true}));else if(!v.rowProvider._rows[position].isOpen)await v.toggleOpenState(position);await wait(50);
  const state=()=>{if(previewButton)return !!w.document.querySelector(".km-inline-evidence");const r=v.rowProvider._rows.find(r=>r.isObjectRow&&r.ref.id===ref);return r?!!r.isOpen:null;};if(state()!==true)throw Error("Fixture did not expand");
  wrap(v,"refreshAndMaintainSelection","itemRefresh");wrap(v,"refresh","itemReload");wrap(v.rowProvider,"_sort","itemSort");wrap(v.tree,"invalidate","itemInvalidate");wrap(v.tree,"updateCustomRowHeights","rowHeightUpdate");wrap(v,"forceUpdate","itemForceUpdate");wrap(v.tree,"toggleOpenState","treeToggle");wrap(v.rowProvider,"_toggleOpenState","providerToggle");wrap(v.rowProvider,"_refresh","providerReload");wrap(v.rowProvider,"setCollectionTreeRows","setScope");wrap(v.rowProvider,"refreshRowMap","rowMap");
  const stats=Zotero.__idleRefreshCapture={};report.started=Date.now();report.pid=Services.appinfo.processID;report.transitions=[];report.interactions=[];let previous=state();const lags=[];
  for(const type of ["pointerdown","keydown","command"]){const listen=event=>{report.interactions.push({type,at:Date.now()-report.started,trusted:event.isTrusted});};w.addEventListener(type,listen,true);restores.push(()=>w.removeEventListener(type,listen,true));}
  const observer=new w.MutationObserver(records=>{stats.itemMutations=(stats.itemMutations??0)+records.length;});observer.observe(w.document.getElementById("zotero-items-tree")??w.document.getElementById("zotero-items-pane"),{subtree:true,childList:true});restores.push(()=>observer.disconnect());
  while(Date.now()-report.started<${duration}){const t=Date.now();await wait(50);lags.push(Math.max(0,Date.now()-t-50));const value=state();if(value!==previous){report.transitions.push({at:Date.now()-report.started,open:value,scope:v.collectionTreeRows.map(r=>r.id)});previous=value;}}
  report.elapsedMs=Date.now()-report.started;report.finalOpen=state();report.counts={...stats};lags.sort((a,b)=>a-b);report.timerLagMs={p50:lags[Math.floor(lags.length*.5)],p95:lags[Math.floor(lags.length*.95)],max:lags.at(-1),samples:lags.length};report.status="passed";
 }catch(e){report.status="failed";report.error=String(e);report.stack=e?.stack;}finally{delete Zotero.__idleRefreshCapture;for(const restore of restores.reverse())restore();await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));}})()`);
  console.log(output);
} else throw Error("Use prepare, install or sample.");
