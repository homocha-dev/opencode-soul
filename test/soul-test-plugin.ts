// Minimal inline plugin for testing soul functionality
import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { join } from "path";
import { mkdir } from "fs/promises";
import { randomUUID } from "crypto";

const SOUL_FILE = "/tmp/opencode-soul-test/souls/test.md";
const MEMORY_DIR = "/tmp/opencode-soul-test/memory";

async function readSoul(): Promise<string | null> {
  const file = Bun.file(SOUL_FILE);
  if (!(await file.exists())) return null;
  return file.text();
}

export const SoulPlugin: Plugin = async (ctx) => {
  await ctx.client.app.log({
    body: { service: "soul", level: "info", message: "Soul plugin loaded" },
  });

  return {
    // inject soul into system prompt
    "experimental.chat.system.transform": async (input, output) => {
      const soul = await readSoul();
      if (soul) {
        output.system.push(soul);
      }
    },

    // preserve soul across compaction
    "experimental.session.compacting": async (input, output) => {
      const soul = await readSoul();
      if (soul) {
        output.context.push("## Agent Identity (SOUL.md)\n" + soul);
      }
    },

    tool: {
      soul_edit: tool({
        description: "Edit a section of your SOUL.md identity file.",
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
        },
        async execute(args) {
          const id = "mem_" + randomUUID().slice(0, 8);
          const dir = join(MEMORY_DIR, args.type);
          await mkdir(dir, { recursive: true });
          const md =
            "---\nid: " +
            id +
            "\ntype: " +
            args.type +
            "\ncreated: " +
            new Date().toISOString() +
            "\n---\n" +
            args.content +
            "\n";
          await Bun.write(join(dir, id + ".md"), md);
          return "Memory saved: " + id;
        },
      }),
    },
  };
};
