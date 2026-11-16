/** Synthetic records for automated UI checks; never imported by runtime code. */
export function createImportTaskFixtures() {
  const target = "Fixture Knowledge Base › Language Models";
  return [
    { id: "example-1", kind: "item", itemType: "journalArticle", title: "Attention Is All You Need", fileName: "attention-is-all-you-need.pdf", target, status: "parsing", stage: "parse", pages: { completed: 12, total: 20 } },
    { id: "example-2", kind: "item", itemType: "journalArticle", title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", fileName: "retrieval-augmented-generation.pdf", target, status: "publishing", stage: "publish" },
    { id: "example-3", kind: "item", itemType: "journalArticle", title: "Large Language Models as Optimizers", fileName: "large-language-models-as-optimizers.pdf", target, status: "queued", stage: "metadata" },
    { id: "example-4", kind: "item", itemType: "journalArticle", title: "Lost in the Middle: How Language Models Use Long Contexts", fileName: "lost-in-the-middle.pdf", target, status: "failed", stage: "parse" },
    { id: "example-5", kind: "item", itemType: "journalArticle", title: "The AI Scientist: Towards Fully Automated Open-Ended Scientific Discovery", fileName: "ai-scientist.pdf", target, status: "completed", stage: "publish", pages: { completed: 30, total: 30 } },
    { id: "example-6", kind: "item", itemType: "journalArticle", title: "A Survey of Large Language Models", fileName: "language-model-survey.pdf", target, status: "partial", stage: "publish", pages: { completed: 18, total: 20 } },
    { id: "example-folder", kind: "folder", mode: "import", title: "Reasoning Methods", sourceCollection: "My Library › Reasoning Methods", target, status: "parsing" },
    { id: "example-7", kind: "item", parentID: "example-folder", itemType: "conferencePaper", title: "Chain-of-Thought Prompting Elicits Reasoning in Large Language Models", fileName: "chain-of-thought.pdf", target, status: "parsing", stage: "parse", pages: { completed: 8, total: 16 } },
    { id: "example-8", kind: "item", parentID: "example-folder", itemType: "conferencePaper", title: "Self-Consistency Improves Chain of Thought Reasoning in Language Models", fileName: "self-consistency.pdf", target, status: "queued", stage: "metadata" },
    { id: "example-sync", kind: "folder", mode: "sync", title: "Knowledge Retrieval", sourceCollection: "My Library › Knowledge Retrieval", target, status: "syncing", changes: { added: 2, removed: 1 } },
    { id: "example-9", kind: "item", parentID: "example-sync", itemType: "journalArticle", title: "Dense Passage Retrieval for Open-Domain Question Answering", fileName: "dense-passage-retrieval.pdf", target, status: "completed", stage: "publish", pages: { completed: 12, total: 12 } },
    { id: "example-10", kind: "item", parentID: "example-sync", itemType: "conferencePaper", title: "REALM: Retrieval-Augmented Language Model Pre-Training", fileName: "realm.pdf", target, status: "publishing", stage: "publish" },
  ];
}

function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** A test service owns mutations; snapshots deliberately reject view-side writes. */
export function createImportTaskSource(initial = createImportTaskFixtures()) {
  let tasks = structuredClone(initial);
  const listeners = new Set();
  const calls = [];
  const publish = () => { for (const listener of listeners) listener(); };
  return {
    calls,
    get listenerCount() { return listeners.size; },
    snapshot: () => freeze(structuredClone(tasks)),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    replace(next) { tasks = structuredClone(next); publish(); },
    async runAction(id, action) {
      calls.push({ id, action });
      const task = tasks.find(task => task.id === id);
      if (task.kind === "folder" && task.mode === "sync") {
        task.status = action === "pause" ? "paused" : "syncing";
      } else {
        const children = task.kind === "folder" ? tasks.filter(child => child.parentID === task.id) : [task];
        for (const child of children) {
          if (action === "cancel" ? !["queued","parsing","publishing"].includes(child.status) : !["failed","partial","cancelled"].includes(child.status)) continue;
          child.status = action === "cancel" ? "cancelled" : "queued";
          if (action === "retry") { child.stage = "metadata"; delete child.pages; }
        }
      }
      publish();
    },
  };
}
