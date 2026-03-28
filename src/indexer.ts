import type { MemoryStore } from "./store";
import type { SoulConfig } from "./config";

/**
 * Auto-indexer — runs after every session ends.
 *
 * 1. Saves the full conversation as an encounter log
 * 2. Extracts discrete memories by category
 * 3. Indexes them with embeddings
 *
 * Currently uses simple heuristic extraction.
 * TODO: Use the small_model to do agentic extraction for
 * better categorization and deduplication.
 */
export async function indexEncounter(
  ctx: any,
  store: MemoryStore,
  embeddings: { index: (memory: any) => Promise<void> },
  cfg: SoulConfig,
): Promise<void> {
  try {
    await ctx.client.app.log({
      body: {
        service: "opencode-soul",
        level: "info",
        message: "Auto-indexing session encounter",
      },
    });

    // TODO: get the full conversation from the session
    // the session.idle event should provide access to session data
    // for now this is a stub that will be filled in once we
    // understand the exact shape of the session event data

    // the flow will be:
    // 1. get session messages from ctx.client
    // 2. format as encounter log markdown
    // 3. save encounter log to disk
    // 4. extract memories (facts, patterns, preferences, context)
    // 5. save each memory and index embeddings
    // 6. link memories back to the encounter via source_encounter

    await ctx.client.app.log({
      body: {
        service: "opencode-soul",
        level: "debug",
        message: "Auto-indexer: stub — waiting for session data API",
      },
    });
  } catch (err) {
    await ctx.client.app.log({
      body: {
        service: "opencode-soul",
        level: "error",
        message: `Auto-indexer failed: ${err}`,
      },
    });
  }
}
