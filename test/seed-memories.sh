#!/bin/bash
# Seed test memories for recall testing
MEMORY_DIR="/tmp/opencode-soul-test/memory"

mkdir -p "$MEMORY_DIR/fact" "$MEMORY_DIR/pattern" "$MEMORY_DIR/preference" "$MEMORY_DIR/context" "$MEMORY_DIR/encounter"

cat > "$MEMORY_DIR/fact/mem_001.md" << 'EOF'
---
id: mem_001
type: fact
created: 2026-03-25T10:00:00Z
tags: [bun, runtime]
confidence: high
---
The opencode project uses Bun as its JavaScript runtime, not Node.js. Always use Bun APIs like Bun.file() instead of fs.readFileSync().
EOF

cat > "$MEMORY_DIR/fact/mem_002.md" << 'EOF'
---
id: mem_002
type: fact
created: 2026-03-25T11:00:00Z
tags: [git, branch]
confidence: high
---
The default branch in the opencode repository is dev, not main. Always use dev or origin/dev for diffs and comparisons.
EOF

cat > "$MEMORY_DIR/pattern/mem_003.md" << 'EOF'
---
id: mem_003
type: pattern
created: 2026-03-26T09:00:00Z
tags: [testing, debugging]
confidence: high
---
Tests in the opencode repo cannot be run from the repository root. They must be run from individual package directories like packages/opencode. This is guarded by a do-not-run-tests-from-root check.
EOF

cat > "$MEMORY_DIR/preference/mem_004.md" << 'EOF'
---
id: mem_004
type: preference
created: 2026-03-26T14:00:00Z
tags: [communication, style]
confidence: high
---
Dax prefers short messages over long explanations. Keep responses concise and avoid walls of text. Use lowercase in casual conversations.
EOF

cat > "$MEMORY_DIR/preference/mem_005.md" << 'EOF'
---
id: mem_005
type: preference
created: 2026-03-27T08:00:00Z
tags: [code, style]
confidence: high
---
The codebase enforces single-word variable names. Multi-word names like inputPID or existingClient are discouraged. Use short names like pid, cfg, err, opts.
EOF

cat > "$MEMORY_DIR/context/mem_006.md" << 'EOF'
---
id: mem_006
type: context
created: 2026-03-27T10:00:00Z
tags: [architecture, plugins]
confidence: high
---
OpenCode plugins hook into events via a Hooks interface. Key hooks are: experimental.chat.system.transform for system prompt injection, chat.message for intercepting messages, experimental.session.compacting for preserving context during compaction. Plugins can also register custom tools.
EOF

cat > "$MEMORY_DIR/encounter/mem_007.md" << 'EOF'
---
id: mem_007
type: encounter
created: 2026-03-28T15:00:00Z
tags: [memory, architecture, design]
confidence: high
---
Had a conversation about building a persistent memory system for AI agents. Discussed two tiers of recall: standard (vector search + LLM rerank, runs every message) and deep (parallel sub-agents that trace through encounter logs). Also discussed auto-indexing conversations after sessions end.
EOF

cat > "$MEMORY_DIR/encounter/mem_008.md" << 'EOF'
---
id: mem_008
type: encounter
created: 2026-03-28T16:00:00Z
tags: [soul, identity, plugin]
confidence: high
---
Built the opencode-soul plugin. It injects a SOUL.md identity file into the system prompt and provides tools for the agent to edit its own identity (soul_edit) and save memories (soul_remember). Successfully tested all three features working end to end.
EOF

echo "Seeded 8 test memories in $MEMORY_DIR"
