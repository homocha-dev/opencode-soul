#!/bin/bash
# Multi-turn test to verify indexing and recall across separate sessions
set -e

OPENCODE_SRC="/Users/mocha/.openclaw/workspace/opencode/packages/opencode"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="/tmp/opencode-soul-test"

# fresh start
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/.opencode/plugins" "$TEST_DIR/souls" "$TEST_DIR/memory" "$TEST_DIR/encounters"
cd "$TEST_DIR"
git init -q && git config user.email "test@test.com" && git config user.name "test"
echo "test" > README.md && git add . && git commit -q -m "init"

# copy plugin
cp "$PLUGIN_DIR/test/soul-test-plugin.ts" "$TEST_DIR/.opencode/plugins/soul.ts"

# deps
cat > "$TEST_DIR/.opencode/package.json" << 'EOF'
{ "dependencies": { "@opencode-ai/plugin": "*", "fastembed": "^2.1.0" } }
EOF

# soul
cat > "$TEST_DIR/souls/test.md" << 'EOF'
# Soul

I am Echo, a test agent.

## Personality
- Direct, concise, no filler.
- I always introduce myself as Echo.

## Values
- Accuracy matters.

## About My Human
- (nothing yet)

## Things I've Learned
- (nothing yet)
EOF

# config
cat > "$TEST_DIR/opencode.json" << 'EOF'
{ "$schema": "https://opencode.ai/config.json", "instructions": ["/tmp/opencode-soul-test/souls/test.md"] }
EOF

run() {
  local prompt="$1"
  local label="$2"
  echo ""
  echo "========================================="
  echo "TURN: $label"
  echo "PROMPT: $prompt"
  echo "========================================="
  cd "$TEST_DIR"
  bun run --conditions=browser "$OPENCODE_SRC/src/index.ts" -- run --format json "$prompt" 2>&1 | while IFS= read -r line; do
    type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
    case "$type" in
      text)
        text=$(echo "$line" | jq -r '.part.text // empty' 2>/dev/null)
        [ -n "$text" ] && echo "  [AGENT] $text"
        ;;
      tool_use)
        t=$(echo "$line" | jq -r '.part.tool // empty' 2>/dev/null)
        state=$(echo "$line" | jq -r '.part.state.status // empty' 2>/dev/null)
        if [ "$state" = "completed" ]; then
          out=$(echo "$line" | jq -r '.part.state.output // empty' 2>/dev/null | head -2)
          echo "  [TOOL: $t] $out"
        fi
        ;;
    esac
  done
  echo ""
  echo "  Memory count: $(find "$TEST_DIR/memory" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
}

echo ""
echo "=== MULTI-TURN MEMORY TEST ==="
echo ""

# Turn 1: Establish identity and teach it something
run "Hi! My name is Dax and I work on the opencode project. Please use soul_remember to save this fact, and use soul_edit to update About My Human." "1 - introduce yourself"

echo ""
echo "--- Soul after turn 1 ---"
cat "$TEST_DIR/souls/test.md"

# Turn 2: Teach it a preference  
run "I prefer using TypeScript over JavaScript, and I always want you to suggest Bun APIs over Node APIs. Save both of these as preferences." "2 - teach preferences"

# Turn 3: Ask it to recall what it knows
run "What do you know about me? Use the need_context tool to search your memories." "3 - test recall"

# Turn 4: Teach it a code pattern
run "When writing tests in this project, always use bun test and run from packages/opencode, never from root. Save this as a pattern." "4 - teach a pattern"

# Turn 5: Ask something that should trigger auto-recall from earlier memories
run "How should I run tests in this project?" "5 - test auto-recall"

# Turn 6: Ask it who it is to verify soul identity persists
run "Who are you and what do you know about your human?" "6 - verify identity"

echo ""
echo "========================================="
echo "FINAL STATE"
echo "========================================="
echo ""
echo "--- SOUL.md ---"
cat "$TEST_DIR/souls/test.md"
echo ""
echo "--- All memories ---"
find "$TEST_DIR/memory" -name "*.md" -exec echo "---" \; -exec cat {} \; 2>/dev/null
echo ""
echo "--- Memory count by type ---"
for type in fact encounter pattern preference context; do
  count=$(find "$TEST_DIR/memory/$type" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  echo "  $type: $count"
done
