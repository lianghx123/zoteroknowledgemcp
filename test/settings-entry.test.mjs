import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
const compiled = await build({ entryPoints:["src/ui/settings-entry.ts"],bundle:true,format:"iife",write:false,plugins:[{name:"settings-mount-fixture",setup(builder){
  builder.onResolve({filter:/^\.\/settings$/},()=>({path:"settings",namespace:"fixture"}));
  builder.onLoad({filter:/.*/,namespace:"fixture"},()=>({contents:'export async function mountSettings(){window.mounts++;if(window.waitForMount)await window.waitForMount;return()=>window.disposals++;}',loader:"js"}));
}}]});
const settle = ()=>new Promise(resolve=>setImmediate(resolve));
for (const pending of [false,true]) test(`settings pane removal cleans ${pending?"pending":"mounted"} resources without closing preferences`,async t=>{
  const dom=new JSDOM('<html><body/></html>',{runScripts:"outside-only"});t.after(()=>dom.window.close());
  const w=dom.window;w.mounts=0;w.disposals=0;w.Zotero={debug(){}};let release;
  if(pending)w.waitForMount=new Promise(resolve=>{release=resolve;});w.eval(compiled.outputFiles[0].text);
  const host=w.document.createElement("section");host.id="km-settings";w.document.body.append(host);await settle();assert.equal(w.mounts,1);
  host.remove();await settle();if(pending){assert.equal(w.disposals,0);release();await settle();}assert.equal(w.disposals,1);
  w.dispatchEvent(new w.Event("unload"));assert.equal(w.disposals,1);
});
