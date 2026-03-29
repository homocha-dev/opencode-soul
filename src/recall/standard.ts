import type { MemoryStore, Memory } from "../store";
import type { SoulConfig } from "../config";

interface RecallResult {
  memory: Memory;
  score: number;
}

/**
 * Standard recall — runs automatically on every message.
 *
 * 1. Vector search for top N candidates from the message text
 * 2. Filter by relevance threshold
 * 3. Return memories to inject into context
 */
export async function standardRecall(
  text: string,
  store: MemoryStore,
  embeddings: {
    search: (q: string, n: number) => Promise<{ id: string; score: number }[]>;
  },
  cfg: SoulConfig["recall"]["standard"],
): Promise<RecallResult[]> {
  if (!text.trim()) return [];

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
