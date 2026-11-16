// Developer-driven native Fluent/DOM verification; no settings are saved.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { evaluate } from "./verify-vector-native.mjs";
const folder = path.resolve(".scaffold/vector-acceptance"); await fs.mkdir(folder, { recursive: true });
await build({ stdin: { loader: "ts", resolveDir: process.cwd(), contents: `
import { mountRetrievalSettings } from "./src/ui/retrieval-settings.ts";
export async function check(){
 const doc=Zotero.getMainWindows()[0].document,host=doc.createElementNS("http://www.w3.org/1999/xhtml","section");host.setAttribute("data-vector-locale","true");host.style.cssText="position:fixed;left:-20000px;top:0;width:780px";doc.documentElement.append(host);
 const dispose=await mountRetrievalSettings(host);
 try{return {dimensions:[...host.querySelectorAll("#km-vector-dimensions option")].map(x=>x.value),defaultDimension:host.querySelector("#km-vector-dimensions").value,
  precision:[...host.querySelectorAll("#km-vector-indexMode option")].map(x=>x.textContent),labels:[...host.querySelectorAll("label,legend,button")].map(x=>x.textContent),
  credentialsAreEmpty:[...host.querySelectorAll('input[type="password"]')].every(x=>x.value==="")};}finally{dispose();host.remove();}
}` }, bundle: true, format: "iife", platform: "browser", target: "firefox140", globalName: "VectorLocaleProbe", outfile: path.join(folder, "locale-probe.js") });
const bundleURL = pathToFileURL(path.join(folder, "locale-probe.js")).href;
await evaluate(`void(async()=>{
 const window=Zotero.getMainWindows()[0],report={runtime:"native Gecko Fluent and DOM; explicit locales, no settings writes",locales:[],started:Date.now()};
 try{
  if(!Zotero.DataDirectory.dir.toLowerCase().includes("\\\\.scaffold\\\\"))throw Error("isolated-library-required");
  for(const locale of ["en-US","zh-CN","zh-TW","de","fr-FR","es-ES","ja-JP"]){
   function ScopedLocalization(ids,sync){return new Localization(ids,sync,undefined,[locale]);}
   const target={Zotero,Services,PathUtils,IOUtils,Localization:ScopedLocalization,ChromeUtils,AbortController:window.AbortController,setTimeout:window.setTimeout.bind(window),clearTimeout:window.clearTimeout.bind(window),setInterval:window.setInterval.bind(window),clearInterval:window.clearInterval.bind(window),URL,Map,Promise};
   Services.scriptloader.loadSubScript(${JSON.stringify(bundleURL)},target);const result=await target.VectorLocaleProbe.check();
   if(result.labels.some(x=>x.includes("knowledgemcp-")))throw Error("unresolved-localization-"+locale);
   report.locales.push({locale,...result});
   const expected={"en-US":"High precision (Float32)","zh-CN":"高精度模式（Float32）","zh-TW":"高精度模式（Float32）",de:"Hohe Genauigkeit (Float32)","fr-FR":"Haute précision (Float32)","es-ES":"Alta precisión (Float32)","ja-JP":"高精度（Float32）"};
   if(result.precision[0]!==expected[locale])throw Error("locale-negotiation-"+locale);
  }report.status="passed";
 }catch(error){report.status="failed";report.error=String(error);report.stack=error?.stack;}
 finally{for(const host of window.document.querySelectorAll('[data-vector-locale="true"]'))host.remove();report.finished=Date.now();await IOUtils.writeUTF8(${JSON.stringify(path.join(folder, "native-locales.json"))},JSON.stringify(report,null,2));}
})()`);
console.log("Dispatched native checks with explicit locale selection; app language is unchanged.");
