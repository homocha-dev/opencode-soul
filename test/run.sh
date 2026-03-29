#!/bin/bash
# Test harness for opencode-soul plugin
set -e

OPENCODE_SRC="/Users/mocha/.openclaw/workspace/opencode/packages/opencode"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_DIR="/tmp/opencode-soul-test"

echo "=== opencode-soul test harness ==="
echo "Plugin: $PLUGIN_DIR"
echo "Test dir: $TEST_DIR"
echo ""

# clean slate
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR/.opencode/plugins"
mkdir -p "$TEST_DIR/souls"
mkdir -p "$TEST_DIR/memory"
mkdir -p "$TEST_DIR/encounters"

# init a git repo (opencode requires it)
cd "$TEST_DIR"
git init -q
git config user.email "test@test.com"
git config user.name "test"
echo "test" > README.md
git add . && git commit -q -m "init"

# copy plugin file
cp "$PLUGIN_DIR/test/soul-test-plugin.ts" "$TEST_DIR/.opencode/plugins/soul.ts"

# create test soul
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

# create opencode config
cat > "$TEST_DIR/opencode.json" << 'CFGEOF'
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["/tmp/opencode-soul-test/souls/test.md"]
}
CFGEOF

PROMPT="${1:-Who are you? What is your name? Use the soul_edit tool to add something to your Things Ive Learned section.}"

echo "Prompt: $PROMPT"
echo ""
echo "--- Running ---"

cd "$OPENCODE_SRC"
bun run --conditions=browser ./src/index.ts -- run \
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
        echo "[TOOL: $t] status=$state"
        if [ "$state" = "error" ]; then
          echo "$line" | jq -r '.part.state.error // empty' 2>/dev/null
        fi
        if [ "$state" = "completed" ]; then
          echo "$line" | jq -r '.part.state.output // empty' 2>/dev/null | head -3
        fi
        ;;
      step_finish)
        reason=$(echo "$line" | jq -r '.part.reason // empty' 2>/dev/null)
        cost=$(echo "$line" | jq -r '.part.cost // empty' 2>/dev/null)
        echo "[STEP DONE] reason=$reason cost=\$$cost"
        echo ""
        ;;
    esac
  done

echo ""
echo "=== Results ==="
echo ""
echo "Soul file after:"
cat "$TEST_DIR/souls/test.md"
echo ""
echo "Memories:"
find "$TEST_DIR/memory" -name "*.md" -exec echo "---" \; -exec cat {} \; 2>/dev/null || echo "(none)"
