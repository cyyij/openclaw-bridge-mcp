#!/bin/bash
# OpenClaw Bridge — Inbox hook for Claude Code
# Checks for incoming messages from OpenClaw agents and displays them
# in the active Claude Code session.
#
# Setup: Add to Claude Code hooks config (~/.claude/hooks.json):
#
#   {
#     "hooks": {
#       "UserPromptSubmit": [{
#         "type": "command",
#         "command": "/path/to/openclaw-bridge-mcp/hooks/check-inbox.sh"
#       }]
#     }
#   }
#
# Environment variables:
#   OPENCLAW_BRIDGE_DIR  Base directory for bridge files (default: ~/.openclaw/bridge)

BRIDGE_DIR="${OPENCLAW_BRIDGE_DIR:-$HOME/.openclaw/bridge}"
INBOX="$BRIDGE_DIR/claude-inbox.jsonl"

if [ -s "$INBOX" ]; then
  echo "--- Messages from OpenClaw agent ---"
  cat "$INBOX"
  echo "--- End of messages ---"
  > "$INBOX"
fi
