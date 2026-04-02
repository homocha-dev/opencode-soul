/**
 * E2E tests for the soul plugin.
 *
 * Tests 1-3 and 5 use real implementations (store, embeddings, soul, config)
 * with temp directories. No mocks.
 *
 * Test 4 (curator) requires a running opencode server with an Anthropic API key.
 * It starts a real opencode serve process, creates a real session, and makes a
 * real LLM call. Expects ANTHROPIC_API_KEY in the environment.
 *
 * To start the server for test 4, the test spawns:
 *   bun run --cwd <opencode-packages-dir> --conditions=browser src/index.ts serve --port <port>
 *
 * Set OPENCODE_SRC to the opencode packages/opencode directory if it's not at
 * the default location (../../opencode/packages/opencode relative to this repo).
 *
 * To skip the curator test (no server available), run:
 *   SKIP_CURATOR=1 bun test
 */
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import { join, resolve } from "path";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { spawn } from "child_process";
import { SoulPlugin } from "../src/index";
import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Hooks } from "@opencode-ai/plugin";

// --- helpers ---

const CURATOR_PORT = 14097;
const OPENCODE_SRC =
  process.env.OPENCODE_SRC ||
  resolve(__dirname, "../../opencode/packages/opencode");

let tmp: string;
let hooks: Hooks;

// minimal client stub for tests that don't need a real server
// only stubs app.log (needed for plugin init logging)
function stub() {
  return {
    app: { log: () => Promise.resolve({} as any) },
    session: {
      create: () => {
        throw new Error("real server required");
      },
      prompt: () => {
        throw new Error("real server required");
      },
      delete: () => {
        throw new Error("real server required");
      },
    },
  } as any;
}

async function setup(client?: any) {
  tmp = await mkdtemp(join(tmpdir(), "soul-test-"));
  const soul = join(tmp, "souls");
  await mkdir(soul, { recursive: true });

  await Bun.write(
    join(soul, "default.md"),
    `# Soul

## Personality
- curious and direct

## Values
- honesty

## About My Human
- likes tests
`,
  );

  await Bun.write(
    join(tmp, "soul.json"),
    JSON.stringify({
      souls: { default: { file: join(soul, "default.md") } },
      memory: {
        dir: join(tmp, "memory"),
        encounters_dir: join(tmp, "encounters"),
        auto_index: false,
        categories: ["fact", "encounter", "pattern", "preference", "context"],
      },
    }),
  );

  hooks = await SoulPlugin({
    client: client || stub(),
    project: { id: "test" } as any,
    directory: tmp,
    worktree: tmp,
    serverUrl: new URL("http://localhost:0"),
    $: {} as any,
  });
}

async function teardown() {
  if (tmp) await rm(tmp, { recursive: true, force: true });
}

function ctx() {
  return {
    sessionID: "s1",
    messageID: "m1",
    agent: "default",
    directory: tmp,
    worktree: tmp,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  };
}

// --- tests 1-3, 5: real implementations, temp dirs, no server needed ---

describe("soul plugin e2e", () => {
  beforeEach(async () => {
    await setup();
  });

  afterEach(async () => {
    await teardown();
  });

  test("soul loading + system prompt injection", async () => {
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s1", model: {} as any },
      output,
    );

    expect(output.system.length).toBeGreaterThanOrEqual(1);
    const soul = output.system[0];
    expect(soul).toContain("# Soul");
    expect(soul).toContain("curious and direct");
    expect(soul).toContain("honesty");
    expect(soul).toContain("likes tests");
  });

  test("memory save + recall via tools", async () => {
    const c = ctx();

    // save a memory
    const result = await hooks.tool!.soul_remember.execute(
      {
        content: "Waseem prefers bun over node",
        type: "preference",
        tags: "runtime",
      },
      c,
    );
    expect(result).toContain("Memory saved: mem_");

    // verify the memory file on disk
    const files = await Array.fromAsync(
      new Bun.Glob("**/*.md").scan(join(tmp, "memory", "preference")),
    );
    expect(files.length).toBe(1);
    const raw = await Bun.file(
      join(tmp, "memory", "preference", files[0]),
    ).text();
    expect(raw).toContain("Waseem prefers bun over node");
    expect(raw).toContain("type: preference");
    expect(raw).toContain("source: explicit");

    // save another memory
    await hooks.tool!.soul_remember.execute(
      { content: "Uses TypeScript exclusively", type: "fact" },
      c,
    );

    // verify system prompt now includes recent memories
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s1", model: {} as any },
      output,
    );
    const memories = output.system.find((s) => s.includes("Recent Memories"));
    expect(memories).toBeDefined();
    expect(memories).toContain("Waseem prefers bun over node");

    // deep recall should work (returns results or "no memories" string, never crashes)
    const recall = await hooks.tool!.need_context.execute(
      { query: "what runtime does waseem prefer" },
      c,
    );
    expect(typeof recall).toBe("string");
    expect(recall.length).toBeGreaterThan(0);
  });

  test("soul editing via tool", async () => {
    const c = ctx();

    const result = await hooks.tool!.soul_edit.execute(
      {
        section: "Personality",
        content: "- bold and opinionated\n- dislikes filler",
      },
      c,
    );
    expect(result).toContain("Updated section");

    // verify file
    const soul = await Bun.file(join(tmp, "souls", "default.md")).text();
    expect(soul).toContain("bold and opinionated");
    expect(soul).toContain("dislikes filler");
    expect(soul).not.toContain("curious and direct");
    // other sections preserved
    expect(soul).toContain("honesty");
    expect(soul).toContain("likes tests");

    // add a new section
    const result2 = await hooks.tool!.soul_edit.execute(
      { section: "Habits", content: "- codes late at night" },
      c,
    );
    expect(result2).toContain("Added section");
    const updated = await Bun.file(join(tmp, "souls", "default.md")).text();
    expect(updated).toContain("## Habits");
    expect(updated).toContain("codes late at night");

    // verify system prompt reflects edits
    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s1", model: {} as any },
      output,
    );
    expect(output.system[0]).toContain("bold and opinionated");
    expect(output.system[0]).toContain("codes late at night");
  });

  test("compaction preserves identity", async () => {
    // save some memories first so compaction includes them
    const c = ctx();
    await hooks.tool!.soul_remember.execute(
      { content: "important context about the project", type: "context" },
      c,
    );

    const output = {
      context: [] as string[],
      prompt: undefined as string | undefined,
    };
    await hooks["experimental.session.compacting"]!(
      { sessionID: "s1" },
      output,
    );

    // soul identity preserved
    expect(output.context.length).toBeGreaterThanOrEqual(1);
    const identity = output.context.find((c) => c.includes("Agent Identity"));
    expect(identity).toBeDefined();
    expect(identity).toContain("# Soul");
    expect(identity).toContain("curious and direct");
    expect(identity).toContain("honesty");

    // recent memories preserved
    const memories = output.context.find((c) => c.includes("Recent Memories"));
    expect(memories).toBeDefined();
    expect(memories).toContain("important context about the project");
  });
});

// --- test 4: curator with real opencode server + real LLM call ---

describe("curator e2e", () => {
  let proc: ReturnType<typeof spawn> | null = null;
  let client: ReturnType<typeof createOpencodeClient> | null = null;

  beforeAll(async () => {
    if (process.env.SKIP_CURATOR) return;

    // start real opencode server
    proc = spawn(
      "bun",
      [
        "run",
        "--conditions=browser",
        "src/index.ts",
        "serve",
        "--port",
        String(CURATOR_PORT),
      ],
      {
        cwd: OPENCODE_SRC,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      },
    );

    // wait for server to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("server start timeout")),
        15000,
      );
      let output = "";
      proc!.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("listening")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      proc!.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      proc!.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      proc!.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`server exited with code ${code}\n${output}`));
      });
    });

    client = createOpencodeClient({
      baseUrl: `http://127.0.0.1:${CURATOR_PORT}`,
    });
  });

  afterAll(async () => {
    if (proc) {
      proc.kill();
      proc = null;
    }
    client = null;
  });

  test("curator makes real LLM call via opencode session", async () => {
    if (process.env.SKIP_CURATOR) {
      console.log("SKIP_CURATOR set, skipping curator e2e test");
      return;
    }
    if (!client) throw new Error("opencode server not started");

    // build a real client that wraps the server client with app.log
    const real = {
      ...client,
      app: {
        ...client.app,
        log: client.app.log,
      },
    } as any;

    await setup(real);

    const input = {
      sessionID: "curator-test",
      agent: "default",
    };
    const output = {
      message: {} as any,
      parts: [
        {
          id: "p1",
          type: "text" as const,
          text: "What was the plaid sync project we were working on? I need to check the transaction import status.",
        },
      ],
    };

    const start = Date.now();
    await hooks["chat.message"]!(input, output as any);
    const elapsed = Date.now() - start;

    // should have taken real time (LLM call)
    console.log(`curator e2e took ${elapsed}ms`);
    expect(elapsed).toBeGreaterThan(500);

    // the text part should still exist (either with injected context or original)
    const text = output.parts[0].text;
    expect(text).toContain("plaid sync");
  }, 60000); // 60s timeout for real LLM call
});
