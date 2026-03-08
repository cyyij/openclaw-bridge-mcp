#!/usr/bin/env node
// OpenClaw Bridge MCP Server v1.0
// 統一入口：同機 OpenClaw 通訊 + 跨機器 HTTP 訊息傳遞
//
// 永遠可用的 tools:
//   send_to_openclaw, send_to_agent — 呼叫本機 OpenClaw agent
//
// 有設定 cross-machine 時額外啟用:
//   send_message, read_inbox, health_check — 跨機器 HTTP 通訊
//   + 內建 HTTP server 接收遠端訊息

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "child_process";
import httpModule from "http";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
// 共用工具
// ============================================================

function genMsgId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(2).toString("hex");
  return `msg-${ts}-${rand}`;
}

// ============================================================
// Part 1: Claude Code → OpenClaw（同機）
// ============================================================

const GATEWAY_PORT = parseInt(process.env.OPENCLAW_GATEWAY_PORT || "18789", 10);
const BRIDGE_DIR = process.env.OPENCLAW_BRIDGE_DIR ||
  path.join(os.homedir(), ".openclaw", "bridge");
const LOG_DIR = path.join(BRIDGE_DIR, "logs");

function writeLog(entry) {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(LOG_DIR, `${today}.jsonl`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(logPath, JSON.stringify(entry) + "\n");
}

function pingGateway() {
  return new Promise((resolve) => {
    const req = httpModule.get(
      `http://127.0.0.1:${GATEWAY_PORT}/`,
      { timeout: 3000 },
      (res) => { res.resume(); resolve(true); }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function extractJson(stdout) {
  const clean = stdout.replace(/\u001b\[[0-9;]*m/g, "");
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No valid JSON found in output: ${clean}`);
  }
  return JSON.parse(clean.substring(start, end + 1));
}

async function sendToAgent(agentId, message, opts = {}) {
  const msgId = genMsgId();
  const convId = opts.conversation_id || null;
  const replyTo = opts.reply_to || null;

  const alive = await pingGateway();
  if (!alive) {
    const envelope = {
      id: genMsgId(), conversation_id: convId, reply_to: msgId, ok: false,
      error: `GATEWAY_UNAVAILABLE: Gateway (port ${GATEWAY_PORT}) not responding. Check: openclaw daemon status`,
      retryable: true,
    };
    writeLog({
      timestamp: new Date().toISOString(), direction: "claude-to-openclaw",
      request: { id: msgId, conversation_id: convId, reply_to: replyTo, text: message },
      response: envelope, durationMs: 0,
    });
    throw new Error(envelope.error);
  }

  const start = Date.now();
  try {
    const { stdout } = await execFileAsync(
      "openclaw",
      ["agent", "--agent", agentId, "--message", message, "--json"],
      { timeout: 600000, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } }
    );

    const durationMs = Date.now() - start;
    const result = extractJson(stdout);
    const inner = result?.result || result;
    const reply = inner?.payloads?.[0]?.text || "(no response)";
    const model = inner?.meta?.agentMeta?.model || "unknown";
    const replyId = genMsgId();

    const envelope = {
      id: replyId, conversation_id: convId, reply_to: msgId, ok: true,
      text: reply, meta: { agent: agentId, model, durationMs },
    };
    writeLog({
      timestamp: new Date().toISOString(), direction: "claude-to-openclaw",
      request: { id: msgId, conversation_id: convId, reply_to: replyTo, text: message },
      response: envelope, durationMs,
    });
    return envelope;
  } catch (err) {
    const durationMs = Date.now() - start;
    const isTimeout = err.killed || err.code === "ETIMEDOUT" || durationMs >= 590000;
    const errorMsg = isTimeout
      ? `TIMEOUT: agent ${agentId} did not respond within 10 minutes (${durationMs}ms)`
      : err.message;
    const envelope = {
      id: genMsgId(), conversation_id: convId, reply_to: msgId, ok: false,
      error: errorMsg, retryable: isTimeout,
    };
    writeLog({
      timestamp: new Date().toISOString(), direction: "claude-to-openclaw",
      request: { id: msgId, conversation_id: convId, reply_to: replyTo, text: message },
      response: envelope, durationMs,
    });
    throw err;
  }
}

// ============================================================
// Part 2: Cross-Machine（跨機器，選用）
// ============================================================

// 偵測 cross-machine 設定是否存在
const CROSS_CONFIG_PATH = process.env.CROSS_MACHINE_CONFIG ||
  path.join(__dirname, "config.json");
const CROSS_SECRET_PATH = process.env.CROSS_MACHINE_SECRET_PATH ||
  path.join(os.homedir(), ".openclaw", "bridge", "secret");

const crossMachineEnabled = fs.existsSync(CROSS_CONFIG_PATH);

let CROSS_SECRET, CROSS_PORT, CROSS_PEERS, CROSS_LOCAL_NAME;
let CROSS_INBOX_DIR, CROSS_INBOX_PATH, CROSS_OUTBOX_PATH;

if (crossMachineEnabled) {
  const crossConfig = JSON.parse(fs.readFileSync(CROSS_CONFIG_PATH, "utf-8"));
  CROSS_SECRET = fs.existsSync(CROSS_SECRET_PATH)
    ? fs.readFileSync(CROSS_SECRET_PATH, "utf-8").trim()
    : null;
  CROSS_PORT = crossConfig.port || 49168;
  CROSS_PEERS = crossConfig.peers || {};
  CROSS_LOCAL_NAME = crossConfig.localName || os.hostname();
  CROSS_INBOX_DIR = process.env.CROSS_MACHINE_INBOX_DIR ||
    path.join(os.homedir(), ".openclaw", "bridge");
  CROSS_INBOX_PATH = path.join(CROSS_INBOX_DIR, "inbox.jsonl");
  CROSS_OUTBOX_PATH = path.join(CROSS_INBOX_DIR, "outbox.jsonl");

  if (!fs.existsSync(CROSS_INBOX_DIR)) {
    fs.mkdirSync(CROSS_INBOX_DIR, { recursive: true });
  }
}

// --- Cross-machine 工具函式 ---

function resolveTarget(target) {
  if (CROSS_PEERS[target]) return CROSS_PEERS[target];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(target)) return target;
  throw new Error(
    `Unknown target: ${target}. Known peers: ${Object.keys(CROSS_PEERS).join(", ")}`
  );
}

async function crossHttpRequest(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const text = await resp.text();
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${text}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function appendJsonl(filePath, obj) {
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n", "utf-8");
}

function loadJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

function saveJsonl(filePath, items) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp,
    items.map((it) => JSON.stringify(it)).join("\n") + (items.length ? "\n" : ""),
    "utf-8"
  );
  fs.renameSync(tmp, filePath);
}

// --- HTTP Server ---

function startHttpServer() {
  const httpServer = httpModule.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    if (req.method === "POST" && req.url === "/msg") {
      // secret 驗證：有設定 secret 才檢查，沒設定就放行（適用 Tailscale 等私有網路）
      if (CROSS_SECRET && req.headers["x-secret"] !== CROSS_SECRET) {
        res.writeHead(401, { "Content-Type": "text/plain" });
        res.end("unauthorized");
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) {
          res.writeHead(413, { "Content-Type": "text/plain" });
          res.end("payload too large");
          req.destroy();
        }
      });
      req.on("end", () => {
        try {
          const msg = JSON.parse(body);
          const receivedAt = new Date().toISOString();
          appendJsonl(CROSS_INBOX_PATH, {
            id: msg.id || crypto.randomUUID(),
            from: msg.from || "unknown",
            text: msg.text || "",
            sentAt: msg.sentAt || receivedAt,
            receivedAt,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, id: msg.id, receivedAt }));
        } catch {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("bad json");
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  httpServer.listen(CROSS_PORT, () => {
    console.error(`[cross-machine] HTTP server listening on port ${CROSS_PORT}`);
  });
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[cross-machine] Port ${CROSS_PORT} already in use — HTTP server disabled. Send-only mode.`);
    } else {
      console.error(`[cross-machine] HTTP server error: ${err.message}`);
    }
  });
}

// --- Outbox 重試 ---

async function retryOutbox() {
  const items = loadJsonl(CROSS_OUTBOX_PATH);
  if (items.length === 0) return;

  const now = Date.now();
  const remaining = [];

  for (const item of items) {
    if (item.nextAttempt && item.nextAttempt > now) {
      remaining.push(item);
      continue;
    }
    if (item.attempts >= 20) {
      console.error(`[cross-machine] Outbox drop id=${item.message?.id} after ${item.attempts} attempts`);
      continue;
    }
    try {
      const ip = resolveTarget(item.target);
      await crossHttpRequest(`http://${ip}:${CROSS_PORT}/msg`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(CROSS_SECRET ? { "X-Secret": CROSS_SECRET } : {}),
        },
        body: JSON.stringify(item.message),
      });
      console.error(`[cross-machine] Retry delivered id=${item.message?.id} to ${item.target}`);
    } catch (err) {
      item.attempts = (item.attempts || 0) + 1;
      const backoff = Math.min(300, Math.pow(2, Math.min(8, item.attempts)));
      item.nextAttempt = Date.now() + backoff * 1000;
      item.lastError = err.message;
      remaining.push(item);
    }
  }
  saveJsonl(CROSS_OUTBOX_PATH, remaining);
}

function startRetryLoop() {
  setInterval(() => {
    retryOutbox().catch((err) => {
      console.error(`[cross-machine] Retry loop error: ${err.message}`);
    });
  }, 5000);
}

// --- Cross-machine tool 實作 ---

async function crossSendMessage(target, text, from) {
  const ip = resolveTarget(target);
  const targetUrl = `http://${ip}:${CROSS_PORT}/msg`;
  const message = {
    id: crypto.randomUUID(),
    from: from || CROSS_LOCAL_NAME,
    text,
    sentAt: new Date().toISOString(),
  };

  try {
    const result = await crossHttpRequest(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CROSS_SECRET ? { "X-Secret": CROSS_SECRET } : {}),
      },
      body: JSON.stringify(message),
    });
    return { success: true, messageId: message.id, response: JSON.parse(result) };
  } catch (err) {
    appendJsonl(CROSS_OUTBOX_PATH, {
      target, message, attempts: 1,
      nextAttempt: Date.now() + 3000, lastError: err.message,
    });
    return {
      success: false, queued: true, messageId: message.id,
      error: `Send failed, queued for retry: ${err.message}`,
    };
  }
}

function crossReadInbox(clear) {
  const messages = loadJsonl(CROSS_INBOX_PATH);
  const result = { messages, count: messages.length };
  if (clear && messages.length > 0) saveJsonl(CROSS_INBOX_PATH, []);
  return result;
}

async function crossHealthCheck(target) {
  const targets = target
    ? { [target]: resolveTarget(target) }
    : CROSS_PEERS;
  const results = {};
  for (const [name, ip] of Object.entries(targets)) {
    try {
      const resp = await crossHttpRequest(`http://${ip}:${CROSS_PORT}/healthz`);
      results[name] = { status: "ok", ip, response: resp };
    } catch (err) {
      results[name] = { status: "error", ip, error: err.message };
    }
  }
  return results;
}

// ============================================================
// MCP Server
// ============================================================

const server = new Server(
  { name: "openclaw-bridge-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const envelopeProps = {
  conversation_id: {
    type: "string",
    description: "Conversation ID for tracking multi-turn dialogues (optional)",
  },
  reply_to: {
    type: "string",
    description: "Message ID this is replying to (optional)",
  },
};

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    {
      name: "send_to_openclaw",
      description:
        "Send a message to the OpenClaw main agent. The agent will process and reply. Used for cross-AI communication.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Message content to send" },
          ...envelopeProps,
        },
        required: ["message"],
      },
    },
    {
      name: "send_to_agent",
      description: "Send a message to a specific OpenClaw agent by ID.",
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", description: "Target agent ID" },
          message: { type: "string", description: "Message content to send" },
          ...envelopeProps,
        },
        required: ["agent", "message"],
      },
    },
  ];

  // 跨機器 tools 只在有設定時才顯示
  if (crossMachineEnabled) {
    tools.push(
      {
        name: "send_message",
        description:
          `Send a message to a remote machine. ` +
          `Known peers: ${Object.keys(CROSS_PEERS).join(", ")}. Local: ${CROSS_LOCAL_NAME}.`,
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "string",
              description: `Target peer name or IP. Known: ${Object.entries(CROSS_PEERS).map(([k, v]) => `${k}(${v})`).join(", ")}`,
            },
            text: { type: "string", description: "Message content" },
            from: { type: "string", description: `Sender name (default: ${CROSS_LOCAL_NAME})` },
          },
          required: ["target", "text"],
        },
      },
      {
        name: "read_inbox",
        description: "Read pending messages from the local inbox",
        inputSchema: {
          type: "object",
          properties: {
            clear: { type: "boolean", description: "Clear inbox after reading (default: false)" },
          },
        },
      },
      {
        name: "health_check",
        description: "Check health of remote peers. Omit target to check all known peers.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", description: "Peer name or IP to check (optional, defaults to all)" },
          },
        },
      }
    );
  }

  return { tools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const opts = { conversation_id: args?.conversation_id, reply_to: args?.reply_to };

  try {
    switch (name) {
      // --- 同機 OpenClaw ---
      case "send_to_openclaw": {
        if (!args.message) throw new Error("message is required");
        const envelope = await sendToAgent("main", args.message, opts);
        return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
      }
      case "send_to_agent": {
        if (!args.agent || !args.message) throw new Error("agent and message are required");
        const envelope = await sendToAgent(args.agent, args.message, opts);
        return { content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }] };
      }

      // --- 跨機器 ---
      case "send_message": {
        if (!crossMachineEnabled) throw new Error("Cross-machine not configured. See README for setup.");
        if (!args.target || !args.text) throw new Error("target and text are required");
        const result = await crossSendMessage(args.target, args.text, args.from);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "read_inbox": {
        if (!crossMachineEnabled) throw new Error("Cross-machine not configured. See README for setup.");
        const result = crossReadInbox(args.clear);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      case "health_check": {
        if (!crossMachineEnabled) throw new Error("Cross-machine not configured. See README for setup.");
        const result = await crossHealthCheck(args.target);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify({ id: genMsgId(), ok: false, error: err.message }, null, 2) }],
      isError: true,
    };
  }
});

// ============================================================
// 啟動
// ============================================================

async function main() {
  if (crossMachineEnabled) {
    startHttpServer();
    startRetryLoop();
    console.error(`[openclaw-bridge] Cross-machine enabled. Peers: ${Object.keys(CROSS_PEERS).join(", ")}`);
  } else {
    console.error("[openclaw-bridge] Cross-machine disabled (no config.json or secret). Local-only mode.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("openclaw-bridge-mcp failed to start:", err);
  process.exit(1);
});
