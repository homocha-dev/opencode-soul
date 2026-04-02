import type { OpencodeClient } from "@opencode-ai/sdk";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";

const TRANSCRIPT_BASE = join(
  process.env.HOME || "/tmp",
  ".config/opencode/soul/transcripts",
);

/**
 * Get the file path for today's transcript: transcripts/2026/03/w14/2026-03-31.md
 */
function todayPath(): string {
  const now = new Date();
  const year = now.getFullYear().toString();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");

  // ISO week number
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now.getTime() - jan1.getTime()) / 86400000);
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  const weekStr = `w${week.toString().padStart(2, "0")}`;

  const dir = join(TRANSCRIPT_BASE, year, month, weekStr);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${year}-${month}-${day}.md`);
}

/**
 * Append a single message to today's transcript file. Called live per-message.
 */
export function appendMessage(
  role: string,
  agent: string | undefined,
  parts: any[],
  sessionID: string,
): void {
  const file = todayPath();
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });

  const lines: string[] = [];

  // Add day header if file is new
  if (!existsSync(file)) {
    const today = new Date();
    const dayName = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    lines.push(`# ${dayName}`);
    lines.push("");
  }

  // Skip header for tool_start/tool_end (they just append tool lines)
  if (role !== "tool_start" && role !== "tool_end") {
    const label = agent ? `${role} (${agent})` : role;
    lines.push(`**${label}** — ${time}`);
    lines.push("");
  }

  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.text) {
          lines.push(part.text);
        }
        break;

      case "tool": {
        const toolName = part.tool || part.name || "unknown";
        const status = part.state?.status || "called";
        const input = part.state?.input;
        // Show brief input hint for context
        let hint = "";
        if (input) {
          if (typeof input === "string") {
            hint = `: ${input.slice(0, 80)}`;
          } else if (input.command) {
            hint = `: \`${String(input.command).slice(0, 80)}\``;
          } else if (input.filePath || input.path) {
            hint = `: ${input.filePath || input.path}`;
          } else if (input.text) {
            hint = `: "${String(input.text).slice(0, 60)}"`;
          } else if (input.pattern || input.query) {
            hint = `: ${input.pattern || input.query}`;
          }
        }
        const icon = status === "started" ? "▶" : status === "completed" ? "✅" : status === "error" ? "❌" : "🔧";
        lines.push(`> ${icon} \`${toolName}\`${hint} — ${status}`);
        break;
      }

      case "compaction":
        lines.push("> ♻️ *session compacted*");
        break;

      case "step-start":
      case "step-finish":
        // skip
        break;

      default:
        if (part.text) lines.push(part.text);
        break;
    }
  }

  lines.push("");
  lines.push("---");
  lines.push("");

  appendFileSync(file, lines.join("\n"));
}
