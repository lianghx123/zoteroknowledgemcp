// Developer-driven native search, evidence, multi-window and layout checks.
import fs from "node:fs/promises";
import path from "node:path";
import { evaluate } from "./verify-vector-native.mjs";

const output = path.resolve(".scaffold/vector-acceptance/native-search-ui.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await evaluate(`void(async()=>{
 const w=Zotero.getMainWindows()[0],doc=w.document,q=doc.getElementById("zotero-tb-search"),
  selectionKey="extensions.zotero.knowledgemcp.retrievalSelection",
  saved={selection:Zotero.Prefs.get(selectionKey,true),native:Zotero.Prefs.get("search.quicksearch-mode"),input:q.searchTextbox.value,
   items:w.ZoteroPane.getSelectedItems().map(item=>item.id),width:w.outerWidth,height:w.outerHeight},
  report={runtime:"installed XPI; developer-driven native DOM and window API",checks:[],started:Date.now(),providerCalls:0};
 let second;
 const wait=ms=>new Promise(resolve=>w.setTimeout(resolve,ms)),until=async predicate=>{for(let i=0;i<200;i++){if(await predicate())return;await wait(100);}throw Error("ui-state-timeout");},
  assert=(value,label)=>{if(!value)throw Error(label);report.checks.push(label);},
  command=(window,node)=>node.dispatchEvent(new window.Event("command",{bubbles:true})),
  itemIDs=()=>w.ZoteroPane.itemsView.rowProvider._rows.filter(row=>row.isObjectRow&&(row.level??0)===0).map(row=>row.ref.id),
  evidence=()=>doc.querySelector('.km-inline-evidence .km-retrieval-panel'),
  fulltext=async()=>{command(w,q.searchModePopup.querySelector("#km-search-fulltext"));await wait(300);q.searchTextbox.value="liquidity";
   q.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));
   await until(()=>!q.searchTextbox.hasAttribute("aria-busy")&&doc.querySelector(".km-inline-result .twisty"));await w.ZoteroPane.itemsView.selectItem(10);
   const provider=w.ZoteroPane.itemsView.rowProvider,index=provider._rows.findIndex(row=>row.isObjectRow&&row.ref.id===10);
   if(!provider.isContainerOpen(index))await provider.toggleOpenState(index);
   await until(()=>evidence()&&evidence().textContent.toLowerCase().includes("liquidity"));};
 try{
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  report.pid=Services.appinfo.processID;
  command(w,q.searchModePopup.querySelector('[value="'+saved.native+'"]'));await wait(250);
  q.searchTextbox.value="";await w.ZoteroPane.search(true);await w.ZoteroPane.itemsView.refreshAndMaintainSelection();
  const baseline=JSON.stringify(itemIDs());assert(itemIDs().length>0,"native-list-nonempty-before-mode-selection");
  for(const mode of ["fulltext","semantic","enhanced","fusion"]){
   if(mode==="fulltext")command(w,q.searchModePopup.querySelector("#km-search-fulltext"));else command(w,q.searchModePopup.querySelector('[data-mode="'+mode+'"]'));
   await wait(250);assert(JSON.stringify(itemIDs())===baseline,"select-"+mode+"-preserves-list");
  }
  q.searchTextbox.value="liquidity";q.searchTextbox.dispatchEvent(new w.Event("input",{bubbles:true}));await wait(400);
  assert(JSON.stringify(itemIDs())===baseline,"typing-without-enter-preserves-list");
  q.searchTextbox.value="   ";q.searchTextbox.dispatchEvent(new w.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));await wait(300);
  assert(JSON.stringify(itemIDs())===baseline,"empty-enter-preserves-list");
  await fulltext();
  report.results=w.ZoteroPane.itemsView.rowProvider._rows.filter(row=>row.isObjectRow&&(row.level??0)===0).map(row=>row.ref.id);
  assert(report.results.length===4,"fulltext-four-deduplicated-documents");
  assert(!evidence().hidden&&evidence().querySelectorAll("blockquote").length===3,"three-visible-source-evidences");
  report.evidenceText=evidence().textContent;
  command(w,q.searchModePopup.querySelector('[value="'+saved.native+'"]'));await wait(400);
  await until(()=>!evidence());
  assert(!evidence()||evidence().hidden,"evidence-disabled-in-native-mode");
  await fulltext();assert(!evidence().hidden,"evidence-reenabled-after-native-mode");
  assert(Zotero.Prefs.get("search.quicksearch-mode")===saved.native,"native-search-preference-preserved");
  w.resizeTo(1000,saved.height);await wait(400);
  const menus=[...q.searchModePopup.querySelectorAll("[data-mode]")];
  assert(menus.length===4&&menus.every(menu=>menu.localName==="menuitem"),"four-native-search-menu-entries");
  assert(!doc.getElementById("km-search-modes"),"no-search-toolbar-buttons");
  assert(menus.filter(menu=>menu.dataset.mode!=="fulltext").every(menu=>!!menu.getAttribute("tooltiptext")),"semantic-menu-tooltips");
  w.resizeTo(saved.width,saved.height);
  const originalWindows=new Set(Zotero.getMainWindows());Zotero.openMainWindow();
  await until(()=>{second=Zotero.getMainWindows().find(window=>!originalWindows.has(window));return second?.document.querySelectorAll("[data-mode]").length===4;});
  assert(second.document.querySelectorAll("#km-search-semantic").length===1&&doc.querySelectorAll("#km-search-semantic").length===1,"two-windows-one-menu-set-each");
  second.close();await until(()=>second.closed);assert(doc.querySelectorAll("[data-mode]").length===4,"second-window-close-preserves-first");
  report.status="passed";
 }catch(error){report.status="failed";report.error=String(error);report.stack=error?.stack;}
 finally{
  if(second&&!second.closed)second.close();w.resizeTo(saved.width,saved.height);
  command(w,q.searchModePopup.querySelector('[value="'+saved.native+'"]'));await wait(250);q.searchTextbox.value=saved.input;
  if(["fulltext","semantic","enhanced","fusion"].includes(saved.selection)){
   if(saved.selection==="fulltext")command(w,q.searchModePopup.querySelector("#km-search-fulltext"));
   else command(w,q.searchModePopup.querySelector('[data-mode="'+saved.selection+'"]'));
  }
  Zotero.Prefs.set(selectionKey,saved.selection??"",true);
  if(!saved.selection)await w.ZoteroPane.search(true);
  if(saved.items.length)await w.ZoteroPane.itemsView.selectItems(saved.items);
  report.finished=Date.now();await IOUtils.writeUTF8(${JSON.stringify(output)},JSON.stringify(report,null,2));
 }
})()`);
console.log(`Dispatched native search UI checks; read ${output}`);
