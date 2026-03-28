import type { SoulConfig } from "./config";
import { join } from "path";
import { mkdir, readdir } from "fs/promises";
import { randomUUID } from "crypto";

export interface Memory {
  id: string;
  type: "fact" | "encounter" | "pattern" | "preference" | "context";
  content: string;
  tags: string[];
  project: string;
  session?: string;
  source: "explicit" | "auto-index";
  source_encounter?: string;
  confidence: "high" | "medium" | "low";
  created: string;
}

export interface MemoryStore {
  save(input: {
    content: string;
    type: Memory["type"];
    tags: string[];
    project: string;
    session?: string;
    source: Memory["source"];
    source_encounter?: string;
    confidence?: Memory["confidence"];
  }): Promise<Memory>;
  list(type?: Memory["type"]): Promise<Memory[]>;
  recent(n: number): Promise<Memory[]>;
  get(id: string): Promise<Memory | null>;
  search(query: string): Promise<Memory[]>;
  encounters(): Promise<string[]>;
  readEncounter(id: string): Promise<string | null>;
  saveEncounter(id: string, content: string): Promise<void>;
}

function toFrontmatter(mem: Memory): string {
  return `---
id: ${mem.id}
type: ${mem.type}
created: ${mem.created}
project: ${mem.project}
${mem.session ? `session: ${mem.session}` : ""}
${mem.source_encounter ? `source_encounter: ${mem.source_encounter}` : ""}
source: ${mem.source}
confidence: ${mem.confidence}
tags: [${mem.tags.join(", ")}]
---
${mem.content}
`;
}

function parseFrontmatter(raw: string): Memory {
  const end = raw.indexOf("---", 3);
  const front = raw.slice(3, end).trim();
  const content = raw.slice(end + 3).trim();

  const fields: Record<string, string> = {};
  for (const line of front.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const val = line.slice(colon + 1).trim();
    fields[key] = val;
  }

  const tags = (fields.tags || "[]")
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    id: fields.id || randomUUID(),
    type: (fields.type || "fact") as Memory["type"],
    content,
    tags,
    project: fields.project || "",
    session: fields.session || undefined,
    source: (fields.source || "explicit") as Memory["source"],
    source_encounter: fields.source_encounter || undefined,
    confidence: (fields.confidence || "medium") as Memory["confidence"],
    created: fields.created || new Date().toISOString(),
  };
}

export async function createStore(cfg: SoulConfig): Promise<MemoryStore> {
  // ensure directories exist
  for (const cat of cfg.memory.categories) {
    await mkdir(join(cfg.memory.dir, cat), { recursive: true });
  }
  await mkdir(cfg.memory.encounters_dir, { recursive: true });

  return {
    async save(input) {
      const mem: Memory = {
        id: `mem_${randomUUID().slice(0, 8)}`,
        type: input.type,
        content: input.content,
        tags: input.tags,
        project: input.project,
        session: input.session,
        source: input.source,
        source_encounter: input.source_encounter,
        confidence: input.confidence || "medium",
        created: new Date().toISOString(),
      };

      const dir = join(cfg.memory.dir, mem.type);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${mem.id}.md`);
      await Bun.write(path, toFrontmatter(mem));
      return mem;
    },

    async list(type) {
      const dirs = type ? [type] : cfg.memory.categories;
      const all: Memory[] = [];

      for (const dir of dirs) {
        const path = join(cfg.memory.dir, dir);
        try {
          const files = await readdir(path);
          for (const file of files) {
            if (!file.endsWith(".md")) continue;
            const raw = await Bun.file(join(path, file)).text();
            all.push(parseFrontmatter(raw));
          }
        } catch {
          // directory doesn't exist yet
        }
      }

      return all.sort(
        (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
      );
    },

    async recent(n) {
      const all = await this.list();
      return all.slice(0, n);
    },

    async get(id) {
      const all = await this.list();
      return all.find((m) => m.id === id) || null;
    },

    async search(query) {
      const all = await this.list();
      const lower = query.toLowerCase();
      return all.filter(
        (m) =>
          m.content.toLowerCase().includes(lower) ||
          m.tags.some((t) => t.toLowerCase().includes(lower)),
      );
    },

    async encounters() {
      try {
        const files = await readdir(cfg.memory.encounters_dir);
        return files
          .filter((f) => f.endsWith(".md"))
          .sort()
          .reverse();
      } catch {
        return [];
      }
    },

    async readEncounter(id) {
      const path = join(cfg.memory.encounters_dir, `${id}.md`);
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      return file.text();
    },

    async saveEncounter(id, content) {
      const path = join(cfg.memory.encounters_dir, `${id}.md`);
      await Bun.write(path, content);
    },
  };
}
