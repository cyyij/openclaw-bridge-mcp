# bridge-v1 Protocol Specification

## Overview

bridge-v1 is a lightweight JSON envelope protocol for bidirectional communication between AI CLI tools (such as Claude Code and OpenClaw) via MCP servers. It is stateless by design — callers carry their own context, and each envelope is self-contained.

## Envelope Format

### Success Envelope

```json
{
  "id": "msg-m5abc12-3f4a",
  "conversation_id": "conv-123",
  "reply_to": "msg-m5abc10-1b2c",
  "ok": true,
  "text": "Response content",
  "meta": {
    "agent": "main",
    "model": "gpt-5.4",
    "durationMs": 1234
  }
}
```

| Field             | Type    | Required | Description                                      |
|-------------------|---------|----------|--------------------------------------------------|
| `id`              | string  | yes      | Unique message ID (see Message ID Format below)  |
| `conversation_id` | string  | no       | Groups related messages in a conversation         |
| `reply_to`        | string  | no       | ID of the message being replied to                |
| `ok`              | boolean | yes      | `true` for success                                |
| `text`            | string  | yes      | Response content                                  |
| `meta`            | object  | no       | Metadata (agent ID, model, duration, etc.)        |

### Error Envelope

```json
{
  "id": "msg-m5abc13-7e8f",
  "conversation_id": "conv-123",
  "reply_to": "msg-m5abc12-3f4a",
  "ok": false,
  "error": "GATEWAY_UNAVAILABLE",
  "retryable": true
}
```

| Field       | Type    | Required | Description                          |
|-------------|---------|----------|--------------------------------------|
| `id`        | string  | yes      | Unique message ID                    |
| `ok`        | boolean | yes      | `false` for errors                   |
| `error`     | string  | yes      | Error description                    |
| `retryable` | boolean | yes      | Whether the caller should retry      |

`conversation_id` and `reply_to` follow the same rules as the success envelope.

## Message ID Format

Format: `msg-{base36_timestamp}-{4_hex_random}`

- `base36_timestamp` — `Date.now().toString(36)`
- `4_hex_random` — `crypto.randomBytes(2).toString("hex")`

Example: `msg-m5abc12-3f4a`

## Directions

| Direction            | Description                               |
|----------------------|-------------------------------------------|
| `claude-to-openclaw` | Claude Code sends a message to an OpenClaw agent |
| `openclaw-to-claude` | OpenClaw agent sends a message to Claude Code    |

Each direction is implemented as a separate MCP server.

## Log Format

Location: `$BRIDGE_DIR/logs/YYYY-MM-DD.jsonl`

Each line is a JSON object containing:

```json
{
  "timestamp": "2026-03-08T12:34:56.789Z",
  "direction": "claude-to-openclaw",
  "request": { "...envelope..." },
  "response": { "...envelope..." },
  "durationMs": 1234
}
```

| Field       | Type   | Description                                |
|-------------|--------|--------------------------------------------|
| `timestamp` | string | ISO 8601 timestamp                         |
| `direction` | string | `claude-to-openclaw` or `openclaw-to-claude` |
| `request`   | object | The request envelope                       |
| `response`  | object | The response envelope                      |
| `durationMs`| number | Round-trip duration in milliseconds         |

## Health Check

The `claude-to-openclaw` server performs a health check before sending any message:

1. Sends an HTTP GET to `http://127.0.0.1:$OPENCLAW_GATEWAY_PORT/` with a **3-second timeout**.
2. If the gateway responds, the message is forwarded to the agent.
3. If the gateway is unreachable, returns a `GATEWAY_UNAVAILABLE` error immediately (fail fast).

## Timeouts

| Direction            | Timeout    | Rationale                                        |
|----------------------|------------|--------------------------------------------------|
| `claude-to-openclaw` | 600s (10m) | OpenClaw agents may run complex, long-running tasks |
| `openclaw-to-claude` | 120s (2m)  | Claude responds quickly in readonly mode          |

## Inbox Mechanism

The `openclaw-to-claude` server uses a file-based inbox to inject messages into active Claude Code sessions:

1. Incoming messages are appended to `$BRIDGE_DIR/claude-inbox.jsonl`.
2. A hook script (`hooks/check-inbox.sh`) periodically checks for new messages and displays them in the active Claude Code session.
3. After messages are displayed, the inbox file is cleared.
