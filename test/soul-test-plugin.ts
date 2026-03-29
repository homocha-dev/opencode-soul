// Full test plugin with identity, memory, and recall
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { join } from "path";
import { mkdir, readdir } from "fs/promises";
import { randomUUID } from "crypto";

const SOUL_FILE = "/tmp/opencode-soul-test/souls/test.md";
const MEMORY_DIR = "/tmp/opencode-soul-test/memory";
const ENCOUNTERS_DIR = "/tmp/opencode-soul-test/encounters";
const CATEGORIES = ["fact", "encounter", "pattern", "preference", "context"];

// --- Memory types ---

interface Memory {
  id: string;
  type: string;
  content: string;
  tags: string[];
  confidence: string;
  created: string;
}

// --- Memory store ---

function parseFrontmatter(raw: string): Memory {
  const end = raw.indexOf("---", 3);
  const front = raw.slice(3, end).trim();
  const content = raw.slice(end + 3).trim();
  const fields: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  const tags = (fields.tags || "[]")
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return {
    id: fields.id || "",
    type: fields.type || "fact",
    content,
    tags,
    confidence: fields.confidence || "medium",
    created: fields.created || "",
  };
}

async function listMemories(type?: string): Promise<Memory[]> {
  const dirs = type ? [type] : CATEGORIES;
  const all: Memory[] = [];
  for (const dir of dirs) {
    const path = join(MEMORY_DIR, dir);
    try {
      const files = await readdir(path);
      for (const file of files) {
        if (!file.endsWith(".md")) continue;
        const raw = await Bun.file(join(path, file)).text();
        all.push(parseFrontmatter(raw));
      }
    } catch {}
  }
  return all.sort(
    (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
  );
}

// --- Embeddings via fastembed ---

let embedder: any = null;
let vectors: { id: string; vector: number[] }[] = [];

async function initEmbedder() {
  if (embedder) return embedder;
  try {
    const { EmbeddingModel, FlagEmbedding } = await import("fastembed");
    embedder = await FlagEmbedding.init({
      model: EmbeddingModel.AllMiniLML6V2,
    });
    return embedder;
  } catch (err) {
    console.error("Fastembed failed to load:", err);
    return null;
  }
}

async function embed(texts: string[]): Promise<number[][]> {
  const model = await initEmbedder();
  if (!model) return [];
  const result = model.embed(texts);
  const vecs: number[][] = [];
  for await (const batch of result) {
    for (const vec of batch) vecs.push(Array.from(vec));
  }
  return vecs;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function indexAll() {
  const memories = await listMemories();
  if (memories.length === 0) return 0;
  const texts = memories.map((m) => m.content);
  const vecs = await embed(texts);
  vectors = memories
    .map((m, i) => ({ id: m.id, vector: vecs[i] }))
    .filter((v) => v.vector);
  return vectors.length;
}

async function search(
  query: string,
  n: number,
): Promise<{ id: string; score: number }[]> {
  if (vectors.length === 0) return [];
  const [vec] = await embed([query]);
  if (!vec) return [];
  return vectors
    .map((v) => ({ id: v.id, score: cosine(vec, v.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// --- Soul helpers ---

async function readSoul(): Promise<string | null> {
  const file = Bun.file(SOUL_FILE);
  if (!(await file.exists())) return null;
  return file.text();
}

// --- Realtime indexer ---

// track messages per session for indexing
const sessions: Map<string, { user: string[]; assistant: string[] }> =
  new Map();
// debounce indexing to avoid running on every single part update
const pending: Map<string, ReturnType<typeof setTimeout>> = new Map();

async function indexExchange(
  sessionID: string,
  userText: string,
  assistantText: string,
  ctx: any,
) {
  // skip trivial exchanges
  if (userText.length < 20 && assistantText.length < 50) return;

  // save as encounter memory
  const id = "mem_" + randomUUID().slice(0, 8);
  const dir = join(MEMORY_DIR, "encounter");
  await mkdir(dir, { recursive: true });
  const content = `User asked: ${userText.slice(0, 200)}\nAssistant responded: ${assistantText.slice(0, 500)}`;
  const md = `---\nid: ${id}\ntype: encounter\ncreated: ${new Date().toISOString()}\ntags: [auto-indexed]\nconfidence: medium\nsession: ${sessionID}\n---\n${content}\n`;
  await Bun.write(join(dir, id + ".md"), md);

  // index the embedding
  const [vec] = await embed([content]);
  if (vec) vectors.push({ id, vector: vec });

  await ctx.client.app.log({
    body: {
      service: "soul",
      level: "info",
      message: `Auto-indexed encounter: ${id}`,
    },
  });
}

// --- Plugin ---

export const SoulPlugin: Plugin = async (ctx) => {
  await ctx.client.app.log({
    body: { service: "soul", level: "info", message: "Soul plugin loading..." },
  });

  // index all existing memories at startup
  const count = await indexAll();
  await ctx.client.app.log({
    body: {
      service: "soul",
      level: "info",
      message: `Indexed ${count} memories`,
    },
  });

  return {
    // realtime indexer — listen for message events
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;
      const data = event.properties as any;
      if (!data?.sessionID || !data?.info) return;

      const sid = data.sessionID;
      if (!sessions.has(sid)) sessions.set(sid, { user: [], assistant: [] });
      const session = sessions.get(sid)!;

      if (data.info.role === "user") {
        // extract text from user message parts
        const parts = data.info.parts || [];
        const text = parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text || "")
          .join(" ")
          .trim();
        if (text) session.user.push(text);
      }

      if (data.info.role === "assistant") {
        // debounce: assistant messages update many times (streaming)
        // wait 2s after last update before indexing
        const existing = pending.get(sid);
        if (existing) clearTimeout(existing);

        pending.set(
          sid,
          setTimeout(async () => {
            pending.delete(sid);
            try {
              // fetch the latest assistant text
              const result = await ctx.client.session.messages({
                path: { sessionID: sid },
              });
              if (!result.data) return;
              const messages = result.data as any[];

              // find the last user + assistant pair
              let lastUser = "";
              let lastAssistant = "";
              for (const msg of messages) {
                if (msg.role === "user") {
                  const text = (msg.parts || [])
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text || "")
                    .join(" ")
                    .trim();
                  if (text) lastUser = text;
                }
                if (msg.role === "assistant") {
                  const text = (msg.parts || [])
                    .filter((p: any) => p.type === "text")
                    .map((p: any) => p.text || "")
                    .join(" ")
                    .trim();
                  if (text) lastAssistant = text;
                }
              }

              if (lastUser && lastAssistant) {
                await indexExchange(sid, lastUser, lastAssistant, ctx);
              }
            } catch (err) {
              await ctx.client.app.log({
                body: {
                  service: "soul",
                  level: "error",
                  message: `Auto-indexer error: ${err}`,
                },
              });
            }
          }, 2000),
        );
      }
    },

    // inject soul into system prompt
    "experimental.chat.system.transform": async (_input, output) => {
      const soul = await readSoul();
      if (soul) output.system.push(soul);

      // inject recent memories
      const recent = (await listMemories()).slice(0, 5);
      if (recent.length > 0) {
        output.system.push(
          "## Recent Memories\n" +
            recent.map((m) => `- [${m.type}] ${m.content}`).join("\n"),
        );
      }
    },

    // standard recall on each user message
    "chat.message": async (input, output) => {
      let text = output.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text || "")
        .join(" ");
      if (!text) return;

      const hits = await search(text, 5);
      const threshold = 0.5; // cosine similarity threshold
      const relevant = hits.filter((h) => h.score >= threshold);
      if (relevant.length === 0) return;

      const memories = await listMemories();
      const recalled = relevant
        .map((h) => {
          const mem = memories.find((m) => m.id === h.id);
          if (!mem) return null;
          return `- [${mem.type}] ${mem.content} (${Math.round(h.score * 100)}% match)`;
        })
        .filter(Boolean);

      if (recalled.length > 0) {
        // prepend recalled memories to the first text part instead of inserting a new part
        const first = output.parts.find((p: any) => p.type === "text") as any;
        if (first) {
          first.text = `[Auto-recalled memories]\n${recalled.join("\n")}\n\n[User message]\n${first.text}`;
        }

        await ctx.client.app.log({
          body: {
            service: "soul",
            level: "info",
            message: `Recalled ${recalled.length} memories`,
          },
        });
      }
    },

    // preserve identity across compaction
    "experimental.session.compacting": async (_input, output) => {
      const soul = await readSoul();
      if (soul) output.context.push("## Agent Identity\n" + soul);
    },

    tool: {
      soul_edit: tool({
        description:
          "Edit a section of your SOUL.md identity file. For identity-level changes only.",
        args: {
          section: tool.schema.string("Section name to edit"),
          content: tool.schema.string("New content for the section"),
        },
        async execute(args) {
          const file = Bun.file(SOUL_FILE);
          let existing = await file.text();
          const header = "## " + args.section;
          const idx = existing.indexOf(header);
          if (idx === -1) {
            existing =
              existing.trimEnd() + "\n\n" + header + "\n" + args.content + "\n";
          } else {
            const after = existing.indexOf("\n## ", idx + header.length);
            const end = after === -1 ? existing.length : after;
            existing =
              existing.slice(0, idx) +
              header +
              "\n" +
              args.content +
              "\n" +
              existing.slice(end);
          }
          await Bun.write(SOUL_FILE, existing);
          return "Updated section: " + args.section;
        },
      }),

      soul_remember: tool({
        description: "Save a memory for future recall.",
        args: {
          content: tool.schema.string("Memory content"),
          type: tool.schema.string(
            "Type: fact | pattern | preference | context",
          ),
          tags: tool.schema.optional(
            tool.schema.string("Comma-separated tags"),
          ),
        },
        async execute(args) {
          const id = "mem_" + randomUUID().slice(0, 8);
          const dir = join(MEMORY_DIR, args.type);
          await mkdir(dir, { recursive: true });
          const tags = args.tags ? `[${args.tags}]` : "[]";
          const md = `---\nid: ${id}\ntype: ${args.type}\ncreated: ${new Date().toISOString()}\ntags: ${tags}\nconfidence: medium\n---\n${args.content}\n`;
          await Bun.write(join(dir, id + ".md"), md);
          // index the new memory
          const [vec] = await embed([args.content]);
          if (vec) vectors.push({ id, vector: vec });
          return "Memory saved: " + id;
        },
      }),

      need_context: tool({
        description:
          "Deep recall — search through your memory from multiple angles when you need more context about something. Returns relevant memories with similarity scores.",
        args: {
          query: tool.schema.string("What are you trying to remember?"),
          hints: tool.schema.optional(
            tool.schema.string("Hints: timeframe, topics, people, etc"),
          ),
        },
        async execute(args) {
          // parallel exploration strategies
          const queries = [args.query];
          if (args.hints)
            queries.push(args.hints, args.query + " " + args.hints);

          // also decompose query into sub-queries
          const words = args.query.split(/\s+/).filter((w) => w.length > 3);
          if (words.length > 2) {
            for (let i = 0; i < words.length; i += 2) {
              queries.push(words.slice(i, i + 3).join(" "));
            }
          }

          // run all searches in parallel
          const results = await Promise.all(queries.map((q) => search(q, 10)));

          // merge and deduplicate
          const seen = new Set<string>();
          const merged: { id: string; score: number }[] = [];
          for (const hits of results) {
            for (const hit of hits) {
              if (seen.has(hit.id)) continue;
              seen.add(hit.id);
              merged.push(hit);
            }
          }
          merged.sort((a, b) => b.score - a.score);

          const memories = await listMemories();
          const top = merged.slice(0, 10);

          if (top.length === 0)
            return "No relevant memories found for: " + args.query;

          let output = "## Deep Recall Results\n\n";
          output += "**Query:** " + args.query + "\n";
          if (args.hints) output += "**Hints:** " + args.hints + "\n";
          output += "**Strategies used:** " + queries.length + "\n";
          output += "**Unique memories found:** " + merged.length + "\n\n";

          for (const hit of top) {
            const mem = memories.find((m) => m.id === hit.id);
            if (!mem) continue;
            output += `### [${mem.type}] ${Math.round(hit.score * 100)}% match\n`;
            output += mem.content + "\n";
            if (mem.tags.length)
              output += "Tags: " + mem.tags.join(", ") + "\n";
            output += "\n";
          }

          return output;
        },
      }),
    },
  };
};
