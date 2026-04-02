import type { Memory } from "./store";
import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";

interface Embedding {
  id: string;
  vector: number[];
}

interface EmbeddingsEngine {
  embed(text: string): Promise<number[]>;
  index(memory: Memory): Promise<void>;
  search(
    query: string,
    candidates: number,
  ): Promise<{ id: string; score: number }[]>;
  ready: boolean;
}

const CACHE_DIR = join(homedir(), ".config", "opencode", "soul-embeddings");

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function createEmbeddings(): Promise<EmbeddingsEngine> {
  await mkdir(CACHE_DIR, { recursive: true });

  let vectors: Embedding[] = [];
  let embedder: any = null;

  // load cached vectors from disk
  const cache = Bun.file(join(CACHE_DIR, "vectors.json"));
  if (await cache.exists()) {
    try {
      vectors = await cache.json();
    } catch {
      vectors = [];
    }
  }

  // lazy-load fastembed model
  async function model() {
    if (embedder) return embedder;
    try {
      const { EmbeddingModel, FlagEmbedding } = await import("fastembed");
      embedder = await FlagEmbedding.init({
        model: EmbeddingModel.AllMiniLML6V2,
        cacheDir: join(CACHE_DIR, "models"),
      });
      return embedder;
    } catch (err) {
      console.error("Failed to load embedding model:", err);
      return null;
    }
  }

  async function persist() {
    await Bun.write(join(CACHE_DIR, "vectors.json"), JSON.stringify(vectors));
  }

  return {
    ready: true,

    async embed(text) {
      const m = await model();
      if (!m) return [];
      return m.queryEmbed(text);
    },

    async index(memory) {
      const vec = await this.embed(memory.content);
      if (vec.length === 0) return;

      vectors = vectors.filter((v) => v.id !== memory.id);
      vectors.push({ id: memory.id, vector: vec });
      await persist();
    },

    async search(query, candidates) {
      const vec = await this.embed(query);
      if (vec.length === 0) return [];

      return vectors
        .map((v) => ({ id: v.id, score: cosine(vec, v.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidates);
    },
  };
}
