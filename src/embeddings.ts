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

  // in-memory index (loaded from disk cache)
  let vectors: Embedding[] = [];
  let pipeline: any = null;

  // try to load cached vectors
  const cache = Bun.file(join(CACHE_DIR, "vectors.json"));
  if (await cache.exists()) {
    try {
      vectors = await cache.json();
    } catch {
      vectors = [];
    }
  }

  // lazy-load the embedding model
  async function model() {
    if (pipeline) return pipeline;
    try {
      const { pipeline: createPipeline } = await import(
        "@huggingface/transformers"
      );
      pipeline = await createPipeline(
        "feature-extraction",
        "Xenova/all-MiniLM-L6-v2",
      );
      return pipeline;
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
      const pipe = await model();
      if (!pipe) return [];
      const result = await pipe(text, { pooling: "mean", normalize: true });
      return Array.from(result.data as Float32Array);
    },

    async index(memory) {
      const vec = await this.embed(memory.content);
      if (vec.length === 0) return;

      // replace if exists
      vectors = vectors.filter((v) => v.id !== memory.id);
      vectors.push({ id: memory.id, vector: vec });
      await persist();
    },

    async search(query, candidates) {
      const vec = await this.embed(query);
      if (vec.length === 0) return [];

      const scored = vectors
        .map((v) => ({ id: v.id, score: cosine(vec, v.vector) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, candidates);

      return scored;
    },
  };
}
