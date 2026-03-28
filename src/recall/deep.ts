import type { MemoryStore } from "../store";
import type { SoulConfig } from "../config";

interface ExplorerResult {
  strategy: string;
  findings: string[];
  encounters: string[];
}

/**
 * Deep recall — investigative memory reconstruction.
 *
 * Spawns parallel explorer strategies that each take a different
 * angle on the query. Each explorer:
 * 1. Searches the vector index with its own strategy
 * 2. Reads full encounter logs from matching memories
 * 3. Extracts relevant passages
 *
 * Then a synthesizer combines all findings into a coherent narrative.
 */
export async function deepRecall(
  query: string,
  hints: string | undefined,
  store: MemoryStore,
  embeddings: {
    search: (q: string, n: number) => Promise<{ id: string; score: number }[]>;
  },
  cfg: SoulConfig["recall"]["deep"],
  ctx: any,
): Promise<string> {
  const strategies = buildStrategies(query, hints);

  // run all explorers in parallel
  const results = await Promise.all(
    strategies.map((s) => explore(s, store, embeddings, cfg)),
  );

  // synthesize findings
  return synthesize(query, results);
}

interface Strategy {
  name: string;
  queries: string[];
  filter?: { type?: string; timeframe?: string };
}

function buildStrategies(query: string, hints?: string): Strategy[] {
  const strategies: Strategy[] = [];

  // keyword explorer — direct search on the query terms
  strategies.push({
    name: "keyword",
    queries: [query],
  });

  // decomposed explorer — break query into sub-queries
  const words = query.split(/\s+/).filter((w) => w.length > 3);
  if (words.length > 2) {
    strategies.push({
      name: "decomposed",
      queries: chunk(words, 3).map((c) => c.join(" ")),
    });
  }

  // category explorers — search within specific memory types
  for (const type of ["fact", "pattern", "context"]) {
    strategies.push({
      name: `category-${type}`,
      queries: [query],
      filter: { type },
    });
  }

  // hints explorer
  if (hints) {
    strategies.push({
      name: "hints",
      queries: [hints, `${query} ${hints}`],
    });
  }

  return strategies.slice(0, 5); // cap at configured max
}

async function explore(
  strategy: Strategy,
  store: MemoryStore,
  embeddings: {
    search: (q: string, n: number) => Promise<{ id: string; score: number }[]>;
  },
  cfg: SoulConfig["recall"]["deep"],
): Promise<ExplorerResult> {
  const findings: string[] = [];
  const encounters: string[] = [];

  for (const query of strategy.queries) {
    // vector search
    const hits = await embeddings.search(query, 10);

    for (const hit of hits.slice(0, 5)) {
      const memory = await store.get(hit.id);
      if (!memory) continue;

      // apply type filter if present
      if (strategy.filter?.type && memory.type !== strategy.filter.type)
        continue;

      findings.push(`[${memory.type}] (${memory.created}) ${memory.content}`);

      // if this memory links to an encounter, read the full log
      if (memory.source_encounter) {
        const log = await store.readEncounter(memory.source_encounter);
        if (log && !encounters.includes(memory.source_encounter)) {
          encounters.push(memory.source_encounter);
          // extract relevant passages from the encounter
          const passages = extractPassages(log, query);
          findings.push(...passages.map((p) => `[encounter] ${p}`));
        }
      }
    }
  }

  return {
    strategy: strategy.name,
    findings: [...new Set(findings)], // deduplicate
    encounters,
  };
}

function synthesize(query: string, results: ExplorerResult[]): string {
  const all = results.flatMap((r) => r.findings);
  const unique = [...new Set(all)];
  const encounters = [...new Set(results.flatMap((r) => r.encounters))];

  if (unique.length === 0) {
    return `No relevant memories found for: "${query}"`;
  }

  let output = `## Deep Recall Results\n\n`;
  output += `**Query:** ${query}\n`;
  output += `**Memories found:** ${unique.length}\n`;
  output += `**Encounters explored:** ${encounters.length}\n\n`;

  output += `### Findings\n`;
  for (const finding of unique) {
    output += `- ${finding}\n`;
  }

  if (encounters.length > 0) {
    output += `\n### Source Encounters\n`;
    for (const enc of encounters) {
      output += `- ${enc}\n`;
    }
  }

  return output;
}

function extractPassages(log: string, query: string): string[] {
  const lines = log.split("\n");
  const lower = query.toLowerCase();
  const words = lower.split(/\s+/).filter((w) => w.length > 3);
  const passages: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (words.some((w) => line.includes(w))) {
      // grab surrounding context (3 lines before and after)
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length, i + 4);
      passages.push(lines.slice(start, end).join("\n").trim());
    }
  }

  return passages.slice(0, 5); // cap passages
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
