# opencode-soul

Persistent agent identity and memory for [OpenCode](https://opencode.ai). Give your AI agent a soul — a name, personality, values, and memories that persist across sessions.

## What it does

- **Identity** — Your agent reads a `SOUL.md` file as its system prompt. It knows who it is every session.
- **Memory** — Memories are saved as markdown files and recalled automatically via semantic search (local embeddings, no cloud APIs).
- **Self-editing** — The agent can update its own identity and save new memories using built-in tools.
- **Compaction-safe** — Identity and recent memories survive context compaction so the agent never forgets itself mid-conversation.

## Setup

Add to your `opencode.json`:

```json
{
  "plugin": ["file:///path/to/opencode-soul"]
}
```

Run opencode. On first launch the plugin creates:

```
~/.config/opencode/soul/
  soul.md          <- agent identity (edit this)
  memory/
    fact/           <- things the agent learned
    pattern/        <- recurring behaviors it noticed
    preference/     <- your preferences
    context/        <- project-specific knowledge
    encounter/      <- conversation summaries
```

Edit `~/.config/opencode/soul/soul.md` to give your agent a name and personality:

```markdown
# Soul

I am Koda. I work with Dax on the OpenCode project.

## Personality

- Direct, no filler. Match Dax's energy.
- Casual tone, lowercase in chat.

## Values

- Ship working code, not perfect code.
- Explain the "why" not just the "what."

## About My Human

- Prefers short messages.
- Uses TypeScript and Bun.

## Things I've Learned

- Default branch is dev.
- Tests run from packages/opencode, not root.
```

## How it works

### Auto-recall (every message)

When you send a message, the plugin searches your memories using cosine similarity (fastembed, all-MiniLM-L6-v2, runs locally). Relevant memories are injected into the message context before the LLM sees it. The agent just knows things without needing to use tools.

### Tools

The plugin registers three tools:

| Tool            | What it does                                                                       |
| --------------- | ---------------------------------------------------------------------------------- |
| `soul_edit`     | Edit a section of SOUL.md — the agent updates its own identity                     |
| `soul_remember` | Save a new memory (fact, pattern, preference, or context)                          |
| `need_context`  | Deep recall — searches memory from multiple angles using parallel query strategies |

### Compaction protection

When OpenCode compacts the context window, the plugin injects the agent's identity and recent memories into the compaction prompt so nothing is lost.

## Dependencies

- [fastembed](https://www.npmjs.com/package/fastembed) — local text embeddings via ONNX runtime (all-MiniLM-L6-v2)
- [@opencode-ai/plugin](https://www.npmjs.com/package/@opencode-ai/plugin) — OpenCode plugin SDK

No cloud APIs, no accounts, everything runs locally.

## Storage

All data is plain markdown files on disk at `~/.config/opencode/soul/`. You can read, edit, or delete any of it directly. Memories have YAML frontmatter with id, type, tags, and timestamps.

## License

MIT
