// opencode-soul — persistent agent identity and memory
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { join } from "path";
import { homedir } from "os";
import { mkdir, readdir } from "fs/promises";
import { randomUUID } from "crypto";

// --- Config resolution ---

interface SoulConfig {
  soul: string;
  memory: string;
  threshold: number;
}

function resolve(dir: string): SoulConfig {
  const home = homedir();
  const base = join(home, ".config", "opencode", "soul");
  return {
    soul: join(base, "soul.md"),
    memory: join(base, "memory"),
    threshold: 0.5,
  };
}

// --- Memory ---

interface Memory {
  id: string;
  type: string;
  content: string;
  tags: string[];
  confidence: string;
  created: string;
}

const CATEGORIES = ["fact", "encounter", "pattern", "preference", "context"];

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

function listMemories(dir: string, type?: string): Promise<Memory[]> {
  const dirs = type ? [type] : CATEGORIES;
  return Promise.all(
    dirs.map(async (cat) => {
      const path = join(dir, cat);
      try {
        const files = await readdir(path);
        return Promise.all(
          files
            .filter((f) => f.endsWith(".md"))
            .map(async (f) =>
              parseFrontmatter(await Bun.file(join(path, f)).text()),
            ),
        );
      } catch {
        return [];
      }
    }),
  ).then((all) =>
    all
      .flat()
      .sort(
        (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
      ),
  );
}

// --- Embeddings ---

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
  } catch {
    return null;
  }
}

async function embed(texts: string[]): Promise<number[][]> {
  const model = await initEmbedder();
  if (!model) return [];
  const vecs: number[][] = [];
  for await (const batch of model.embed(texts)) {
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

async function indexAll(dir: string) {
  const memories = await listMemories(dir);
  if (memories.length === 0) return 0;
  const vecs = await embed(memories.map((m) => m.content));
  vectors = memories
    .map((m, i) => ({ id: m.id, vector: vecs[i] }))
    .filter((v) => v.vector);
  return vectors.length;
}

async function search(query: string, n: number) {
  if (vectors.length === 0) return [] as { id: string; score: number }[];
  const [vec] = await embed([query]);
  if (!vec) return [];
  return vectors
    .map((v) => ({ id: v.id, score: cosine(vec, v.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

// --- Soul ---

async function readSoul(path: string) {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

async function editSoul(path: string, section: string, content: string) {
  const file = Bun.file(path);
  let existing = (await file.exists()) ? await file.text() : "# Soul\n";
  const header = "## " + section;
  const idx = existing.indexOf(header);
  if (idx === -1) {
    existing = existing.trimEnd() + "\n\n" + header + "\n" + content + "\n";
  } else {
    const after = existing.indexOf("\n## ", idx + header.length);
    const end = after === -1 ? existing.length : after;
    existing =
      existing.slice(0, idx) +
      header +
      "\n" +
      content +
      "\n" +
      existing.slice(end);
  }
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, existing);
  return "Updated section: " + section;
}

async function saveMem(
  dir: string,
  content: string,
  type: string,
  tags?: string,
) {
  const id = "mem_" + randomUUID().slice(0, 8);
  const path = join(dir, type);
  await mkdir(path, { recursive: true });
  const t = tags ? `[${tags}]` : "[]";
  await Bun.write(
    join(path, id + ".md"),
    `---\nid: ${id}\ntype: ${type}\ncreated: ${new Date().toISOString()}\ntags: ${t}\nconfidence: medium\n---\n${content}\n`,
  );
  const [vec] = await embed([content]);
  if (vec) vectors.push({ id, vector: vec });
  return id;
}

// --- Exported plugin ---

const server: Plugin = async (ctx) => {
  const cfg = resolve(ctx.directory);

  // ensure dirs exist
  for (const cat of CATEGORIES) {
    await mkdir(join(cfg.memory, cat), { recursive: true });
  }

  // create default soul if missing
  const soul = Bun.file(cfg.soul);
  if (!(await soul.exists())) {
    await mkdir(join(cfg.soul, ".."), { recursive: true });
    await Bun.write(
      cfg.soul,
      `# Soul

I am an AI assistant.

## Personality
- (still figuring this out)

## Values
- (none yet)

## About My Human
- (nothing yet)

## Things I've Learned
- (nothing yet)
`,
    );
    await ctx.client.app.log({
      body: {
        service: "soul",
        level: "info",
        message: "Created default soul at " + cfg.soul,
      },
    });
  }

  // index existing memories
  const count = await indexAll(cfg.memory);
  await ctx.client.app.log({
    body: {
      service: "soul",
      level: "info",
      message: `Soul loaded. ${count} memories indexed.`,
    },
  });

  return {
    // inject soul + recent memories into system prompt
    "experimental.chat.system.transform": async (_input, output) => {
      const text = await readSoul(cfg.soul);
      if (text) output.system.push(text);
      const recent = (await listMemories(cfg.memory)).slice(0, 5);
      if (recent.length > 0) {
        output.system.push(
          "## Recent Memories\n" +
            recent.map((m) => `- [${m.type}] ${m.content}`).join("\n"),
        );
      }
    },

    // auto-recall on each user message
    "chat.message": async (_input, output) => {
      const text = output.parts
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text || "")
        .join(" ");
      if (!text) return;

      const hits = await search(text, 5);
      const relevant = hits.filter((h) => h.score >= cfg.threshold);
      if (relevant.length === 0) return;

      const memories = await listMemories(cfg.memory);
      const recalled = relevant
        .map((h) => {
          const mem = memories.find((m) => m.id === h.id);
          return mem
            ? `- [${mem.type}] ${mem.content} (${Math.round(h.score * 100)}%)`
            : null;
        })
        .filter(Boolean);

      if (recalled.length > 0) {
        const first = output.parts.find((p: any) => p.type === "text") as any;
        if (first) {
          first.text = `[Auto-recalled memories]\n${recalled.join("\n")}\n\n[User message]\n${first.text}`;
        }
      }
    },

    // preserve identity across compaction
    "experimental.session.compacting": async (_input, output) => {
      const text = await readSoul(cfg.soul);
      if (text) output.context.push("## Agent Identity\n" + text);
    },

    tool: {
      soul_edit: tool({
        description:
          "Edit a section of your SOUL.md identity file. For identity-level changes only — personality, values, things learned about yourself or your human.",
        args: {
          section: tool.schema.string(
            "Section name (e.g. Personality, Values, About My Human, Things I've Learned)",
          ),
          content: tool.schema.string("New content for the section"),
        },
        async execute(args) {
          return editSoul(cfg.soul, args.section, args.content);
        },
      }),

      soul_remember: tool({
        description:
          "Save a memory for future recall. Use for facts, preferences, patterns, or context worth remembering.",
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
          const id = await saveMem(
            cfg.memory,
            args.content,
            args.type,
            args.tags,
          );
          return "Memory saved: " + id;
        },
      }),

      need_context: tool({
        description:
          "Deep recall — search through your memory from multiple angles. Use when you need context about something from past conversations.",
        args: {
          query: tool.schema.string("What are you trying to remember?"),
          hints: tool.schema.optional(
            tool.schema.string("Hints: timeframe, topics, people"),
          ),
        },
        async execute(args) {
          const queries = [args.query];
          if (args.hints)
            queries.push(args.hints, args.query + " " + args.hints);
          const words = args.query.split(/\s+/).filter((w) => w.length > 3);
          if (words.length > 2) {
            for (let i = 0; i < words.length; i += 2)
              queries.push(words.slice(i, i + 3).join(" "));
          }

          const results = await Promise.all(queries.map((q) => search(q, 10)));
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

          const memories = await listMemories(cfg.memory);
          const top = merged.slice(0, 10);
          if (top.length === 0)
            return "No relevant memories found for: " + args.query;

          let out = `## Deep Recall Results\n\nQuery: ${args.query}\nMemories found: ${merged.length}\n\n`;
          for (const hit of top) {
            const mem = memories.find((m) => m.id === hit.id);
            if (!mem) continue;
            out += `[${mem.type}] ${Math.round(hit.score * 100)}% — ${mem.content}\n\n`;
          }
          return out;
        },
      }),
    },
  };
};

export default { server };
