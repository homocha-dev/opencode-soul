#!/bin/bash
set -e

# opencode-soul setup script
# Installs opencode + the soul plugin on a fresh machine

SOUL_REPO="https://github.com/homocha-dev/opencode-soul.git"
SOUL_DIR="$HOME/.opencode-soul"
CONFIG_DIR="$HOME/.config/opencode"

echo "=== opencode-soul setup ==="
echo ""

# 1. Check for bun
if ! command -v bun &> /dev/null; then
  echo "installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
echo "bun: $(bun --version)"

# 2. Install opencode
if ! command -v opencode &> /dev/null; then
  echo "installing opencode..."
  bun install -g opencode@latest
fi
echo "opencode: $(opencode --version 2>/dev/null || echo 'installed')"

# 3. Clone opencode-soul
if [ -d "$SOUL_DIR" ]; then
  echo "updating opencode-soul..."
  cd "$SOUL_DIR" && git pull
else
  echo "cloning opencode-soul..."
  git clone "$SOUL_REPO" "$SOUL_DIR"
fi

# 4. Install soul plugin dependencies
echo "installing plugin dependencies..."
cd "$SOUL_DIR" && bun install

# 5. Create opencode config
mkdir -p "$CONFIG_DIR"
CONFIG_FILE="$CONFIG_DIR/../../opencode.json"

# Find the project root (where user will run opencode from)
# Default to home directory
PROJECT_ROOT="${1:-$HOME}"
CONFIG_FILE="$PROJECT_ROOT/opencode.json"

if [ -f "$CONFIG_FILE" ]; then
  echo "opencode.json already exists at $CONFIG_FILE"
  echo "add this to your plugin array if not already there:"
  echo "  \"file://$SOUL_DIR\""
else
  cat > "$CONFIG_FILE" << CONF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["file://$SOUL_DIR"],
  "permission": {
    "edit": "allow",
    "bash": "allow",
    "webfetch": "allow",
    "websearch": "allow",
    "external_directory": "allow",
    "read": "allow"
  }
}
CONF
  echo "created $CONFIG_FILE"
fi

# 6. Create default soul.md if it doesn't exist
SOUL_MD="$CONFIG_DIR/soul/soul.md"
if [ ! -f "$SOUL_MD" ]; then
  mkdir -p "$CONFIG_DIR/soul/memory/fact"
  mkdir -p "$CONFIG_DIR/soul/memory/pattern"
  mkdir -p "$CONFIG_DIR/soul/memory/preference"
  mkdir -p "$CONFIG_DIR/soul/memory/context"
  cat > "$SOUL_MD" << 'SOUL'
# Soul

I am an AI assistant running through OpenCode.

## Personality
- Direct and helpful
- Casual tone
- Keep responses concise

## About My Human
- (edit this section with your preferences)

## Things I've Learned
- (the agent will add memories here over time)
SOUL
  echo "created default soul.md at $SOUL_MD"
  echo "edit it to give your agent a personality!"
fi

echo ""
echo "=== setup complete ==="
echo ""
echo "to start: cd to your project directory and run 'opencode'"
echo "to customize: edit $SOUL_MD"
echo ""
