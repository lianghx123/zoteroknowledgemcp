// Developer-driven native comparison. Capture the old bundle and fixture first;
// see docs/development/retrieval-toggle-performance.md. No model calls are made.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";

const folder = path.resolve(".scaffold/retrieval-inline-diagnostic");
await fs.mkdir(folder, { recursive: true });
await build({ stdin: { contents: 'export { RetrievalResultList } from "./src/ui/knowledge/retrieval-results.ts";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true, format: "iife", globalName: "RetrievalCandidate", platform: "browser", target: "firefox140", loader: { ".css": "text" }, outfile: path.join(folder, "candidate.js") });
const urls = Object.fromEntries(["baseline", "candidate"].map(name => [name, pathToFileURL(path.join(folder, `${name}.js`)).href]));
const output = path.join(folder, process.argv[2] ?? "comparison.json");
await evaluate(`void(async()=>{
 const report={runtime:"native Zotero synchronous and forced-layout comparison; no paint timing",started:Date.now(),samples:[],providerCalls:0};
 if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated Zotero required");
 if(Zotero.startupError){report.status="failed";report.error="Restart isolated Zotero after its native fatal error";await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report));return;}
 const originalWindows=Zotero.getMainWindows(),originalRows=originalWindows.map(w=>w.ZoteroPane.itemsView.rowProvider._rows.map(r=>r.ref.id));
 const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs"),wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms));
 Zotero.openMainWindow();let w;
 for(let i=0;i<160;i++){w=Zotero.getMainWindows().find(candidate=>!originalWindows.includes(candidate));if(w?.document.readyState==="complete"&&w.ZoteroPane?.itemsView?.tree?._jsWindow&&w.document.getElementById("zotero-tb-search")?.searchModePopup?.querySelector("#km-search-fulltext"))break;await wait(100);}
 if(!w?.ZoteroPane?.itemsView?.rowProvider){report.status="failed";report.error="Isolated test window not ready";await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report));return;}
 const doc=w.document,v=w.ZoteroPane.itemsView,p=v.rowProvider,q=doc.getElementById("zotero-tb-search"),tree=v.tree;
 const saved={input:q.searchTextbox.value,mode:Zotero.Prefs.get("extensions.zotero.knowledgemcp.retrievalSelection",true),items:w.ZoteroPane.getSelectedItems().map(i=>i.id)};
 let adapter,active,modified=false;const restores=[];
 const assert=(value,label)=>{if(!value)throw Error(label);};
 try{
  assert(Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"),"Isolated Zotero required");
  report.windowHidden=doc.hidden;
  const fixture=JSON.parse(await IOUtils.readUTF8(${JSON.stringify(path.join(folder, "fixture.json"))}));
  const target=fixture.rows[0],hits=fixture.rows.map(row=>row.hit),snapshot={itemResources:new Map(fixture.rows.map(row=>[row.itemID,row.hit.resourceID])),resources:[],sources:[]};
  snapshot.sources=hits.flatMap(hit=>hit.evidence.map(e=>({id:e.sourceID,title:"Full Text PDF"})));
  report.fixture={documents:hits.length,evidence:hits.reduce((n,h)=>n+h.evidence.length,0),textCharacters:hits.reduce((n,h)=>n+h.evidence.reduce((m,e)=>m+e.text.length,0),0),query:fixture.query};
  Services.scriptloader.loadSubScript(${JSON.stringify(urls.baseline)});Services.scriptloader.loadSubScript(${JSON.stringify(urls.candidate)});
  q.searchModePopup.querySelector('[value="everything"]').dispatchEvent(new w.Event("command",{bubbles:true}));modified=true;await wait(250);q.searchTextbox.value="";await w.ZoteroPane.search(true);await wait(250);
  for(const [obj,key]of [[tree,"invalidate"],[tree,"updateCustomRowHeights"],[p,"runListeners"]]){const own=Object.getOwnPropertyDescriptor(obj,key),original=obj[key];obj[key]=function(...args){if(active)active.calls[key]=(active.calls[key]??0)+1;return Reflect.apply(original,this,args);};restores.push(()=>{if(own)Object.defineProperty(obj,key,own);else delete obj[key];});}
  for(let round=0;round<3;round++)for(const variant of round%2?["candidate","baseline"]:["baseline","candidate"]){
   const result={query:fixture.query,hits,threshold:.5},Class=variant==="baseline"?RetrievalBaseline.RetrievalResultList:RetrievalCandidate.RetrievalResultList;
   adapter=new Class(w,{snapshot},{},()=>result,()=>new Map(fixture.rows.map((row,i)=>[row.itemID,i])),()=>false);
   await v.refreshAndMaintainSelection();await v.selectItems([target.itemID]);await wait(250);
   for(let i=0;i<14;i++)for(const opening of [true,false]){
    // Both paths use the same window visibility and include a forced layout.
    const sample={variant,round,iteration:i,warmup:i<2,action:opening?"open":"close",calls:{},rowCountBefore:p._rows.length};active=sample;
    const start=w.performance.now();
    v.toggleOpenState(p._rows.findIndex(r=>r.ref.id===target.itemID));
    sample.syncMs=w.performance.now()-start;tree._jsWindow.innerElem.getBoundingClientRect();sample.layoutMs=w.performance.now()-start;await wait(40);active=undefined;
    sample.rowCountAfter=p._rows.length;
    assert(variant==="baseline"?p._rows.find(r=>r.ref.id===target.itemID).isOpen===opening:adapter.opened.has(target.hit.resourceID)===opening,"Toggle did not complete");
    report.samples.push(sample);
   }
   adapter.dispose();adapter=undefined;await v.refreshAndMaintainSelection();await wait(100);
  }
  assert(!Zotero.startupError,"Native fatal error during comparison");report.status="passed";
 }catch(error){report.status="failed";report.error=String(error);report.stack=error.stack;}
 finally{
  active=undefined;adapter?.dispose();for(const restore of restores.reverse())restore();
  try{if(modified){await v.refreshAndMaintainSelection();q.searchTextbox.value=saved.input;Zotero.Prefs.set("extensions.zotero.knowledgemcp.retrievalSelection",saved.mode??"",true);}}
  catch(error){report.status="failed";report.restoreError=String(error);}
  w.close();report.originalWindowRows={before:originalRows,after:originalWindows.map(window=>window.closed?null:window.ZoteroPane.itemsView.rowProvider._rows.map(r=>r.ref.id))};
  report.originalWindowsUnchanged=originalWindows.every((window,i)=>!window.closed&&JSON.stringify(window.ZoteroPane.itemsView.rowProvider._rows.map(r=>r.ref.id))===JSON.stringify(originalRows[i]));
  if(!report.originalWindowsUnchanged){report.status="failed";report.restoreError="Original window rows changed";}
  report.finished=Date.now();await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));
 }
})()`);
console.log(`Dispatched native comparison; read ${output}`);
