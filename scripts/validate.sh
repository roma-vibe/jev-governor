#!/bin/sh
# Validates the mod the way the engine loads it. A module the engine refuses
# does not load at all, in any session, so this runs before every commit.
set -e
cd "$(dirname "$0")/.."
CLAUDE=$(command -v claude 2>/dev/null || true)
if [ -z "$CLAUDE" ]; then
  CLAUDE=$(ls -d "$HOME/Library/Application Support/Claude/claude-code"/*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1)
fi
if [ -z "$CLAUDE" ]; then
  echo "validate: claude CLI not found" >&2
  exit 1
fi
"$CLAUDE" plugin validate . 2>&1 | tail -4
"$CLAUDE" plugin validate . >/dev/null 2>&1
