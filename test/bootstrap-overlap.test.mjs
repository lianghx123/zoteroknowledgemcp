import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
for (const replacementRoot of ["file:///new/", "file:///old/"]) test(`replacement closes the old API and ignores its late shutdown (${replacementRoot})`, async () => {
  const events = [], Zotero = { getMainWindows: () => [{ Promise, Map }] };
  const scope = name => {
    const sandbox = createContext({ Zotero, Ci: {}, Cc: {
      "@mozilla.org/addons/addon-manager-startup;1": { getService: () => ({ registerChrome: () => ({ destruct() { events.push(name + ":chrome-closed"); } }) }) },
    }, Services: {
      io: { newURI: uri => uri, getProtocolHandler: () => ({ QueryInterface() { return this; }, setSubstitution(_key, value) { events.push(name + (value ? ":resource-open" : ":resource-closed")); } }) },
      scriptloader: { loadSubScript() { sandbox.ZoteroKnowledgeMCP = { async startup() { events.push(name + ":started"); }, async shutdown() { events.push(name + ":closed"); } }; } },
    } });
    runInContext(readFileSync("addon/bootstrap.js", "utf8"), sandbox); return sandbox;
  };
  const oldContext = { id: "fixture", version: "1", rootURI: "file:///old/" };
  const nextContext = { ...oldContext, rootURI: replacementRoot };
  const old = scope("old"), next = scope("new");
  await old.startup(oldContext); await next.startup(nextContext);
  assert.ok(events.indexOf("old:closed") < events.indexOf("new:started"));
  assert.equal(events.filter(value => value === "old:closed").length, 1);
  const active = Zotero.__knowledgeMCPBootstrapActive;
  await old.shutdown(oldContext);
  assert.equal(Zotero.__knowledgeMCPBootstrapActive, active);
  assert.equal(events.includes("new:closed"), false);
  await next.shutdown(nextContext);
  assert.equal(events.filter(value => value === "new:closed").length, 1);
  assert.equal(Zotero.__knowledgeMCPBootstrapInstances.size, 0);
});
test("bootstrap scopes wait for earlier database and resource shutdown", async()=>{
  const events=[],Zotero={getMainWindows:()=>[{Promise}]};let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const scope=name=>{const sandbox=createContext({Zotero,Ci:{},Cc:{"@mozilla.org/addons/addon-manager-startup;1":{getService:()=>({registerChrome:()=>({destruct(){events.push(name+":chrome-closed");}})})}},Services:{
    io:{newURI:value=>value,getProtocolHandler:()=>({QueryInterface(){return this;},setSubstitution(_key,value){events.push(name+(value?":resource-open":":resource-closed"));}})},
    scriptloader:{loadSubScript(){sandbox.ZoteroKnowledgeMCP={async startup(){events.push(name+":started");},async shutdown(){events.push(name+":draining");if(name==="old")await gate;events.push(name+":database-closed");}};}}
  }});runInContext(readFileSync("addon/bootstrap.js","utf8"),sandbox);return sandbox;};
  const old=scope("old"),next=scope("new");await old.startup({rootURI:"file:///old/"});const draining=old.shutdown(),starting=next.startup({rootURI:"file:///new/"});
  await new Promise(resolve=>setImmediate(resolve));assert.ok(events.includes("old:draining"));assert.ok(!events.includes("new:resource-open"));
  release();await Promise.all([draining,starting]);assert.ok(events.indexOf("old:database-closed")<events.indexOf("new:started"));assert.ok(events.indexOf("old:resource-closed")<events.indexOf("new:resource-open"));
  await next.shutdown();
});
test("owned Fluent source remains after the host unregisters an earlier unified source",async()=>{
  const sources=new Map(),registry={hasSource:id=>sources.has(id),registerSources:rows=>rows.forEach(row=>sources.set(row.name,row)),updateSources:rows=>rows.forEach(row=>sources.set(row.name,row)),removeSources:ids=>ids.forEach(id=>sources.delete(id))};
  const window={Promise,L10nRegistry:{getInstance:()=>registry},L10nFileSource:{createMock:(name,_type,locales,prefix,files)=>({name,locales,prefix,files})}};
  const Zotero={getMainWindows:()=>[window],Utilities:{Internal:{resolveLocale:(locale,available)=>available.includes(locale)?locale:"en-US"}}};
  let scope;
  scope=createContext({Zotero,Ci:{},fetch:async url=>({json:async()=>["en-US","zh-CN"],text:async()=>url.includes("zh-CN")?"Chinese catalog":"English catalog"}),Cc:{"@mozilla.org/addons/addon-manager-startup;1":{getService:()=>({registerChrome:()=>({destruct(){}})})}},Services:{locale:{availableLocales:["en-US","zh-CN","it-IT"]},io:{newURI:uri=>uri,getProtocolHandler:()=>({QueryInterface(){return this;},setSubstitution(){}})},scriptloader:{loadSubScript(){scope.ZoteroKnowledgeMCP={async startup(){},async shutdown(){}};}}}});
  runInContext(readFileSync("addon/bootstrap.js","utf8"),scope);await scope.startup({rootURI:"jar:file:///fixture.xpi!/"});
  const source=sources.get("knowledgemcp-owned-locales");assert.ok(source);assert.equal(source.files.length,3);assert.equal(source.files.find(row=>row.path.includes("it-IT")).source,"English catalog");
  sources.delete("zotero-plugins");assert.ok(sources.has("knowledgemcp-owned-locales"));await scope.shutdown();assert.equal(sources.size,0);
});
