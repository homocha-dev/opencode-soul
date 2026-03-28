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

  return {
    // inject soul + recalled memories into every session
    event: async ({ event }) => {
      if (event.type === "session.created") {
        // soul injection happens via instructions config
        // this hook is for logging / future dynamic injection
        await ctx.client.app.log({
          body: {
            service: "opencode-soul",
            level: "info",
            message: "Session started, soul active",
          },
        });
      }

      // auto-index encounters when session goes idle
      if (event.type === "session.idle" && cfg.memory.auto_index) {
        await indexEncounter(ctx, store, embeddings, cfg);
      }
    },

    // standard recall: auto-inject relevant memories on each message
    "message.updated": async (input, output) => {
      // TODO: determine current agent from context
      // for now, run standard recall for all agents
      const recalled = await standardRecall(
        input,
        store,
        embeddings,
        cfg.recall.standard,
      );
      if (recalled.length > 0) {
        // inject recalled memories into the message context
        // this will be available to the agent as additional context
        await ctx.client.app.log({
          body: {
            service: "opencode-soul",
            level: "debug",
            message: `Standard recall: ${recalled.length} memories injected`,
          },
        });
      }
    },

    // preserve identity across compaction
    "experimental.session.compacting": async (input, output) => {
      const soul = await readSoul(cfg, "default");
      if (soul) {
        output.context.push(`
## Agent Identity (SOUL.md)
${soul}
`);
      }

      const recent = await store.recent(5);
      if (recent.length > 0) {
        output.context.push(`
## Recent Memories
${recent.map((m) => `- [${m.type}] ${m.content}`).join("\n")}
`);
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
          const name = args.soul || "default";
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
          "Deep recall — use when you need to trace back through past experiences to find specific context. This spawns parallel explorer agents that search through your memory and past encounters from multiple angles. Use when standard recall isn't enough and you need to investigate.",
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
