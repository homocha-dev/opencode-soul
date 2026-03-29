import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config";
import { createStore } from "./store";
import { createEmbeddings } from "./embeddings";
import { standardRecall } from "./recall/standard";
import { deepRecall } from "./recall/deep";
import { indexEncounter } from "./indexer";
import { readSoul, writeSoul } from "./soul";

export const SoulPlugin: Plugin = async (ctx) => {
  const cfg = await loadConfig(ctx.directory);
  const store = await createStore(cfg);
  const embeddings = await createEmbeddings();

  await ctx.client.app.log({
    body: {
      service: "opencode-soul",
      level: "info",
      message: "Soul plugin initialized",
    },
  });

  // resolve which soul to use for a given agent
  function soulFor(agent?: string): string | null {
    if (agent && cfg.agents[agent]) return cfg.agents[agent].soul;
    if (cfg.agents["*"]) return cfg.agents["*"].soul;
    return "default";
  }

  function recallEnabled(agent?: string) {
    if (agent && cfg.agents[agent]) return cfg.agents[agent].recall;
    if (cfg.agents["*"]) return cfg.agents["*"].recall;
    return { standard: true, deep: true };
  }

  return {
    // bus events — auto-index on session idle
    event: async ({ event }) => {
      if (event.type === "session.idle" && cfg.memory.auto_index) {
        await indexEncounter(ctx, store, embeddings, cfg);
      }
    },

    // inject soul + recalled memories into the system prompt
    "experimental.chat.system.transform": async (input, output) => {
      // inject soul identity
      const name = soulFor(undefined); // TODO: get agent from input when available
      if (name) {
        const soul = await readSoul(cfg, name);
        if (soul) {
          output.system.push(soul);
        }
      }

      // inject recent memories
      const recent = await store.recent(5);
      if (recent.length > 0) {
        output.system.push(
          `## Recent Memories\n${recent.map((m) => `- [${m.type}] ${m.content}`).join("\n")}`,
        );
      }
    },

    // standard recall on each user message — inject relevant memories
    "chat.message": async (input, output) => {
      const recall = recallEnabled(input.agent);
      if (!recall.standard) return;

      // extract text from user message parts
      const text = output.parts
        .filter((p) => p.type === "text")
        .map((p: any) => p.text || "")
        .join(" ");

      if (!text) return;

      const recalled = await standardRecall(
        text,
        store,
        embeddings,
        cfg.recall.standard,
      );

      if (recalled.length > 0) {
        const content = recalled
          .map(
            (r) =>
              `- [${r.memory.type}] ${r.memory.content} (relevance: ${Math.round(r.score * 100)}%)`,
          )
          .join("\n");

        // prepend to first text part (can't insert new parts — they need id/sessionID/messageID)
        const first = output.parts.find((p) => p.type === "text") as any;
        if (first) {
          first.text = `[Recalled memories]\n${content}\n\n[User message]\n${first.text}`;
        }

        await ctx.client.app.log({
          body: {
            service: "opencode-soul",
            level: "info",
            message: `Standard recall: ${recalled.length} memories`,
          },
        });
      }
    },

    // preserve identity across compaction
    "experimental.session.compacting": async (input, output) => {
      const name = soulFor(undefined);
      if (name) {
        const soul = await readSoul(cfg, name);
        if (soul) {
          output.context.push(`## Agent Identity (SOUL.md)\n${soul}`);
        }
      }

      const recent = await store.recent(5);
      if (recent.length > 0) {
        output.context.push(
          `## Recent Memories\n${recent.map((m) => `- [${m.type}] ${m.content}`).join("\n")}`,
        );
      }
    },

    // custom tools
    tool: {
      soul_edit: tool({
        description:
          "Edit your SOUL.md identity file. Use this to update who you are — your personality, values, things you've learned about yourself or your human. Only for identity-level changes, not regular facts.",
        args: {
          section: tool.schema.string(
            "The section to edit (e.g. 'Personality', 'Values', 'About My Human', 'Things I've Learned')",
          ),
          content: tool.schema.string("The new content for this section"),
          soul: tool.schema.optional(
            tool.schema.string(
              "Which soul to edit (defaults to the agent's configured soul)",
            ),
          ),
        },
        async execute(args, context) {
          const name = args.soul || soulFor(undefined) || "default";
          const result = await writeSoul(cfg, name, args.section, args.content);
          return result;
        },
      }),

      soul_remember: tool({
        description:
          "Explicitly save a memory. Use this for important facts, preferences, or patterns you want to make sure are remembered. The auto-indexer handles most memories — use this for things you want to guarantee are saved with specific tags.",
        args: {
          content: tool.schema.string("The memory content to save"),
          type: tool.schema.string(
            "Memory type: fact | pattern | preference | context",
          ),
          tags: tool.schema.optional(
            tool.schema.string("Comma-separated tags for this memory"),
          ),
        },
        async execute(args, context) {
          const memory = await store.save({
            content: args.content,
            type: args.type as "fact" | "pattern" | "preference" | "context",
            tags: args.tags?.split(",").map((t) => t.trim()) || [],
            project: context.directory,
            source: "explicit",
          });
          await embeddings.index(memory);
          return `Memory saved: ${memory.id}`;
        },
      }),

      need_context: tool({
        description:
          "Deep recall — use when you need to trace back through past experiences to find specific context. This searches through your memory and past encounters from multiple angles. Use when you feel like you're missing context about something that might have come up before.",
        args: {
          query: tool.schema.string(
            "What are you trying to remember or find context about?",
          ),
          hints: tool.schema.optional(
            tool.schema.string(
              "Any hints — timeframe, people involved, project, related topics",
            ),
          ),
        },
        async execute(args, context) {
          const result = await deepRecall(
            args.query,
            args.hints,
            store,
            embeddings,
            cfg.recall.deep,
            ctx,
          );
          return result;
        },
      }),
    },
  };
};
