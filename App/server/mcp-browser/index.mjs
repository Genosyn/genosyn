#!/usr/bin/env node
// @ts-check
/*
 * Built-in Genosyn browser MCP server — thin RPC translator.
 *
 * Spawned by the provider CLI (claude / codex / opencode / goose / openclaw)
 * as a stdio MCP server when the AI employee has `browserEnabled = true`.
 * Each tool the model calls (`browser_open`, `browser_click`, …) round-trips
 * over HTTP to the App, which owns the headless Chromium. Chromium therefore
 * persists across MCP child spawns and chat turns — the agent's "I'll wait
 * while you drop your credentials in" actually works because the same
 * browser session is still up when the next turn fires.
 *
 * State on this side is tiny: just the in-memory map of approval IDs the
 * model is waiting on (`browser_submit` + `browser_resume`).
 *
 * Env vars (set by `services/mcp.ts` at materialize time):
 *
 *   GENOSYN_MCP_API
 *   GENOSYN_MCP_TOKEN
 *     Loopback URL + bearer for the internal MCP API. Used by
 *     `browser_submit` to queue an Approval and by `browser_resume` to
 *     poll its status.
 *
 *   GENOSYN_BROWSER_API
 *     Loopback URL for the App-side browser tool RPC. Default
 *     `http://127.0.0.1:<port>/api/internal/browser/sessions/<sessionId>`.
 *
 *   GENOSYN_BROWSER_SESSION_TOKEN
 *     Bearer for the browser RPC. Resolves to the session id on the App.
 *
 *   GENOSYN_BROWSER_APPROVAL_REQUIRED  ("1" / unset)
 *     When set, `browser_submit` queues an Approval row and returns
 *     `pending_approval` to the model.
 *
 * Protocol surface implemented:
 *   - initialize
 *   - notifications/initialized  (ignored)
 *   - tools/list
 *   - tools/call
 */

import readline from "node:readline";
import crypto from "node:crypto";

const MCP_API_BASE = process.env.GENOSYN_MCP_API ?? "";
const MCP_TOKEN = process.env.GENOSYN_MCP_TOKEN ?? "";
const BROWSER_API_BASE = process.env.GENOSYN_BROWSER_API ?? "";
const BROWSER_TOKEN = process.env.GENOSYN_BROWSER_SESSION_TOKEN ?? "";
const APPROVAL_REQUIRED = process.env.GENOSYN_BROWSER_APPROVAL_REQUIRED === "1";

/** @type {Map<string, { tool: "submit"; selector: string; key?: string }>} */
const pendingActions = new Map();

// ---------- HTTP helpers ----------

async function callBrowser(endpoint, body) {
  if (!BROWSER_API_BASE || !BROWSER_TOKEN) {
    throw new Error(
      "GENOSYN_BROWSER_API / GENOSYN_BROWSER_SESSION_TOKEN not set — the browser tool surface is disabled.",
    );
  }
  const url = BROWSER_API_BASE.replace(/\/+$/, "") + endpoint;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BROWSER_TOKEN}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  if (!r.ok) {
    let msg = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error) msg = parsed.error;
    } catch {
      // text wasn't JSON — fall through
    }
    throw new Error(`Browser RPC ${r.status}: ${msg}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON reply (${r.status}): ${text.slice(0, 300)}`);
  }
}

async function callGenosyn(endpoint, body) {
  if (!MCP_API_BASE || !MCP_TOKEN) {
    throw new Error(
      "GENOSYN_MCP_API / GENOSYN_MCP_TOKEN not set — cannot reach the Genosyn server. Approval flows are disabled.",
    );
  }
  const url = MCP_API_BASE.replace(/\/+$/, "") + endpoint;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MCP_TOKEN}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON reply (${r.status}): ${text.slice(0, 300)}`);
  }
}

async function getGenosyn(endpoint) {
  if (!MCP_API_BASE || !MCP_TOKEN) {
    throw new Error("GENOSYN_MCP_API / GENOSYN_MCP_TOKEN not set");
  }
  const url = MCP_API_BASE.replace(/\/+$/, "") + endpoint;
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${MCP_TOKEN}` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON reply (${r.status}): ${text.slice(0, 300)}`);
  }
}

// ---------- tool implementations ----------

async function browserOpen(args) {
  const url = String(args?.url ?? "").trim();
  if (!url) throw new Error("`url` is required");
  const reply = await callBrowser("/open", { url });
  return textResult(reply.snapshot ?? "");
}

async function browserSnapshot() {
  const reply = await callBrowser("/snapshot", {});
  return textResult(reply.snapshot ?? "");
}

async function browserClick(args) {
  const selector = String(args?.selector ?? "").trim();
  if (!selector) throw new Error("`selector` is required");
  const reply = await callBrowser("/click", { selector });
  return textResult(reply.snapshot ?? "");
}

async function browserFill(args) {
  const selector = String(args?.selector ?? "").trim();
  if (!selector) throw new Error("`selector` is required");
  const value = typeof args?.value === "string" ? args.value : "";
  const reply = await callBrowser("/fill", { selector, value });
  return textResult(reply.snapshot ?? "");
}

async function browserPress(args) {
  const key = String(args?.key ?? "").trim();
  if (!key) throw new Error("`key` is required (e.g. 'Enter', 'Tab', 'ArrowDown')");
  const body = { key };
  if (typeof args?.selector === "string" && args.selector.length > 0) {
    body.selector = args.selector;
  }
  const reply = await callBrowser("/press", body);
  return textResult(reply.snapshot ?? "");
}

async function browserScreenshot() {
  const reply = await callBrowser("/screenshot", {});
  return {
    content: [
      {
        type: "image",
        data: reply.data ?? "",
        mimeType: reply.mimeType ?? "image/png",
      },
    ],
  };
}

async function browserClose() {
  await callBrowser("/close", {});
  return textResult("Browser closed.");
}

async function browserSubmit(args) {
  const selector = String(args?.selector ?? "").trim();
  if (!selector) throw new Error("`selector` is required");
  const key = typeof args?.key === "string" ? args.key : undefined;
  const summary =
    typeof args?.summary === "string" ? args.summary.trim() : "Submit a form via the browser MCP";

  if (!APPROVAL_REQUIRED) {
    return executeSubmit(selector, key);
  }

  // Get the current URL so the approver has context. Cheap snapshot call.
  let pageUrl = "";
  try {
    const snap = await callBrowser("/snapshot", {});
    const m = /^URL:\s*(.+)$/m.exec(snap.snapshot ?? "");
    if (m) pageUrl = m[1].trim();
  } catch {
    // best-effort
  }

  const id = crypto.randomUUID();
  pendingActions.set(id, { tool: "submit", selector, key });
  try {
    const reply = await callGenosyn("/tools/queue_browser_approval", {
      clientApprovalId: id,
      summary,
      pageUrl,
      selector,
      key: key ?? null,
    });
    const approvalId = reply?.approvalId ?? id;
    if (approvalId !== id) {
      pendingActions.set(approvalId, pendingActions.get(id));
      pendingActions.delete(id);
    }
    return textResult(
      `Approval queued. status: pending_approval. approvalId: ${approvalId}. Call browser_resume("${approvalId}") to retry once a human approves it from the Approvals inbox.`,
    );
  } catch (err) {
    pendingActions.delete(id);
    throw new Error(`Could not queue approval: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function executeSubmit(selector, key) {
  if (key) {
    const reply = await callBrowser("/press", { selector, key });
    return textResult(reply.snapshot ?? "");
  }
  const reply = await callBrowser("/click", { selector });
  return textResult(reply.snapshot ?? "");
}

async function browserResume(args) {
  const approvalId = String(args?.approvalId ?? "").trim();
  if (!approvalId) throw new Error("`approvalId` is required");
  const action = pendingActions.get(approvalId);
  if (!action) {
    throw new Error(
      `No pending action for approvalId ${approvalId} in this MCP session. The browser session may have restarted; call browser_submit again.`,
    );
  }
  let reply;
  try {
    reply = await getGenosyn(
      `/tools/check_browser_approval/${encodeURIComponent(approvalId)}`,
    );
  } catch (err) {
    throw new Error(
      `Could not check approval status: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const status = reply?.status;
  if (status === "approved") {
    pendingActions.delete(approvalId);
    return executeSubmit(action.selector, action.key);
  }
  if (status === "rejected") {
    pendingActions.delete(approvalId);
    throw new Error(`Approval ${approvalId} was rejected by the human reviewer.`);
  }
  if (status === "expired") {
    pendingActions.delete(approvalId);
    throw new Error(`Approval ${approvalId} expired before a human responded.`);
  }
  return textResult(
    `Approval ${approvalId} is still pending. Call browser_resume("${approvalId}") again later.`,
  );
}

// ---------- tool registry ----------

const TOOLS = [
  {
    name: "browser_open",
    description:
      "Navigate to an absolute http(s) URL in the headless browser and return a snapshot of the loaded page (URL, title, accessibility tree, visible text). Use this first to land on a page. The browser persists across chat turns — humans can watch it live in the chat panel and take over to type things in (e.g. solve a captcha or 2FA), and the page state survives until the conversation moves on.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute URL, e.g. https://example.com." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: browserOpen,
  },
  {
    name: "browser_snapshot",
    description:
      "Return a fresh snapshot of the current page (URL, title, accessibility tree, visible text). Use after a click/fill/press to see what changed, or to recover state at the start of a new turn — the browser persists, so the page the human was just looking at is still loaded.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: browserSnapshot,
  },
  {
    name: "browser_click",
    description:
      "Click an element. `selector` is any Playwright locator: a CSS selector ('button.primary', 'a[href*=login]'), a text= prefix ('text=Sign in'), or a role= prefix ('role=button[name=\"Save\"]'). The first matching visible element is clicked. For form submissions, prefer browser_submit so a human-in-the-loop approval can gate it.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Playwright locator (CSS / text= / role=)." },
      },
      required: ["selector"],
      additionalProperties: false,
    },
    handler: browserClick,
  },
  {
    name: "browser_fill",
    description:
      "Type a value into an input or textarea, replacing whatever was there. `selector` is the same form as browser_click.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Playwright locator (CSS / text= / role=)." },
        value: { type: "string", description: "The text to type. Empty string clears the field." },
      },
      required: ["selector", "value"],
      additionalProperties: false,
    },
    handler: browserFill,
  },
  {
    name: "browser_press",
    description:
      "Press a keyboard key. Common values: 'Enter' (submit a form), 'Tab', 'Escape', 'ArrowDown'. Pass `selector` to focus an element first; omit to send the key to whatever is currently focused. For form submissions, prefer browser_submit.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key name, e.g. 'Enter', 'Tab', 'ArrowDown'." },
        selector: { type: "string", description: "Optional element to focus first." },
      },
      required: ["key"],
      additionalProperties: false,
    },
    handler: browserPress,
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a PNG screenshot of the current viewport and return it as image content. Use sparingly — screenshots are heavy in the context window. Prefer browser_snapshot when you only need text. Humans can also watch the page live in the chat panel.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: browserScreenshot,
  },
  {
    name: "browser_close",
    description:
      "Shut down the browser and free its memory. Only does anything when no human is watching — viewers are protected so a model that idly closes the browser at the end of its turn doesn't yank the rug out from under a human mid-takeover.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: browserClose,
  },
  {
    name: "browser_submit",
    description:
      "Submit a form. Use this whenever your action sends data somewhere — clicking a 'Sign in' / 'Save' / 'Send' button, or pressing Enter inside a search/input. When the employee has approval-mode enabled, this queues an Approval row and returns `pending_approval` with an approvalId; call browser_resume(approvalId) once a human approves. When approval mode is off, browser_submit fires immediately like a click. `summary` is a short, human-readable description shown to the approver.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "The element to act on — usually a submit button. With `key`, this is the input that should receive the key press.",
        },
        key: {
          type: "string",
          description:
            "Optional. When set, the action is a key press on `selector` (e.g. 'Enter') instead of a click.",
        },
        summary: {
          type: "string",
          description: "Short description of what this submission does. Shown to the approver.",
        },
      },
      required: ["selector"],
      additionalProperties: false,
    },
    handler: browserSubmit,
  },
  {
    name: "browser_resume",
    description:
      "Re-fire a previously queued browser_submit once a human has approved it. Returns `pending_approval` if the approval is still open, fails with an error if rejected/expired or if this MCP session no longer remembers the action.",
    inputSchema: {
      type: "object",
      properties: {
        approvalId: {
          type: "string",
          description: "The id returned by the original browser_submit call.",
        },
      },
      required: ["approvalId"],
      additionalProperties: false,
    },
    handler: browserResume,
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

// ---------- protocol handler ----------

const SERVER_INFO = { name: "genosyn-browser", version: "0.4.0" };
const CAPABILITIES = { tools: {} };

async function handle(msg, send) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  if (method === undefined) return;

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
      });
      return;
    }
    if (method === "notifications/initialized" || method === "initialized") return;
    if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        },
      });
      return;
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (typeof name !== "string") {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: "Missing tool name" } });
        return;
      }
      const tool = TOOL_BY_NAME.get(name);
      if (!tool) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return;
      }
      try {
        const result = await tool.handler(args);
        send({ jsonrpc: "2.0", id, result });
      } catch (err) {
        send({
          jsonrpc: "2.0",
          id,
          result: toolError(err instanceof Error ? err.message : String(err)),
        });
      }
      return;
    }
    if (id !== undefined) {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (id !== undefined) {
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }
}

// ---------- stdio framing ----------

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    process.stderr.write(
      `[genosyn-browser-mcp] ignored non-JSON line: ${trimmed.slice(0, 200)}\n`,
    );
    return;
  }
  handle(msg, write).catch((err) => {
    process.stderr.write(
      `[genosyn-browser-mcp] dispatch failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  });
});

rl.on("close", () => {
  process.exit(0);
});

process.on("SIGTERM", () => {
  process.exit(0);
});

function write(obj) {
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch (err) {
    process.stderr.write(
      `[genosyn-browser-mcp] failed to write response: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}
