import type { OpencodeClient, Message, Part } from "@opencode-ai/sdk";
import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";

const TRANSCRIPT_DIR = join(
  process.env.HOME || "/tmp",
  ".config/opencode/soul/curator-transcripts",
);

try {
  mkdirSync(TRANSCRIPT_DIR, { recursive: true });
} catch {}

function logLine(file: string, data: any) {
  appendFileSync(file, JSON.stringify(data) + "\n");
}

const DENIED_TOOLS: Record<string, boolean> = {
  channel_send: false,
  channel_react: false,
  channel_edit: false,
  channel_unsend: false,
  channel_delegate: false,
  channel_list_mine: false,
  channel_discover_agents: false,
  write: false,
  edit: false,
  multiedit: false,
  apply_patch: false,
  todowrite: false,
  soul_edit: false,
  soul_remember: false,
  need_context: false,
  bash: false,
  task: false,
  question: false,
  plan: false,
  websearch: false,
  webfetch: false,
};

const TOOLS = {
  ...DENIED_TOOLS,
  no_context_needed: true,
  include_context: true,
  read: true,
  glob: true,
  grep: true,
};

function buildSystemPrompt(): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const timeStr = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
  const year = now.getFullYear();
  const month = (now.getMonth() + 1).toString().padStart(2, "0");
  const day = now.getDate().toString().padStart(2, "0");
  const jan1 = new Date(now.getFullYear(), 0, 1);
  const days = Math.floor((now.getTime() - jan1.getTime()) / 86400000);
  const week = Math.ceil((days + jan1.getDay() + 1) / 7);
  const weekStr = `w${week.toString().padStart(2, "0")}`;

  return `You are a context curator. You search through memories AND conversation transcripts to find relevant context for an AI agent.

**Current date:** ${dateStr}, ${timeStr}
**Today's transcript:** ~/.config/opencode/soul/transcripts/${year}/${month}/${weekStr}/${year}-${month}-${day}.md

You have access to:
- read: read files
- glob: find files
- grep: search through files for keywords

## Where to search

1. **Memories**: ~/.config/opencode/soul/memory/
   Structured memory files (facts, preferences, patterns, context). Search here first.

2. **Conversation transcripts**: ~/.config/opencode/soul/transcripts/
   Full conversation history from past sessions. Grep these for specific topics, decisions, or discussions.

## Strategy
- Start with grep to find relevant files quickly
- Read the most relevant files for detail
- Be fast. Don't read everything, just what's relevant.

## Transcript structure
Transcripts are organized by date: transcripts/{year}/{month}/{week}/{year}-{month}-{day}.md
Use glob to discover available dates, grep to search across them.

## Output
When you find relevant context, call include_context with a concise summary.
If nothing relevant is found, call no_context_needed.

You MUST call exactly one of these two tools. Be fast and concise.`;
}

const active = new Set<string>();

export function isCurator(session: string) {
  return active.has(session);
}

interface CuratorDeps {
  client: OpencodeClient;
  log: (level: string, msg: string) => Promise<void>;
}

export function curateAsync(
  sessionID: string,
  query: string,
  hints: string | undefined,
  deps: CuratorDeps,
): void {
  runCurator(sessionID, query, hints, deps).catch((err) => {
    deps.log("error", `curator async: ${err}`).catch(() => {});
  });
}

/**
 * Wait for a promptAsync to finish by polling session.get
 */
async function waitForPrompt(
  client: OpencodeClient,
  sessionID: string,
  maxMs: number,
  logFile: string,
): Promise<void> {
  const start = Date.now();
  const POLL_MS = 1_000;
  while (Date.now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    // We can't reliably detect completion from session.get (no status field),
    // so we check if new messages appeared by fetching messages and seeing
    // if the last message has a step-finish with reason "stop" or "cancel"
    try {
      const msgs = await client.session.messages({ path: { id: sessionID } });
      if (msgs.data) {
        const lastMsg = msgs.data[msgs.data.length - 1] as any;
        if (lastMsg?.parts) {
          for (const p of lastMsg.parts) {
            if (p.type === "step-finish" && (p.reason === "stop" || p.reason === "cancel")) {
              logLine(logFile, { type: "prompt_done", reason: p.reason, elapsed: Date.now() - start, timestamp: new Date().toISOString() });
              return;
            }
          }
        }
      }
    } catch {}
  }
  logLine(logFile, { type: "prompt_timeout", elapsed: Date.now() - start, timestamp: new Date().toISOString() });
}

/**
 * Check all messages in a session for include_context or no_context_needed tool calls.
 * Returns the context string, or null if no_context_needed was called, or undefined if neither was called.
 */
function checkForToolCall(messages: any[]): string | null | undefined {
  for (const msg of messages) {
    const m = msg as any;
    if (!m.parts) continue;
    for (const part of m.parts) {
      if (part.type !== "tool") continue;
      const toolName = part.tool || part.name;
      if (toolName === "include_context") {
        try {
          const input = part.state?.input ?? part.input;
          const parsed = typeof input === "string" ? JSON.parse(input) : input;
          const context = parsed?.context;
          return typeof context === "string" && context.trim() ? context.trim() : null;
        } catch {
          return null;
        }
      }
      if (toolName === "no_context_needed") {
        return null;
      }
    }
  }
  // Neither tool was called
  return undefined;
}

async function runCurator(
  sessionID: string,
  query: string,
  hints: string | undefined,
  deps: CuratorDeps,
): Promise<void> {
  const prompt = hints
    ? `Find context about: ${query}\nHints: ${hints}`
    : `Find context about: ${query}`;

  await deps.log("debug", `curator: searching (${query.slice(0, 80)})`);

  const created = await deps.client.session.create({
    body: { title: "soul-curator" },
  });
  if (!created.data) {
    await deps.log("error", "curator: failed to create session");
    return;
  }
  const id = created.data.id;
  active.add(id);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logFile = join(TRANSCRIPT_DIR, `${ts}_${id}.jsonl`);

  logLine(logFile, {
    type: "request",
    sessionID: id,
    callerSessionID: sessionID,
    query,
    hints,
    timestamp: new Date().toISOString(),
    system: buildSystemPrompt(),
    model: "claude-haiku-4-5",
    prompt,
  });

  const MAX_ATTEMPTS = 5;
  const PROMPT_TIMEOUT_MS = 30_000;

  try {
    // First prompt
    try {
      await deps.client.session.promptAsync({
        path: { id },
        body: {
          system: buildSystemPrompt(),
          model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
          tools: TOOLS,
          parts: [{ type: "text" as const, text: prompt }],
        },
      });
      logLine(logFile, { type: "prompt_fired", attempt: 1, timestamp: new Date().toISOString() });
    } catch (promptErr) {
      logLine(logFile, { type: "prompt_error", error: String(promptErr), timestamp: new Date().toISOString() });
      throw promptErr;
    }
    await waitForPrompt(deps.client, id, PROMPT_TIMEOUT_MS, logFile);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Fetch messages and check for tool call
      const msgs = await deps.client.session.messages({ path: { id } });
      const messages = msgs.data || [];

      // Log all messages
      for (const msg of messages) {
        const m = msg as any;
        logLine(logFile, {
          type: "message",
          attempt,
          timestamp: new Date().toISOString(),
          role: m.info?.role,
          parts: m.parts,
        });
      }

      const result = checkForToolCall(messages);

      if (result !== undefined) {
        // Tool was called
        logLine(logFile, { type: "result", context: result, attempt, timestamp: new Date().toISOString() });
        await deps.log("info", `curator: transcript at ${logFile}`);

        if (!result) {
          await deps.log("debug", "curator: no context needed");
          await deps.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: `[Deep Recall] No relevant context found for: ${query}` }],
            },
          }).catch(() => {});
        } else {
          await deps.log("info", `curator: found context (${result.length} chars)`);
          await deps.client.session.prompt({
            path: { id: sessionID },
            body: {
              parts: [{ type: "text", text: `[Deep Recall] Context for "${query}":\n${result}` }],
            },
          }).catch((err) => {
            deps.log("error", `curator: failed to inject context: ${err}`).catch(() => {});
          });
        }
        return;
      }

      // Neither tool was called. Send a follow-up message demanding the tool call.
      logLine(logFile, { type: "no_tool_call", attempt, timestamp: new Date().toISOString() });
      await deps.log("warn", `curator: attempt ${attempt}/${MAX_ATTEMPTS} - no tool call, retrying`);

      await deps.client.session.promptAsync({
        path: { id },
        body: {
          system: buildSystemPrompt(),
          model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
          tools: TOOLS,
          parts: [{
            type: "text" as const,
            text: "You did NOT call include_context or no_context_needed. You MUST call one of these two tools now. Do not output text. Call the tool.",
          }],
        },
      });
      logLine(logFile, { type: "retry_prompt_fired", attempt: attempt + 1, timestamp: new Date().toISOString() });
      await waitForPrompt(deps.client, id, PROMPT_TIMEOUT_MS, logFile);
    }

    // Exhausted all attempts
    logLine(logFile, { type: "exhausted", timestamp: new Date().toISOString() });
    await deps.log("error", `curator: exhausted ${MAX_ATTEMPTS} attempts without tool call`);
    await deps.client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: "text", text: `[Deep Recall] No relevant context found for: ${query}` }],
      },
    }).catch(() => {});
  } finally {
    active.delete(id);
  }
}

function extractCuratorResult(parts: Part[]): string | null {
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const p = part as any;
    const toolName = p.tool || p.name;
    if (toolName === "include_context") {
      try {
        const input = p.state?.input ?? p.input;
        const parsed = typeof input === "string" ? JSON.parse(input) : input;
        const context = parsed?.context;
        return typeof context === "string" && context.trim() ? context.trim() : null;
      } catch {
        return null;
      }
    }
    if (toolName === "no_context_needed") {
      return null;
    }
  }
  return null;
}
