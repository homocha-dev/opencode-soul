import type { MemoryStore, Memory } from "../store";
import type { SoulConfig } from "../config";

interface RecallResult {
  memory: Memory;
  score: number;
}

/**
 * Standard recall — runs automatically on every message.
 *
 * 1. Extract query from the current message
 * 2. Vector search for top N candidates
 * 3. Filter by relevance threshold
 * 4. Return memories to inject into context
 *
 * The LLM reranking step happens outside this function —
 * the plugin injects these as context and the agent naturally
 * weighs their relevance.
 */
export async function standardRecall(
  input: any,
  store: MemoryStore,
  embeddings: {
    search: (q: string, n: number) => Promise<{ id: string; score: number }[]>;
  },
  cfg: SoulConfig["recall"]["standard"],
): Promise<RecallResult[]> {
  // extract the user's message text
  // TODO: adapt to actual message.updated input shape
  const text = extractQuery(input);
  if (!text) return [];

  // vector search for candidates
  const candidates = await embeddings.search(text, cfg.candidates);

  // filter by threshold
  const relevant = candidates.filter((c) => c.score >= cfg.threshold);

  // resolve full memories
  const results: RecallResult[] = [];
  for (const hit of relevant.slice(0, cfg.results)) {
    const memory = await store.get(hit.id);
    if (memory) {
      results.push({ memory, score: hit.score });
    }
  }

  return results;
}

function extractQuery(input: any): string | null {
  // extract text from the message event
  // the shape depends on opencode's message.updated hook
  if (input?.content) return input.content;
  if (input?.text) return input.text;
  if (input?.message?.content) return input.message.content;
  return null;
}
