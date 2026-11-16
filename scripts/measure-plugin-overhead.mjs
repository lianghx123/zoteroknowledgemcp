// Developer-driven native measurements in a disposable copy of an isolated library.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import { evaluate } from "./verify-vector-native.mjs";

const action = process.argv[2] ?? "state";
const label = process.argv[3] ?? "preflight";
export const folder = path.resolve(process.env.ZOTERO_OVERHEAD_DIR ?? ".scaffold/plugin-overhead-20261029");
const port = Number(process.env.ZOTERO_DEBUG_PORT ?? 4792);
const pluginID = "zotero-knowledge-mcp@local.dev";
const monitorID = "runtime-overhead-probe@local.dev";
const logfile = path.join(folder, "startup.jsonl");
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const remote = source => evaluate(`(()=>{const {Zotero}=ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs");return eval(${JSON.stringify(source)});})()`, port);

async function dispatch(name, body) {
  if (!/^[a-z0-9-]+$/.test(name)) throw Error("Invalid result name.");
  const output = path.join(folder, `${name}.json`);
  await fs.rm(output, { force: true });
  await remote(`void(async()=>{const result={};try{
    if(Zotero.DataDirectory.dir!==${JSON.stringify(path.join(folder, "data"))})throw Error("Benchmark copy required");
    const timers=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const wait=ms=>new Promise(resolve=>timers.setTimeout(resolve,ms));
    const w=Zotero.getMainWindows().find(w=>!w.closed),pane=w.ZoteroPane;
    ${body}
    result.status="passed";
  }catch(e){result.status="failed";result.error=String(e);result.stack=e?.stack;}
  await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(result,null,2));})()`);
  for (let i = 0; i < 1200; i++) {
    try {
      const result = JSON.parse(await fs.readFile(output, "utf8"));
      if (result.status !== "passed") throw Error(`${result.error}; see ${output}`);
      console.log(JSON.stringify(result));
      return result;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    await wait(100);
  }
  throw Error(`Timed out waiting for ${name}`);
}

if (action === "prepare") {
  await fs.mkdir(folder, { recursive: true });
  const xpi = path.resolve(".scaffold/build/zotero-knowledge-mcp.xpi");
  const bytes = await fs.readFile(xpi);
  await fs.writeFile(path.join(folder, "plugin.xpi"), bytes);
  const zip = new AdmZip();
  zip.addFile("manifest.json", Buffer.from(JSON.stringify({
    manifest_version: 2, name: "Isolated runtime measurement probe", version: "1.0.0",
    applications: { zotero: { id: monitorID, strict_min_version: "10.0", strict_max_version: "10.0.*", update_url: "https://example.invalid/isolated-probe.json" } },
  })));
  zip.addFile("bootstrap.js", Buffer.from(`
var timer, closed=false;
function log(event,data={}){
 const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(${JSON.stringify(logfile)});
 const s=Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);s.init(file,0x02|0x08|0x10,0o600,0);
 const bytes=new TextEncoder().encode(JSON.stringify({event,at:Date.now(),pid:Services.appinfo.processID,...data})+"\\n");
 try{s.write(String.fromCharCode(...bytes),bytes.length);}finally{s.close();}
}
function startup(){
 if(Zotero.DataDirectory.dir!==${JSON.stringify(path.join(folder, "data"))})throw Error("Benchmark copy required");
 const timers=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
 log("monitor-start");
 Zotero.uiReadyPromise.then(()=>{
  if(closed)return;log("ui-ready");
  const inspect=()=>{
   if(closed)return;const w=Zotero.getMainWindows().find(w=>!w.closed);
   if(w?.ZoteroPane?.loaded&&w.document.readyState==="complete"&&w.ZoteroPane.itemsView?.rowProvider?.rowCount>0){
    log("native-list-ready",{rows:w.ZoteroPane.itemsView.rowProvider.rowCount,startup:Services.startup.getStartupInfo()});
   }else timer=timers.setTimeout(inspect,10);
  };inspect();
 });
}
function shutdown(){closed=true;ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").clearTimeout(timer);}
function install(){}function uninstall(){}
`));
  zip.writeZip(path.join(folder, "monitor.xpi"));
  await fs.writeFile(path.join(folder, "artifact.json"), JSON.stringify({
    capturedAt: new Date().toISOString(), pluginBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    node: process.version, monitorID, folder,
  }, null, 2));
  console.log("Prepared frozen production package and condition-independent startup monitor.");
} else if (action === "watch-startup") {
  const output=path.join(folder,`${label}-early-startup.json`);
  let attached=false;
  for(let attempt=0;attempt<400;attempt++){
    try{
      await remote(`(()=>{
        if(Zotero.DataDirectory.dir!==${JSON.stringify(path.join(folder,"data"))})throw Error("Benchmark copy required");
        const timers=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs"),probe={attached:Date.now(),pid:Services.appinfo.processID};
        const inspect=()=>{
          const w=Zotero.getMainWindows().find(w=>!w.closed);
          if(w&&!probe.windowSeen)probe.windowSeen=Date.now();
          if(w?.ZoteroPane?.loaded&&!probe.paneLoaded)probe.paneLoaded=Date.now();
          if(w?.ZoteroPane?.loaded&&w.document.readyState==="complete"&&w.ZoteroPane.itemsView?.rowProvider?.rowCount>0){
            probe.nativeListReady=Date.now();probe.rows=w.ZoteroPane.itemsView.rowProvider.rowCount;probe.startup=Services.startup.getStartupInfo();
            void IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(probe,null,2));
          }else timers.setTimeout(inspect,10);
        };inspect();return "attached";
      })()`);
      attached=true;break;
    }catch{await wait(25);}
  }
  if(!attached)throw Error("Could not attach startup observer");
  console.log("Startup observer attached.");
} else if (action === "state") {
  console.log(await remote(`JSON.stringify({pid:Services.appinfo.processID,data:Zotero.DataDirectory.dir,
    ready:!!Zotero.getMainWindows()[0]?.ZoteroPane?.loaded,
    plugin:!!Zotero.__knowledgeMCPBootstrapActive,index:Zotero.__knowledgeMCPRetrieval?.status(),
    recovery:Zotero.__knowledgeMCPRetrieval?.startup?.(),
    nativeRows:Zotero.getMainWindows()[0]?.ZoteroPane?.itemsView?.rowProvider?.rowCount,
    hidden:Zotero.getMainWindows()[0]?.document.hidden})`));
} else if (action === "setup") {
  await dispatch("setup", `
    const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    for(const filePath of ${JSON.stringify([path.join(folder, "plugin.xpi"), path.join(folder, "monitor.xpi")])}){
      result.installing=filePath;
      const file=Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);file.initWithPath(filePath);
      for(let attempt=0;;attempt++){
        const install=await AddonManager.getInstallForFile(file);
        try{await install.install();break;}
        catch(error){result.installError=install.error;if(attempt>=2)throw error;await wait(1000);}
      }
    }
    const q=w.document.getElementById("zotero-tb-search");
    Services.prefs.setBoolPref("extensions.update.enabled",false);
    q.searchModePopup.querySelector('[value="titleCreatorYear"]').dispatchEvent(new w.Event("command",{bubbles:true}));
    q.searchTextbox.value="";await pane.search(true);await pane.collectionsView.selectByID("L1");
    for(const row of [...pane.itemsView.rowProvider._rows].reverse())if(row.isOpen)await pane.itemsView.toggleOpenState(pane.itemsView.rowProvider._rows.indexOf(row));
    Services.prefs.savePrefFile(null);result.rows=pane.itemsView.rowProvider.rowCount;
    result.addons=(await AddonManager.getAllAddons()).map(a=>({id:a.id,version:a.version,active:a.isActive,userDisabled:a.userDisabled}));
  `);
} else if (action === "condition") {
  if (!["enabled", "disabled"].includes(label)) throw Error("Use enabled or disabled.");
  await dispatch("condition", `
    const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon=await AddonManager.getAddonByID(${JSON.stringify(pluginID)});
    await addon.${label === "enabled" ? "enable" : "disable"}();
    Services.prefs.savePrefFile(null);result.userDisabled=addon.userDisabled;result.active=addon.isActive;
  `);
} else if (action === "close") {
  console.log(await remote(`(()=>{if(Zotero.DataDirectory.dir!==${JSON.stringify(path.join(folder, "data"))})throw Error("Benchmark copy required");ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs").setTimeout(()=>Zotero.getMainWindows()[0].close(),100);return "closing";})()`));
} else if (action === "facts") {
  await dispatch("facts", `
    const db=Zotero.__knowledgeMCPAccess?.tokens.db;if(!db)throw Error("Enabled plugin connection required");
    result.counts={};for(const table of ["knowledge_resources","content_blocks","block_embeddings","vector_index_entries"])
      result.counts[table]=Number((await db.selectFrom(table).select(eb=>eb.fn.countAll().as("n")).executeTakeFirst()).n);
    result.jobs=(await db.selectFrom("processing_jobs").select(["kind","state",eb=>eb.fn.countAll().as("n")]).groupBy(["kind","state"]).execute()).map(r=>({kind:r.kind,state:r.state,n:Number(r.n)}));
    result.indexes=(await db.selectFrom("search_index_builds").select(["kind","state",eb=>eb.fn.countAll().as("n")]).groupBy(["kind","state"]).execute()).map(r=>({kind:r.kind,state:r.state,n:Number(r.n)}));
    result.version=Zotero.version;result.gecko=Services.appinfo.platformVersion;
    result.topLevelItems=(await Zotero.Items.getAll(Zotero.Libraries.userLibraryID,true,false)).length;
    result.collections=Zotero.Collections.getByLibrary(Zotero.Libraries.userLibraryID).map(c=>({id:c.id,parent:c.parentID}));
    const {AddonManager}=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    result.addons=(await AddonManager.getAllAddons()).map(a=>({id:a.id,version:a.version,active:a.isActive,userDisabled:a.userDisabled}));
    result.pid=Services.appinfo.processID;
    result.index=Zotero.__knowledgeMCPRetrieval?.status();result.recovery=Zotero.__knowledgeMCPRetrieval?.startup?.();
  `);
} else if (action === "operations") {
  await dispatch(label, `
    const q=w.document.getElementById("zotero-tb-search"),v=pane.itemsView;
    q.searchModePopup.querySelector('[value="titleCreatorYear"]').dispatchEvent(new w.Event("command",{bubbles:true}));
    q.searchTextbox.value="";await pane.search(true);await pane.collectionsView.selectByID("L1");
    w.maximize();w.focus();await wait(300);
    if(w.document.hidden)throw Error("Foreground native window required");
    result.rows=v.rowProvider.rowCount;result.hidden=w.document.hidden;result.samples=[];
    const ids=v.rowProvider._rows.filter(r=>r.ref.isRegularItem?.()).map(r=>r.ref.id);
    const target=v.rowProvider._rows.find(r=>r.isContainer?.()&&!r.isContainerEmpty?.());
    if(ids.length<2||!target)throw Error("Native operation fixtures missing");
    const targetID=target.ref.id;
    const measure=async(operation,iteration,run,check)=>{
      if(w.document.hidden)throw Error("Window became hidden");
      const start=w.performance.now();await run();
      const handlerMs=w.performance.now()-start;
      v.tree._jsWindow.innerElem.getBoundingClientRect();
      const layoutMs=w.performance.now()-start;
      if(check&&!check())throw Error("Operation did not complete: "+operation);
      result.samples.push({operation,iteration,warmup:iteration<2,handlerMs,layoutMs,rows:v.rowProvider.rowCount});
      await wait(50);
    };
    for(let i=0;i<10;i++){
      await measure("collection-open",i,()=>pane.collectionsView.selectByID("C1"),()=>pane.getCollectionTreeRow().id==="C1");
      await measure("library-open",i,()=>pane.collectionsView.selectByID("L1"),()=>pane.getCollectionTreeRow().id==="L1");
      await measure("search",i,async()=>{q.searchTextbox.value="Bank";await pane.search(true);},()=>v.rowProvider.rowCount>0&&v.rowProvider.rowCount<result.rows);
      await measure("search-clear",i,async()=>{q.searchTextbox.value="";await pane.search(true);},()=>v.rowProvider.rowCount===result.rows);
      let index=v.rowProvider._rows.findIndex(r=>r.ref.id===targetID);
      if(v.rowProvider._rows[index].isOpen)await v.toggleOpenState(index);
      await measure("attachment-expand",i,()=>v.toggleOpenState(v.rowProvider._rows.findIndex(r=>r.ref.id===targetID)),()=>v.rowProvider._rows.find(r=>r.ref.id===targetID).isOpen);
      await measure("attachment-collapse",i,()=>v.toggleOpenState(v.rowProvider._rows.findIndex(r=>r.ref.id===targetID)),()=>!v.rowProvider._rows.find(r=>r.ref.id===targetID).isOpen);
      await measure("item-select",i,()=>v.selectItems([ids[i%2]]),()=>pane.getSelectedItems()[0]?.id===ids[i%2]);
      await measure("list-refresh",i,()=>v.refreshAndMaintainSelection(),()=>v.rowProvider.rowCount===result.rows);
    }
    q.searchTextbox.value="";await pane.search(true);await pane.collectionsView.selectByID("L1");
    v.selection.clearSelection();await pane.itemSelected();
    result.recovery=Zotero.__knowledgeMCPRetrieval?.startup?.();
    result.index=Zotero.__knowledgeMCPRetrieval?.status();
  `);
} else if (action === "idle-start") {
  await dispatch(label, `
    const q=w.document.getElementById("zotero-tb-search");q.searchTextbox.value="";await pane.search(true);
    await pane.collectionsView.selectByID("L1");pane.itemsView.selection.clearSelection();await pane.itemSelected();
    w.maximize();w.focus();await wait(300);
    if(w.document.hidden)throw Error("Visible native library required");
    const probe={started:Date.now(),input:0,delays:[],stopped:false};Zotero.__overheadIdle=probe;
    const listener=()=>probe.input++;
    for(const event of ["keydown","mousedown","wheel"])w.addEventListener(event,listener,true);
    let due=w.performance.now()+100;
    const tick=()=>{if(probe.stopped)return;const now=w.performance.now();probe.delays.push(Math.max(0,now-due));due=now+100;probe.timer=timers.setTimeout(tick,100);};
    probe.timer=timers.setTimeout(tick,100);
    probe.finish=()=>{probe.stopped=true;timers.clearTimeout(probe.timer);for(const event of ["keydown","mousedown","wheel"])w.removeEventListener(event,listener,true);};
    result.pid=Services.appinfo.processID;result.started=probe.started;result.rows=pane.itemsView.rowProvider.rowCount;
  `);
} else if (action === "idle-end") {
  await dispatch(label, `
    const probe=Zotero.__overheadIdle;if(!probe)throw Error("Idle observation missing");probe.finish();
    Object.assign(result,{started:probe.started,finished:Date.now(),input:probe.input,delays:probe.delays,hidden:w.document.hidden,rows:pane.itemsView.rowProvider.rowCount,index:Zotero.__knowledgeMCPRetrieval?.status()});
    delete Zotero.__overheadIdle;if(result.input)throw Error("Input occurred during idle observation");
    if(result.hidden)throw Error("Native window hidden during observation");
  `);
} else {
  throw Error("Unknown measurement action.");
}
