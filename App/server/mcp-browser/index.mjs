#!/usr/bin/env node
// @ts-check
/*
 * Built-in Genosyn browser MCP server — thin RPC translator.
 *
 * Spawned by the in-process agent (`services/agent/`) as a stdio MCP child that
 * the agent connects to as an MCP client, when the AI employee has
 * `browserEnabled = true`. Each tool the model calls (`browser_open`,
 * `browser_click`, …) round-trips over HTTP to the App, which owns the headless
 * Chromium. Chromium therefore persists across MCP child spawns and chat turns —
 * the agent's "I'll wait while you drop your credentials in" actually works
 * because the same browser session is still up when the next turn fires.
 *
 * State on this side is tiny: just the in-memory map of approval IDs the
 * model is waiting on (`browser_submit` + `browser_resume`).
 *
 * Env vars (set by `services/agent/tools/mcpSources.ts` when the child spawns):
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

async function browserSelect(args) {
  const selector = String(args?.selector ?? "").trim();
  if (!selector) throw new Error("`selector` is required");
  const value = String(args?.value ?? "").trim();
  if (!value) throw new Error("`value` is required");
  const reply = await callBrowser("/select", { selector, value });
  return textResult(reply.snapshot ?? "");
}

async function browserHover(args) {
  const selector = String(args?.selector ?? "").trim();
  if (!selector) throw new Error("`selector` is required");
  const reply = await callBrowser("/hover", { selector });
  return textResult(reply.snapshot ?? "");
}

async function browserScroll(args) {
  const body = {};
  if (typeof args?.selector === "string" && args.selector.length > 0) {
    body.selector = args.selector;
  } else {
    body.direction = args?.direction === "up" ? "up" : "down";
  }
  const reply = await callBrowser("/scroll", body);
  return textResult(reply.snapshot ?? "");
}

async function browserBack() {
  const reply = await callBrowser("/back", {});
  return textResult(reply.snapshot ?? "");
}

async function browserWait(args) {
  const body = {};
  if (typeof args?.selector === "string" && args.selector.length > 0) {
    body.selector = args.selector;
  }
  if (typeof args?.ms === "number" && Number.isFinite(args.ms)) {
    const ms = Math.round(Math.min(args.ms, 15_000));
    if (ms >= 1) body.ms = ms;
  }
  if (!body.selector && !body.ms) {
    throw new Error("Pass `selector` (wait until it is visible), `ms` (≥ 1), or both");
  }
  const reply = await callBrowser("/wait", body);
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
        mimeType: reply.mimeType ?? "image/jpeg",
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

  // Get the current URL so the approver has context. /url is a cheap
  // read of already-known state — it never launches Chromium or builds
  // a snapshot.
  let pageUrl = "";
  try {
    const reply = await callBrowser("/url", {});
    if (typeof reply?.url === "string") pageUrl = reply.url;
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

/** Same page the human approved? Compare origin + path, ignoring query/hash. */
function sameApprovedPage(approvedUrl, currentUrl) {
  if (!approvedUrl || !currentUrl) return false;
  try {
    const a = new URL(approvedUrl);
    const b = new URL(currentUrl);
    return a.origin === b.origin && a.pathname === b.pathname;
  } catch {
    return false;
  }
}

async function browserResume(args) {
  const approvalId = String(args?.approvalId ?? "").trim();
  if (!approvalId) throw new Error("`approvalId` is required");
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
    // One-shot: an approval fires exactly once. The server records the
    // execution, so a replay from any later turn is refused here.
    if (reply?.executed) {
      throw new Error(
        `Approval ${approvalId} was already submitted — an approval fires once. Start a new browser_submit if you need to act again.`,
      );
    }
    // Prefer the locally held action; fall back to the copy the server
    // stored on the Approval row. The fallback is what makes resume work
    // across chat turns — this MCP child is spawned per turn, and the
    // human usually approves after the turn that queued it has ended.
    const action = pendingActions.get(approvalId);
    const selector = action?.selector ?? (typeof reply?.selector === "string" ? reply.selector : "");
    const key = action?.key ?? (typeof reply?.key === "string" ? reply.key : undefined);
    if (!selector) {
      throw new Error(
        `Approval ${approvalId} is approved but its held action is missing. Call browser_submit again.`,
      );
    }
    // Bind to the page the human actually saw. If the browser has since
    // navigated (or was torn down and reopened on a blank page), the stored
    // selector could fire against a completely different page — refuse and
    // make the model re-submit from the current page.
    const approvedUrl = typeof reply?.pageUrl === "string" ? reply.pageUrl : "";
    let currentUrl = "";
    try {
      const u = await callBrowser("/url", {});
      if (typeof u?.url === "string") currentUrl = u.url;
    } catch {
      // fall through — treated as a mismatch below
    }
    if (!sameApprovedPage(approvedUrl, currentUrl)) {
      pendingActions.delete(approvalId);
      throw new Error(
        `The page changed since this action was approved (approved on ${approvedUrl || "an unknown page"}, now on ${currentUrl || "an unknown page"}). ` +
          `The approval is bound to the page you approved, so it will not fire here. Navigate back and call browser_submit again if you still want to submit.`,
      );
    }
    pendingActions.delete(approvalId);
    const result = await executeSubmit(selector, key);
    // Record the firing so it can't be replayed. Best-effort — the action
    // already happened; a failed mark just means a later replay is caught
    // by the page-binding check instead.
    try {
      await callGenosyn(`/tools/mark_browser_approval_executed/${encodeURIComponent(approvalId)}`, {});
    } catch {
      // best-effort
    }
    return result;
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
    `Approval ${approvalId} is still pending. Call browser_resume("${approvalId}") again once a human approves it — keep the browser on the same page so the approved action can fire.`,
  );
}

// ---------- tool registry ----------

// Every snapshot-returning tool shares the same selector contract, spelled
// out once here and referenced from each description. Renames ripple: these
// names also appear in App/client/pages/employeeTabs.tsx (settings card),
// App/client/pages/Approvals.tsx (browser_action rendering), and the docs
// at Home/client/docs/pages/Browser.tsx.
const SELECTOR_HINT =
  "`selector` should be an `aria-ref=eN` ref from the latest snapshot (each interactive element is marked [ref=eN] — refs resolve instantly and unambiguously, including inside iframes). CSS selectors ('button.primary'), text= ('text=Sign in'), and role= ('role=button[name=\"Save\"]') also work as fallbacks; the first visible match is used.";

const TOOLS = [
  {
    name: "browser_open",
    description:
      "Navigate to an absolute http(s) URL in the headless browser and return a snapshot of the loaded page: URL, title, and an outline of the page in which every interactive element carries a [ref=eN] marker you can act on via `aria-ref=eN` selectors. Use this first to land on a page. The browser persists across chat turns — humans can watch it live in the chat panel and take over to type things in (e.g. solve a captcha or 2FA), and the page state survives until the conversation moves on.",
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
      "Return a fresh snapshot of the current page (URL, title, ref-annotated page outline). Use to recover state at the start of a new turn — the browser persists, so the page the human was just looking at is still loaded. Actions already return a snapshot, so you rarely need this right after one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: browserSnapshot,
  },
  {
    name: "browser_click",
    description:
      `Click an element and return a fresh snapshot. ${SELECTOR_HINT} If the click opens a new tab, the browser follows it automatically. For form submissions, prefer browser_submit so a human-in-the-loop approval can gate it.`,
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "aria-ref=eN from the snapshot, or CSS / text= / role=." },
      },
      required: ["selector"],
      additionalProperties: false,
    },
    handler: browserClick,
  },
  {
    name: "browser_fill",
    description:
      `Type a value into an input or textarea, replacing whatever was there. ${SELECTOR_HINT} For native <select> dropdowns use browser_select instead.`,
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "aria-ref=eN from the snapshot, or CSS / text= / role=." },
        value: { type: "string", description: "The text to type. Empty string clears the field." },
      },
      required: ["selector", "value"],
      additionalProperties: false,
    },
    handler: browserFill,
  },
  {
    name: "browser_select",
    description:
      `Choose an option in a native <select> dropdown by its value or visible label (browser_fill cannot set selects). ${SELECTOR_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "The <select> element — aria-ref=eN or CSS." },
        value: { type: "string", description: "Option value or visible label to choose." },
      },
      required: ["selector", "value"],
      additionalProperties: false,
    },
    handler: browserSelect,
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
    name: "browser_hover",
    description:
      `Hover the mouse over an element to reveal hover-only UI (dropdown menus, tooltips), then return a snapshot showing what appeared. The hover holds until the next action, so a follow-up browser_click on a revealed item works. ${SELECTOR_HINT}`,
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "aria-ref=eN from the snapshot, or CSS / text= / role=." },
      },
      required: ["selector"],
      additionalProperties: false,
    },
    handler: browserHover,
  },
  {
    name: "browser_scroll",
    description:
      "Scroll the page and return a fresh snapshot. Pass `direction` ('down'/'up') to scroll by most of a viewport — this fires real wheel events, so infinite-scroll pages load more content. Or pass `selector` to scroll a specific element into view. Use when a snapshot says it was truncated or when content loads on scroll.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"], description: "Scroll direction. Default: down." },
        selector: { type: "string", description: "Optional element to scroll into view instead." },
      },
      additionalProperties: false,
    },
    handler: browserScroll,
  },
  {
    name: "browser_back",
    description:
      "Go back one page in this tab's history (like the browser Back button) and return a snapshot. Use to recover from a misclick or return to search results.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: browserBack,
  },
  {
    name: "browser_wait",
    description:
      "Wait for slow content instead of polling with snapshots: pass `selector` to wait until it is visible (up to 15s), and/or `ms` to pause a fixed time. Returns a snapshot once the condition holds.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Wait until this selector is visible." },
        ms: { type: "number", description: "Milliseconds to pause (max 15000)." },
      },
      additionalProperties: false,
    },
    handler: browserWait,
  },
  {
    name: "browser_screenshot",
    description:
      "Capture a JPEG screenshot of the current viewport and return it as image content. Use sparingly — screenshots are heavy in the context window. Prefer browser_snapshot when you only need structure/text; screenshot when layout or imagery matters. Humans can also watch the page live in the chat panel.",
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
      "Submit a form. Use this whenever your action sends data somewhere — clicking a 'Sign in' / 'Save' / 'Send' button, or pressing Enter inside a search/input. When the employee has approval-mode enabled, this queues an Approval row and returns `pending_approval` with an approvalId; call browser_resume(approvalId) once a human approves — in this turn or a later one. The approval is bound to the current page and fires exactly once, so keep the browser on the same page while it is pending. When approval mode is off, browser_submit fires immediately like a click. `summary` is a short, human-readable description shown to the approver.",
    inputSchema: {
      type: "object",
      properties: {
        selector: {
          type: "string",
          description:
            "The element to act on — usually a submit button (aria-ref=eN or CSS). With `key`, this is the input that should receive the key press.",
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
      "Re-fire a previously queued browser_submit once a human has approved it — in this turn or a later one. The approval fires exactly once and only while the browser is still on the page it was approved for; if the page has changed you'll be asked to submit again. Returns still-pending if the human hasn't decided yet; errors if it was rejected, already fired, or the page moved on.",
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

const SERVER_INFO = { name: "genosyn-browser", version: "0.5.0" };
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
