// Developer-driven native checks in a disposable window; no provider calls.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";

const folder = path.resolve(".scaffold/retrieval-inline-diagnostic");
await fs.mkdir(folder, { recursive: true });
const probe = path.join(folder, "inline-ui.js"), output = path.join(folder, "native-ui.json");
await build({ stdin: { contents: 'export { RetrievalResultList } from "./src/ui/knowledge/retrieval-results.ts";', resolveDir: process.cwd(), loader: "ts" }, bundle: true,
  format: "iife", globalName: "InlineProbe", platform: "browser", target: "firefox140", loader: { ".css": "text" }, outfile: probe });
const url = pathToFileURL(probe).href;
await evaluate(`void(async()=>{
 const report={runtime:"native inline retrieval; disposable window",started:Date.now(),checks:[],providerCalls:0};
 const timer=ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs"),wait=ms=>new Promise(resolve=>timer.setTimeout(resolve,ms));
 const assert=(value,label)=>{if(!value)throw Error(label);report.checks.push(label);};
 const until=async fn=>{for(let i=0;i<160;i++){if(await fn())return;await wait(100);}throw Error("Inline UI timeout");};
 let w,restoreReader;const original=Zotero.getMainWindows(),originalRows=original.map(w=>w.ZoteroPane.itemsView.rowProvider._rows.map(r=>r.ref.id));
 const savedMode=Zotero.Prefs.get("extensions.zotero.knowledgemcp.retrievalSelection",true);
 try{
  if(!Zotero.DataDirectory.dir.replaceAll("\\\\","/").includes("/.scaffold/"))throw Error("Isolated Zotero required");
  if(Zotero.startupError)throw Error("Restart Zotero after native fatal error");
  report.stage="open-window";Zotero.openMainWindow();await until(()=>{w=Zotero.getMainWindows().find(candidate=>!original.includes(candidate));return w?.ZoteroPane?.itemsView?.rowProvider&&w.document.getElementById("zotero-tb-search")?.searchModePopup?.querySelector("#km-search-fulltext");});
  report.stage="host-ready";await until(()=>w.document.readyState==="complete"&&w.ZoteroPane.collectionsView._rows.some(row=>row.id==="Kknowledgemcp:overview"));await wait(300);
  const doc=w.document,pane=w.ZoteroPane,v=pane.itemsView,p=v.rowProvider,q=doc.getElementById("zotero-tb-search"),tree=v.tree;
  report.stage="select-scope";await pane.collectionsView.selectWait(pane.collectionsView._rows.findIndex(r=>r.id==="Kknowledgemcp:overview"));await pane.onCollectionSelected();await until(()=>v.collectionTreeRows.some(r=>r.id==="Kknowledgemcp:overview")&&p._rows.some(r=>r.isObjectRow));
  const ids=()=>p._rows.filter(r=>r.isObjectRow&&(r.level??0)===0).map(r=>r.ref.id).sort(),scopeIDs=ids();report.scopeDocumentCount=scopeIDs.length;
  report.stage="search";q.searchModePopup.querySelector("#km-search-fulltext").dispatchEvent(new w.Event("command",{bubbles:true}));await wait(200);
  q.searchTextbox.value="liquidity";q.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,composed:true}));
  await until(()=>doc.querySelector(".km-inline-result .twisty")&&!q.searchTextbox.hasAttribute("aria-busy"));
  const first=p._rows[0],item=first.ref;await v.selectItems([item.id]);await wait(100);
  const rowNode=()=>doc.getElementById(v.id+"-row-0"),arrow=()=>rowNode().querySelector(".km-inline-result .twisty"),beforeIDs=JSON.stringify(ids());
  const toggle=()=>{arrow().dispatchEvent(new w.MouseEvent("mousedown",{bubbles:true}));arrow().dispatchEvent(new w.MouseEvent("mouseup",{bubbles:true}));};
  const fixtures=p._rows.slice(0,2).map((row,i)=>({itemID:row.ref.id,hit:{resourceID:doc.getElementById(v.id+"-row-"+i).dataset.kmResourceId,title:row.ref.getDisplayTitle(),score:i?.2:.8,scoreType:"cosine",parsed:true,embedded:true,metadataOnly:false,
   evidence:[{blockID:"b"+i,sourceID:"s"+i,generationID:"g",section:"Results",page:2,text:"liquidity "+"Original evidence. ".repeat(80),channel:"fulltext",score:1,scoreType:"fts"}],relevance:{basis:"cosine",group:i?"possible":"matched",score:i?.2:.8}}}));
  assert(arrow().classList.contains("icon-twisty")&&!arrow().textContent,"original-native-icon-without-text-glyph");
  let full=0,heightWrites=0,rowPaints=0;const invalidate=tree.invalidate,update=tree.updateCustomRowHeights,paint=tree.invalidateRow;
  tree.invalidate=function(...args){full++;return Reflect.apply(invalidate,this,args);};tree.updateCustomRowHeights=function(...args){heightWrites++;return Reflect.apply(update,this,args);};tree.invalidateRow=function(...args){rowPaints++;return Reflect.apply(paint,this,args);};
  try{
   toggle();assert(first.isOpen&&rowNode().getAttribute("aria-expanded")==="true","native-arrow-opens-inline-evidence-once");
   const body=rowNode().querySelector(".km-inline-evidence"),panel=body.querySelector(".km-retrieval-panel"),card=panel.querySelector("details"),rect=body.getBoundingClientRect(),rowRect=rowNode().getBoundingClientRect();
   assert(rect.height===224&&rect.top>=rowRect.top+26&&rect.bottom<=rowRect.bottom+1,"evidence-fits-expanded-native-row");
   const following=doc.getElementById(v.id+"-row-1");assert(!following||following.getBoundingClientRect().top>=rect.bottom-1,"following-row-moves-below-evidence");
   assert(JSON.stringify(ids())===beforeIDs&&p._rows.every(r=>typeof r.ref.isAnnotation==="function"),"row-count-and-native-references-remain-intact");
   assert(card.open&&panel.querySelector("mark"),"first-passage-open-and-literal-highlights");
   const height=rowNode().style.height,writes=heightWrites;card.open=false;await wait(80);assert(rowNode().style.height===height&&heightWrites===writes,"passage-folding-does-not-update-outer-heights");
   toggle();assert(!first.isOpen&&!rowNode().querySelector(".km-inline-evidence"),"native-arrow-collapses-inline-evidence");
   toggle();assert(rowNode().querySelector(".km-retrieval-panel")===panel&&!card.open,"cached-evidence-and-disclosure-state-survive");
   assert(full===0&&heightWrites===3&&rowPaints===3,"three-toggles-update-only-target-row-without-list-invalidation");
   assert(!doc.querySelector(".km-evidence-preview"),"no-popup-or-dialog-created");
   const source=panel.querySelector("a.km-evidence-source");assert(source&&w.getComputedStyle(source).textDecorationLine.includes("underline"),"source-link-visible-and-underlined");
   const reader=Zotero.Reader.open;let opened;restoreReader=()=>{Zotero.Reader.open=reader;};Zotero.Reader.open=async(id,location)=>{opened={id,location};};source.click();await until(()=>opened);
   assert(typeof opened.id==="number"&&Number.isInteger(opened.location?.pageIndex),"source-link-resolves-native-attachment-and-page");restoreReader();restoreReader=undefined;
  }finally{tree.invalidate=invalidate;tree.updateCustomRowHeights=update;tree.invalidateRow=paint;}
  v.toggleOpenState(0);assert(!first.isOpen,"native-toggle-command-closes-evidence");v.toggleOpenState(0);assert(first.isOpen,"native-toggle-command-opens-evidence");
  await v.sort();await wait(100);assert(p._rows.every(r=>typeof r.ref.isAnnotation==="function"),"sort-retains-only-native-items");
  q.searchTextbox.value="zqvpxunfindable795124";q.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,composed:true}));await until(()=>!q.searchTextbox.hasAttribute("aria-busy"));await wait(100);assert(p._rows.length===0,"unmatched-query-is-empty");
  q.searchTextbox.value="";q.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,composed:true}));await wait(250);
  assert(JSON.stringify(ids())===JSON.stringify(scopeIDs),"clearing-restores-every-scope-document");assert(!doc.querySelector(".km-inline-evidence,.km-relevance-note,.km-inline-result .twisty"),"clearing-removes-inline-ui");
  const index=p._rows.findIndex(r=>r.ref.id===item.id);if(p.isContainerOpen(index))v.toggleOpenState(index);v.toggleOpenState(index);await wait(100);assert(p._rows.some(r=>(r.level??0)>0),"ordinary-native-attachments-expand-again");v.toggleOpenState(index);
  Services.scriptloader.loadSubScript(${JSON.stringify(url)});
  let fixture={query:"liquidity",hits:fixtures.map(row=>row.hit)};const snapshot={itemResources:new Map(fixtures.map(row=>[row.itemID,row.hit.resourceID])),resources:[],sources:[{id:"s0",title:"Fixture PDF"}]};
  const adapter=new InlineProbe.RetrievalResultList(w,{snapshot},{},()=>fixture,()=>new Map(fixtures.map((row,i)=>[row.itemID,i])),()=>false);
  try{
   await v.refreshAndMaintainSelection();await wait(100);
   const note=doc.querySelector(".km-relevance-note");assert(p._rows.length===2&&note&&!note.closest(".cell"),"possible-notice-occupies-separate-line-outside-title");
   const owner=note.closest(".row"),title=owner.querySelector(".cell-text");assert(note.getBoundingClientRect().bottom<=title.getBoundingClientRect().top+1,"possible-notice-sits-above-document-title");
   assert(!owner.querySelector(".cell.title .km-relevance-note"),"document-title-cell-is-not-polluted");
   for(let i=0;i<p._rows.length;i++){v.selection.select(i);await wait(100);assert(v.getSelectedObjects().every(ref=>typeof ref.isAnnotation==="function"),"programmatic-selection-native-item-"+i);}
   fixture={...fixture,hits:fixture.hits.map(hit=>({...hit,relevance:{basis:"cosine",group:"possible",score:.2}}))};await v.refreshAndMaintainSelection();await wait(100);
   assert(p._rows.length===2&&doc.querySelectorAll(".km-relevance-note").length===1,"all-below-has-one-note-with-no-extra-model-row");
   v.selection.selectAll();await wait(100);assert(v.getSelectedObjects().every(ref=>typeof ref.isAnnotation==="function"),"select-all-never-passes-display-references");
  }finally{fixture=undefined;adapter.dispose();await v.refreshAndMaintainSelection();}
  assert(JSON.stringify(ids())===JSON.stringify(scopeIDs),"fixture-cleanup-restores-every-document");
  q.searchModePopup.querySelector("#km-search-fulltext").dispatchEvent(new w.Event("command",{bubbles:true}));await wait(100);q.searchTextbox.value="1";q.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,composed:true}));
  await until(()=>doc.querySelector(".km-inline-result .twisty")&&!q.searchTextbox.hasAttribute("aria-busy"));
  w.resizeTo(1000,520);await wait(150);for(let i=0;i<Math.min(3,p._rows.length);i++)if(!p._rows[i].isOpen)v.toggleOpenState(i);
  await wait(80);let list=tree._jsWindow;
  const checkCoverage=label=>{
   const top=list.targetElement.scrollTop,bottom=top+list.getWindowHeight();
   const expected=p._rows.map((_,i)=>i).filter(i=>list._getItemPosition(i)<bottom&&list._getItemPosition(i+1)>top);
   assert(expected.length>0&&expected.every(i=>list._renderedRows.has(i)),label);
   for(const i of expected){const node=list._renderedRows.get(i);assert(Math.abs(parseFloat(node.style.top)-list._getItemPosition(i))<1,label+"-position-"+i);if(p._rows[i].isOpen)assert(!!node.querySelector(".km-inline-evidence"),label+"-evidence-"+i);}
  };
  const maximum=Math.max(0,list.innerElem.scrollHeight-list.targetElement.clientHeight),offsets=[0,29,57,85,120,180,223,251,253,300,450,505,600,maximum].map(n=>Math.min(n,maximum));
  for(const [direction,values]of [["down",offsets],["up",[...offsets].reverse()]])for(const [i,offset]of values.entries()){
   list.targetElement.scrollTop=offset;list.targetElement.dispatchEvent(new w.Event("scroll"));checkCoverage("viewport-covered-"+direction+"-"+i);
  }
  list.targetElement.scrollTop=list.innerElem.scrollHeight;await wait(80);v.toggleOpenState(0);await wait(100);list=tree._jsWindow;checkCoverage("viewport-covered-after-offscreen-collapse");
  assert(Math.abs(parseFloat(list.innerElem.style.height)-list._getItemPosition(p._rows.length))<1,"scroll-extent-is-correct-after-multiple-expansions-and-collapse");
  assert([...list._renderedRows].every(([index,node])=>Math.abs(parseFloat(node.style.top)-list._getItemPosition(index))<1),"retained-visible-rows-keep-correct-positions-after-scrolling");
  assert(list._renderedRows.size>0&&p._rows.every(r=>typeof r.ref.isAnnotation==="function"),"short-window-scroll-never-loses-native-results");
  q.searchTextbox.value="";q.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true,composed:true}));await wait(200);assert(JSON.stringify(ids())===JSON.stringify(scopeIDs),"clearing-after-scroll-restores-every-document");
  report.locales=[];
  for(const locale of ["en-US","zh-CN","zh-TW","de","fr-FR","es-ES","ja-JP"]){
   function ScopedLocalization(ids,sync){return new Localization(ids,sync,undefined,[locale]);}
   const target={Zotero,Services,Localization:ScopedLocalization,Map,Promise,URL,setTimeout:w.setTimeout.bind(w),clearTimeout:w.clearTimeout.bind(w)};Services.scriptloader.loadSubScript(${JSON.stringify(url)},target);
   const hit=fixtures[0].hit,localized=new target.InlineProbe.RetrievalResultList(w,{snapshot},{},()=>({query:"liquidity",hits:[hit]}),()=>new Map(),()=>false),host=doc.createElementNS("http://www.w3.org/1999/xhtml","div");
   doc.documentElement.append(host);host.style.cssText="position:fixed;left:-20000px;width:600px";
   try{localized.synchronize();localized.firstPossibleID=hit.resourceID;localized.opened.add(hit.resourceID);localized.renderInline(host,hit,0);const messages=new Localization(["knowledgemcp.ftl"],true,undefined,[locale]).formatMessagesSync([{id:"knowledgemcp-vector-results-possible-note"},{id:"knowledgemcp-vector-source-label"}]);assert(host.querySelector(".km-relevance-note").textContent===messages[0].value&&host.querySelector(".km-evidence-location").textContent.startsWith(messages[1].value),"native-inline-locale-"+locale);report.locales.push(locale);}
   finally{localized.dispose();host.remove();}
  }
  assert(!Zotero.startupError,"no-native-fatal-error");report.status="passed";
 }catch(error){report.status="failed";report.error=String(error);report.stack=error.stack;
  if(w?.ZoteroPane?.itemsView){const v=w.ZoteroPane.itemsView,q=w.document.getElementById("zotero-tb-search");report.failureView={query:q?.searchTextbox?.value,message:q?.searchTextbox?.getAttribute("title"),rows:v.rowProvider?._rows.map(r=>({id:r.ref.id,open:r.isOpen,container:r.isContainer?.()})),html:w.document.getElementById(v.id+"-row-0")?.outerHTML};}
 }
 finally{
  restoreReader?.();Zotero.Prefs.set("extensions.zotero.knowledgemcp.retrievalSelection",savedMode??"",true);if(w&&!w.closed)w.close();
  report.originalWindowRows={before:originalRows,after:original.map(w=>w.closed?null:w.ZoteroPane.itemsView.rowProvider._rows.map(r=>r.ref.id))};
  report.originalWindowsUnchanged=JSON.stringify(report.originalWindowRows.before)===JSON.stringify(report.originalWindowRows.after);
  if(!report.originalWindowsUnchanged){report.status="failed";report.restoreError="Original window rows changed";}
  report.finished=Date.now();await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));
 }
})()`);
console.log(`Dispatched inline checks; read ${output}`);
