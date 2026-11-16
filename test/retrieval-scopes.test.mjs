import assert from "node:assert/strict";
import { test } from "node:test";
import { api, parsingFixture } from "./fixtures/parsing.mjs";

test("Trash uses explicit recovery ownership for text, semantic and fusion search; restore removes it from Trash scope",async t=>{
  const f=await parsingFixture(t);await f.enqueue();await f.step();await f.step();
  const repo=new api.EmbeddingRepository(f.db),config={...structuredClone(api.defaultRetrievalConfig),enabled:true},profile=await repo.profile(config);
  await repo.reconcile(profile,config);const job=await f.db.selectFrom("processing_jobs").selectAll().where("kind","=","embed").executeTakeFirstOrThrow();
  await repo.prepare(job.generation_id,profile,config);const pending=await repo.pending(job.generation_id,profile,10),v=api.normalizedVector(Array(768).fill(1),768);
  await f.db.updateTable("processing_jobs").set({state:"running",execution_token:"scope-test",lease_owner:"scope-test",lease_expires_at:Date.now()+600000,started_at:Date.now()}).where("id","=",job.id).execute();
  await repo.commit(job.id,"scope-test",profile,pending,pending.map(()=>v));await repo.projectFulltext();
  const indexed=await repo.activeVectors(profile).execute(),calls=[];
  const service=new api.RetrievalService({repository:repo,profile,config:{current:config},gateway:{async embed(){calls.push("embed");return [v];},async rerank(_q,texts){return texts.map((_,index)=>({index,score:1}));}},
    store:{async search(_v,ids){calls.push([...ids]);return ids.includes(f.input.resourceID)?indexed.map(row=>({embeddingID:row.id,score:1})):[];}}});
  const signal=new AbortController().signal,id=f.input.resourceID;
  assert.equal((await service.search("Body","fulltext",[id],signal)).hits[0].resourceID,id);
  await f.repo.moveToTrash([id],[f.target.libraryID]);
  assert.equal((await service.search("Body","fulltext",[id],signal)).hits.length,0);
  for(const mode of ["fulltext","semantic","enhanced","fusion"]){const result=await service.search("Body",mode,[id,"outside"],signal,"trash");assert.deepEqual(result.hits.map(hit=>hit.resourceID),[id]);}
  assert.ok(calls.some(call=>Array.isArray(call)&&call.length===1&&call[0]===id));
  const entries=(await f.repo.snapshot()).trash;await f.repo.restoreTrash(entries.map(entry=>entry.id));
  assert.equal((await service.search("Body","fulltext",[id],signal,"trash")).hits.length,0);assert.equal((await service.search("Body","fulltext",[id],signal)).hits[0].resourceID,id);
  await f.repo.deleteLibrary(f.target.libraryID,true);
  assert.notEqual((await f.db.selectFrom("knowledge_resources").select("deleted_at").where("id","=",id).executeTakeFirstOrThrow()).deleted_at,null);
  assert.equal((await service.search("Body","fulltext",[id],signal,"trash")).hits[0].resourceID,id);
  assert.equal((await service.search("Body","semantic",[id],signal,"trash")).hits[0].resourceID,id);
});

for (const mode of ["enhanced", "fusion"]) for (const scopeKind of ["active", "trash"]) {
  test(`${mode} rechecks ${scopeKind} ownership after delayed reranking and preserves remaining results`, async t => {
    const f = await parsingFixture(t); await f.enqueue(); await f.step(); await f.step();
    const repo = new api.EmbeddingRepository(f.db), config = { ...structuredClone(api.defaultRetrievalConfig), enabled: true };
    const id = f.input.resourceID, retained = await f.repo.save({ ...f.item, itemID: 2, key: "ARTICLE2", title: "Retained document", attachments: [] }, f.target);
    await repo.projectFulltext();
    if (scopeKind === "trash") await f.repo.moveToTrash([id, retained], [f.target.libraryID]);
    let started, finish;
    const waiting = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { finish = resolve; });
    const service = new api.RetrievalService({ repository: repo, config: { current: config }, gateway: {
      async embed() { return [api.normalizedVector(Array(768).fill(1), 768)]; },
      async rerank(_query, texts) { started(); await gate; return texts.map((_, index) => ({ index, score: 1 - index / 10 })); },
    } });
    service.vector = async () => [id, retained].map(resourceID => ({ resourceID, title: "Synthetic", score: .8, scoreType: "cosine", evidence: [], channels: ["vector"], parsed: true, embedded: true, metadataOnly: true }));
    const searching = service.search("Body", mode, [id, retained], new AbortController().signal, scopeKind);
    await waiting;
    if (scopeKind === "active") await f.repo.moveToTrash([id], [f.target.libraryID]);
    else {
      const entries = (await f.repo.snapshot()).trash.filter(entry => entry.resourceIDs.includes(id));
      assert.ok(entries.length); await f.repo.restoreTrash(entries.map(entry => entry.id));
    }
    finish();
    const result = await searching;
    assert.deepEqual(result.hits.map(hit => hit.resourceID), [retained]);
    assert.equal(result.coverage.resources, 1);
    service.close();
  });
}
