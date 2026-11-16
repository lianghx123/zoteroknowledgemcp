// Developer controller only. All indexing and I/O run in the isolated Zotero.
import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

export function evaluate(source, port = Number(process.env.ZOTERO_DEBUG_PORT ?? 5399)) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port }); let buffer = Buffer.alloc(0);
    const send = value => { const body = Buffer.from(JSON.stringify(value)); socket.write(Buffer.concat([Buffer.from(`${body.length}:`), body])); };
    socket.setTimeout(45000, () => { socket.destroy(); reject(Error("Debugger timeout")); }); socket.on("error", reject);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.includes(58)) {
        const colon = buffer.indexOf(58), size = Number(buffer.subarray(0, colon).toString()); if (buffer.length < colon + 1 + size) break;
        const message = JSON.parse(buffer.subarray(colon + 1, colon + 1 + size)); buffer = buffer.subarray(colon + 1 + size);
        if (message.from === "root" && message.applicationType) send({ to: "root", type: "getProcess", id: 0 });
        else if (message.processDescriptor) send({ to: message.processDescriptor.actor, type: "getTarget" });
        else if (message.process?.consoleActor) send({ to: message.process.consoleActor, type: "evaluateJSAsync", text: source });
        else if (message.type === "evaluationResult") { socket.end(); if (message.hasException) reject(Error(JSON.stringify(message.exceptionMessage))); else resolve(message.result); }
        else if (message.error) { socket.end(); reject(Error(message.error)); }
      }
    });
  });
}
export async function runtimeRootURI() {
  const value = await evaluate('Services.io.getProtocolHandler("resource").QueryInterface(Ci.nsIResProtocolHandler).getSubstitution("knowledgemcp-vector").spec');
  if (typeof value !== "string" || !value.endsWith("content/vector/")) throw Error("Installed vector assets are unavailable");
  return value.slice(0, -"content/vector/".length);
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("scripts/verify-vector-native.mjs")) {
  const root = path.resolve(".scaffold/vector-acceptance"); await fs.mkdir(root, { recursive: true });
  await build({ stdin: { contents: `
import { VectorIndex } from "./src/services/vector-index.ts";
export async function run(rootURI, folder) {
  const report = {runtime: "Zotero ChromeWorker", started: Date.now(), cases: []};
  try {
    for (const dimensions of [512, 768, 1024, 2048]) for (const mode of ["f32", "i8"]) {
      const index = new VectorIndex(rootURI), controller = new (Zotero.getMainWindows()[0].AbortController)();
      try {
        const rows = Array.from({length: dimensions === 768 ? 1000 : 32}, (_, i) => {
          let norm=0; const vector = Float32Array.from({length:dimensions}, (_, j) => {const n=Math.sin((i+1)*(j+3)*0.173);norm+=n*n; return n;});
          for(let j=0;j<dimensions;j++)vector[j]/=Math.sqrt(norm);return {label:i+1,vector};
        });
        const t0=Date.now(); await index.open(dimensions,mode); for(let i=0;i<rows.length;i+=100)await index.add(rows.slice(i,i+100));
        const builtMs=Date.now()-t0, labels=rows.map(x=>x.label), query=rows[3].vector, before=await index.query(query,labels,20);
        const path=PathUtils.join(folder, mode+"-"+dimensions+".usearch"), t1=Date.now(), saved=await index.save(path,controller.signal), saveMs=Date.now()-t1;
        const loadedStats=await index.stats(); index.close(); const t2=Date.now(); await index.open(dimensions,mode); await index.restore(path,saved.hash,saved.bytes);
        const restoreMs=Date.now()-t2, after=await index.query(query,labels,20);
        if(JSON.stringify(before)!==JSON.stringify(after))throw Error("restore-results");
        await index.remove([4]); const removed=await index.query(query,labels,20); if(removed.some(x=>x.label===4))throw Error("delete");
        await index.add([{label:4,vector:rows[8].vector}]); const updated=await index.query(rows[8].vector,labels,2);
        if(!updated.some(row=>row.label===4))throw Error("replacement-vector");
        report.cases.push({dimensions,mode,count:rows.length,status:"passed",builtMs,saveMs,restoreMs,snapshot:saved,loadedStats,restoredStats:await index.stats(),equal:true,deleted:true,updated:!!updated.length});
      } finally { index.close(); }
    }
    report.status="passed";
  } catch(e) {report.status="failed";report.error=String(e);report.stack=e?.stack;}
  report.finished=Date.now(); await IOUtils.writeUTF8(PathUtils.join(folder,"native-smoke.json"),JSON.stringify(report,null,2));
}`, resolveDir: process.cwd(), loader: "ts" }, bundle: true, format: "iife", globalName: "VectorAcceptance", platform: "browser", target: "firefox140", outfile: path.join(root, "native-probe.js") });
  const state = await evaluate(`JSON.stringify({dir:Zotero.DataDirectory.dir,version:Zotero.version})`);
  const data = JSON.parse(state); if (!data.dir.toLowerCase().includes("\\.scaffold\\")) throw Error("Isolated development Zotero required");
  const url = new URL(`file:///${path.join(root, "native-probe.js").replaceAll("\\", "/")}`).href;
  await evaluate(`Services.scriptloader.loadSubScript(${JSON.stringify(url)}); void VectorAcceptance.run(${JSON.stringify(await runtimeRootURI())},${JSON.stringify(root)})`);
  console.log(`Dispatched native checks; read ${path.join(root, "native-smoke.json")}`);
}
