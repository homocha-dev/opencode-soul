import { join } from "path";
import { homedir } from "os";

export interface SoulConfig {
  agents: Record<
    string,
    {
      soul: string | null;
      recall: { standard: boolean; deep: boolean };
    }
  >;
  souls: Record<string, { file: string }>;
  memory: {
    dir: string;
    encounters_dir: string;
    auto_index: boolean;
    categories: string[];
  };
  recall: {
    standard: {
      candidates: number;
      results: number;
      threshold: number;
    };
    deep: {
      explorers: number;
      max_encounters: number;
    };
  };
}

const defaults: SoulConfig = {
  agents: {
    "*": {
      soul: "default",
      recall: { standard: true, deep: true },
    },
  },
  souls: {
    default: {
      file: "~/.config/opencode/souls/default.md",
    },
  },
  memory: {
    dir: "~/.config/opencode/memory",
    encounters_dir: "~/.config/opencode/encounters",
    auto_index: true,
    categories: ["fact", "encounter", "pattern", "preference", "context"],
  },
  recall: {
    standard: {
      candidates: 10,
      results: 5,
      threshold: 0.6,
    },
    deep: {
      explorers: 5,
      max_encounters: 10,
    },
  },
};

function resolve(path: string): string {
  if (path.startsWith("~")) return join(homedir(), path.slice(1));
  return path;
}

export async function loadConfig(dir: string): Promise<SoulConfig> {
  const paths = [
    join(dir, "soul.json"),
    join(dir, ".opencode", "soul.json"),
    join(homedir(), ".config", "opencode", "soul.json"),
  ];

  for (const path of paths) {
    const file = Bun.file(path);
    if (await file.exists()) {
      const raw = await file.json();
      const cfg = { ...defaults, ...raw };
      // resolve all paths
      for (const soul of Object.values(cfg.souls)) {
        soul.file = resolve(soul.file);
      }
      cfg.memory.dir = resolve(cfg.memory.dir);
      cfg.memory.encounters_dir = resolve(cfg.memory.encounters_dir);
      return cfg;
    }
  }

  // resolve defaults
  const cfg = { ...defaults };
  for (const soul of Object.values(cfg.souls)) {
    soul.file = resolve(soul.file);
  }
  cfg.memory.dir = resolve(cfg.memory.dir);
  cfg.memory.encounters_dir = resolve(cfg.memory.encounters_dir);
  return cfg;
}
