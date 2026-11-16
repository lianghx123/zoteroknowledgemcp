import type { McpBlockHeader, McpRepository } from "../../repositories/mcp";
import type { RetrievalEvidence } from "../../shared/contracts/retrieval";
import { chars, slice, type Principal } from "../contracts";
import { searchPosition } from "../../services/search-text";

/** Keep the actual hit segment before spending the remaining budget on context. */
export function evidenceWindow(text: string, query: string, budget: number): { text: string; truncated: boolean } {
  if (chars(text) <= budget) return { text, truncated: false };
  const position = searchPosition(text, query) ?? 0;
  const start = Math.max(0, Math.min(chars(text) - budget, position - Math.floor(budget / 4)));
  return { text: slice(text, start, start + budget), truncated: true };
}

export async function evidenceSnippet(repository: McpRepository, evidence: RetrievalEvidence, anchor: McpBlockHeader, neighbors: McpBlockHeader[],
  query: string, budget: number, principal: Principal, signal: AbortSignal) {
  const window = evidenceWindow(evidence.text, query, budget), ids = [anchor.id];
  let text = window.text, remaining = budget - chars(text), truncated = window.truncated || anchor.charCount > chars(evidence.text);
  const context = neighbors.filter(block => block.id !== anchor.id).sort((a, b) => Math.abs(a.order - anchor.order) - Math.abs(b.order - anchor.order) || a.order - b.order);
  for (let index = 0; index < context.length && remaining > 2; index++) {
    signal.throwIfAborted();
    const block = context[index], allocation = index + 1 < context.length ? Math.floor((remaining - 2) / 2) : remaining - 2;
    const take = Math.min(allocation, block.charCount); if (!take) continue;
    const body = await repository.readBlock(block, block.order < anchor.order ? block.charCount - take : 0, take, principal);
    if (block.order < anchor.order) { text = `${body.markdown}\n\n${text}`; ids.unshift(block.id); }
    else { text += `\n\n${body.markdown}`; ids.push(block.id); }
    remaining -= chars(body.markdown) + 2; truncated ||= take < block.charCount;
  }
  return { snippet: text, snippetTruncated: truncated, evidenceBlockIds: ids, evidenceExpanded: ids.length > 1 };
}
