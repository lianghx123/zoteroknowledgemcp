/** Preserve the greedy rank rule, including first-in-order tie breaking. */
export function diversify<T extends { title: string }>(hits: readonly T[], lambda: number): T[] {
  const pending = hits.map(hit => ({ hit, words: new Set(hit.title.toLowerCase().split(/\s+/)), maximum: 0 }));
  const result: T[] = [];
  while (pending.length) {
    let best = 0, bestScore = -Infinity;
    for (const [rank, entry] of pending.entries()) {
      const score = lambda / (rank + 1) - (1 - lambda) * entry.maximum;
      if (score > bestScore) { best = rank; bestScore = score; }
    }
    const [chosen] = pending.splice(best, 1);
    result.push(chosen.hit);
    for (const entry of pending) {
      let intersection = 0;
      for (const word of entry.words) if (chosen.words.has(word)) intersection++;
      const similarity = intersection / Math.max(1, entry.words.size + chosen.words.size - intersection);
      entry.maximum = Math.max(entry.maximum, similarity);
    }
  }
  return result;
}
