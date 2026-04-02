import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config";
import { createStore } from "./store";
import { createEmbeddings } from "./embeddings";
import { indexEncounter } from "./indexer";
import { readSoul, writeSoul } from "./soul";
import { curateAsync, isCurator } from "./curator";
import { appendMessage as appendTranscript } from "./transcript";

export const SoulPlugin: Plugin = async (ctx) => {
  const cfg = await loadConfig(ctx.directory);
  const store = await createStore(cfg);
  const embeddings = await createEmbeddings();

  const log = async (level: string, msg: string) => {
    await ctx.client.app.log({
      body: { service: "opencode-soul", level: level as any, message: msg },
    });
  };

  await log("info", "Soul plugin initialized");

  // Track which messages we've already logged to avoid duplicates
  const loggedMessages = new Set<string>();

  function soulFor(agent?: string): string | null {
    if (agent && cfg.agents[agent]) return cfg.agents[agent].soul;
    if (cfg.agents["*"]) return cfg.agents["*"].soul;
    return "default";
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle" && cfg.memory.auto_index) {
        await indexEncounter(ctx, store, embeddings, cfg);
      }
    },

    // inject soul + recent memories into system prompt
    "experimental.chat.system.transform": async (_input, output) => {
      const name = soulFor(undefined);
      if (name) {
        const soul = await readSoul(cfg, name);
        if (soul) output.system.push(soul);
      }
      const recent = await store.recent(5);
      if (recent.length > 0) {
        output.system.push(
          `## Recent Memories\n${recent.map((m) => `- [${m.type}] ${m.content}`).join("\n")}`,
        );
      }
    },

    // Log user messages + run curator
    "chat.message": async (input, output) => {
      if (isCurator(input.sessionID)) return;

      // Log user message to transcript LIVE
      try {
        appendTranscript("user", input.agent, output.parts, input.sessionID);
      } catch {}

      // Curator only runs via need_context tool, not auto on every message
    },

    // Log tool start/finish to transcript LIVE
    "tool.execute.before": async (input) => {
      if (isCurator(input.sessionID)) return;
      try {
        const args = (input as any).args || {};
        appendTranscript("tool_start", undefined, [{
          type: "tool",
          tool: input.tool,
          state: { status: "started", input: args },
        }], input.sessionID);
      } catch {}
    },

    "tool.execute.after": async (input) => {
      if (isCurator(input.sessionID)) return;
      try {
        appendTranscript("tool_end", undefined, [{
          type: "tool",
          tool: input.tool,
          state: { status: "completed", input: (input as any).args || {} },
        }], input.sessionID);
      } catch {}
    },

    // Log assistant messages to transcript LIVE
    "experimental.chat.messages.transform": async (_input, output) => {
      for (const msg of output.messages) {
        const info = msg?.info as any;
        if (!info?.id || !info?.role) continue;
        if (loggedMessages.has(info.id)) continue;
        if (info.role !== "assistant") continue;
        if (isCurator(info.sessionID)) continue;
        // Only log if it has real content (text or tool calls)
        const hasContent = msg.parts?.some(
          (p: any) => p.type === "text" || p.type === "tool",
        );
        if (!hasContent) continue;
        loggedMessages.add(info.id);
        try {
          appendTranscript("assistant", info.agent, msg.parts, info.sessionID);
        } catch {}
      }
      // Keep set from growing unbounded
      if (loggedMessages.size > 5000) {
        const arr = [...loggedMessages];
        arr.splice(0, 2500);
        loggedMessages.clear();
        for (const id of arr) loggedMessages.add(id);
      }
    },

    // preserve identity across compaction
    "experimental.session.compacting": async (_input, output) => {
      const name = soulFor(undefined);
      if (name) {
        const soul = await readSoul(cfg, name);
        if (soul) output.context.push(`## Agent Identity (SOUL.md)\n${soul}`);
      }
      const recent = await store.recent(5);
      if (recent.length > 0) {
        output.context.push(
          `## Recent Memories\n${recent.map((m) => `- [${m.type}] ${m.content}`).join("\n")}`,
        );
      }
    },

    tool: {
      // Curator decision tools — used by ephemeral curator sessions only.
      no_context_needed: tool({
        description:
          "[Curator only] Signal that no additional context is needed.",
        args: {},
        async execute() {
          return "No context needed.";
        },
      }),

      include_context: tool({
        description:
          "[Curator only] Return found context to inject into the calling session.",
        args: {
          context: tool.schema.string(
            "The context to inject. Be concise and relevant.",
          ),
        },
        async execute(args) {
          return `Context included: ${args.context.slice(0, 100)}...`;
        },
      }),

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
        async execute(args) {
          const name = args.soul || soulFor(undefined) || "default";
          return writeSoul(cfg, name, args.section, args.content);
        },
      }),

      soul_remember: tool({
        description:
          "Explicitly save a memory. Use this for important facts, preferences, or patterns you want to make sure are remembered.",
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
          "Deep recall — fires off an async search through memory and past conversations. Results arrive as a follow-up message, doesn't block your current response. Use when you feel like you're missing context about something.",
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
          curateAsync(context.sessionID, args.query, args.hints, {
            client: ctx.client,
            log,
          });
          return `Deep recall is searching in the background for: ${args.query}\n\nIMPORTANT: Do NOT continue working yet. The results will arrive as a [Deep Recall] message in the next few seconds. Wait for it before proceeding.`;
        },
      }),
    },
  };
};
