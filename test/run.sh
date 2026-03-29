#!/bin/bash
# Test harness for opencode-soul plugin
set -e

OPENCODE_SRC="/Users/mocha/.openclaw/workspace/opencode/packages/opencode"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="/tmp/opencode-soul-test"

# setup if test dir missing
if [ ! -d "$TEST_DIR/.git" ]; then
  echo "=== Setting up test workspace ==="
  rm -rf "$TEST_DIR"
  mkdir -p "$TEST_DIR/.opencode/plugins"
  mkdir -p "$TEST_DIR/souls" "$TEST_DIR/memory" "$TEST_DIR/encounters"
  cd "$TEST_DIR"
  git init -q
  git config user.email "test@test.com"
  git config user.name "test"
  echo "test" > README.md
  git add . && git commit -q -m "init"

  # soul
  cat > "$TEST_DIR/souls/test.md" << 'SOULEOF'
# Soul

I am Echo, a test agent.

## Personality
- Direct, concise, no filler.
- I always introduce myself as Echo.

## Values
- Accuracy matters.

## About My Human
- They are testing the soul plugin system.

## Things I've Learned
- (nothing yet)
SOULEOF

  # opencode config
  cat > "$TEST_DIR/opencode.json" << 'CFGEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["/tmp/opencode-soul-test/souls/test.md"]
}
CFGEOF

  # dep for embeddings
  cat > "$TEST_DIR/.opencode/package.json" << 'DEPEOF'
{
  "dependencies": {
    "@huggingface/transformers": "^3.4.1"
  }
}
DEPEOF

  # seed memories
  bash "$PLUGIN_DIR/test/seed-memories.sh"
  echo ""
fi

# always copy latest plugin
cp "$PLUGIN_DIR/test/soul-test-plugin.ts" "$TEST_DIR/.opencode/plugins/soul.ts"

PROMPT="${1:-Who are you? What do you know about me?}"

echo "=== opencode-soul test ==="
echo "Prompt: $PROMPT"
echo ""

cd "$TEST_DIR"
bun run --conditions=browser "$OPENCODE_SRC/src/index.ts" -- run \
  --format json \
  "$PROMPT" \
  2>&1 | while IFS= read -r line; do
    type=$(echo "$line" | jq -r '.type // empty' 2>/dev/null)
    case "$type" in
      text)
        text=$(echo "$line" | jq -r '.part.text // empty' 2>/dev/null)
        [ -n "$text" ] && echo "[TEXT] $text"
        ;;
      tool_use)
        t=$(echo "$line" | jq -r '.part.tool // empty' 2>/dev/null)
        state=$(echo "$line" | jq -r '.part.state.status // empty' 2>/dev/null)
        echo "[TOOL: $t] $state"
        if [ "$state" = "error" ]; then
          echo "  ERROR: $(echo "$line" | jq -r '.part.state.error // empty' 2>/dev/null)"
        fi
        if [ "$state" = "completed" ]; then
          echo "  $(echo "$line" | jq -r '.part.state.output // empty' 2>/dev/null | head -5)"
        fi
        ;;
      step_finish)
        cost=$(echo "$line" | jq -r '.part.cost // empty' 2>/dev/null)
        echo "[STEP] cost=\$$cost"
        echo ""
        ;;
    esac
  done

echo "=== Soul file ==="
cat "$TEST_DIR/souls/test.md"
echo ""
echo "=== Memories ==="
find "$TEST_DIR/memory" -name "*.md" | wc -l | tr -d ' '
echo " memory files"
