#!/usr/bin/env node
// @ts-check
/*
 * Built-in Genosyn browser MCP server.
 *
 * Spawned by the provider CLI (claude / codex / opencode / goose / openclaw)
 * as a stdio MCP server when the AI employee has `browserEnabled = true`.
 * Drives a single Chromium instance — either bundled in the App container
 * (default, "local" backend) or a remote Browserbase session — and exposes
 * a small tool surface (open, snapshot, click, fill, press, screenshot,
 * close, submit, resume) the model can use to read and interact with web
 * pages.
 *
 * Browser state:
 *   - One Chromium per spawn, reused across tool calls.
 *   - One persistent context + one page, recreated on demand.
 *   - Idle watchdog: after `IDLE_TIMEOUT_MS` with no tool call, the browser
 *     is shut down to release ~150 MB of RSS. The next call relaunches.
 *
 * Env vars (set by `services/mcp.ts` at materialize time):
 *
 *   GENOSYN_MCP_API
 *   GENOSYN_MCP_TOKEN
 *     Loopback URL + bearer for the internal MCP API. Used by
 *     `browser_submit` to queue an `Approval` and by `browser_resume` to
 *     poll its status. Optional — without them, approval flows are
 *     disabled and the gate flag becomes a no-op.
 *
 *   GENOSYN_BROWSER_ALLOWED_HOSTS
 *     Newline-separated list of host globs (e.g. `*.gmail.com`,
 *     `notion.so`). When set, `browser_open` rejects URLs whose hostname
 *     doesn't match. Lines starting with `#` are comments.
 *
 *   GENOSYN_BROWSER_APPROVAL_REQUIRED  ("1" / unset)
 *     When set, `browser_submit` doesn't fire its target action — it
 *     queues an Approval row and returns `pending_approval` to the model.
 *
 *   GENOSYN_BROWSER_BACKEND            ("local" / "browserbase")
 *   GENOSYN_BROWSERBASE_API_KEY
 *   GENOSYN_BROWSERBASE_PROJECT_ID
 *     Browserbase backend selection + creds. When backend is browserbase,
 *     we POST a session-create call and connect over CDP instead of
 *     launching the in-container Chromium.
 *
 *   PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
 *     Path to the local Chromium binary for the local backend. Set in the
 *     App Dockerfile. Unset on dev hosts that haven't installed Chromium —
 *     in that case `browser_open` returns a friendly error rather than
 *     hanging.
 *
 * Protocol surface implemented:
 *   - initialize
 *   - notifications/initialized  (ignored)
 *   - tools/list
 *   - tools/call
 * Anything else gets a "method not found" response.
 */

import readline from "node:readline";
import crypto from "node:crypto";

const API_BASE = process.env.GENOSYN_MCP_API ?? "";
const TOKEN = process.env.GENOSYN_MCP_TOKEN ?? "";
const ALLOWED_HOSTS = parseAllowList(process.env.GENOSYN_BROWSER_ALLOWED_HOSTS ?? "");
const APPROVAL_REQUIRED = process.env.GENOSYN_BROWSER_APPROVAL_REQUIRED === "1";
const BACKEND = process.env.GENOSYN_BROWSER_BACKEND === "browserbase" ? "browserbase" : "local";
const BROWSERBASE_API_KEY = process.env.GENOSYN_BROWSERBASE_API_KEY ?? "";
const BROWSERBASE_PROJECT_ID = process.env.GENOSYN_BROWSERBASE_PROJECT_ID ?? "";
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** @type {{ chromium: any } | null} */
let playwright = null;

/** @type {any} */
let browser = null;

/** @type {any} */
let context = null;

/** @type {any} */
let page = null;

/** @type {NodeJS.Timeout | null} */
let idleTimer = null;

/**
 * In-memory map of approval IDs to the action the MCP child is waiting to
 * re-fire. Lives only as long as this MCP spawn — if the spawn ends before
 * the approval is decided, the record is lost; the orphaned Approval just
 * expires server-side.
 *
 * @type {Map<string, { tool: "submit"; selector: string; value?: string; key?: string }>}
 */
const pendingActions = new Map();

/**
 * Lazy-load `playwright-core`. We don't import at top-level so the MCP can
 * cold-start fast even when the agent never calls a browser tool, and so a
 * missing Playwright install reports as a friendly tool error instead of a
 * crash on require.
 */
async function getPlaywright() {
  if (!playwright) {
    try {
      const mod = await import("playwright-core");
      playwright = { chromium: mod.chromium };
    } catch (err) {
      throw new Error(
        `playwright-core is not installed: ${
          err instanceof Error ? err.message : String(err)
        }. Browser tools require the App container to bundle Chromium and playwright-core.`,
      );
    }
  }
  return playwright;
}

/**
 * Launch (or reuse) a Chromium instance and return a ready-to-use page.
 *
 * Local backend: launch in-container Chromium with `--no-sandbox` + heap
 * tweaks, pointed at the apk-installed binary via
 * `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.
 *
 * Browserbase backend: POST a session create, then `connectOverCDP` to the
 * returned websocket URL. The session belongs to the company's project; we
 * pass `keepAlive: false` so the session disappears with our context.
 */
async function ensurePage() {
  resetIdleTimer();
  const pw = await getPlaywright();
  if (!browser) {
    if (BACKEND === "browserbase") {
      browser = await launchBrowserbase(pw);
    } else {
      browser = await pw.chromium.launch({
        headless: true,
        executablePath: CHROMIUM_PATH,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
      });
    }
  }
  if (!context) {
    if (BACKEND === "browserbase") {
      // Browserbase sessions hand us a context already; reuse the first.
      const contexts = browser.contexts();
      context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    } else {
      context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        userAgent:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Genosyn/0.1 Safari/537.36",
      });
    }
  }
  if (!page || page.isClosed()) {
    if (BACKEND === "browserbase") {
      const pages = context.pages();
      page = pages.length > 0 ? pages[0] : await context.newPage();
    } else {
      page = await context.newPage();
    }
  }
  return page;
}

/**
 * Open a Browserbase session via REST and connect Playwright to its CDP
 * endpoint. Errors here surface as the friendly tool error so the model
 * knows the credentials or quota is the problem.
 */
async function launchBrowserbase(pw) {
  if (!BROWSERBASE_API_KEY || !BROWSERBASE_PROJECT_ID) {
    throw new Error(
      "Browserbase backend selected but credentials are missing. Set the API key and project id at Settings → Company → Browser.",
    );
  }
  let session;
  try {
    const r = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-BB-API-Key": BROWSERBASE_API_KEY,
      },
      body: JSON.stringify({ projectId: BROWSERBASE_PROJECT_ID }),
    });
    if (!r.ok) {
      const body = await r.text();
      throw new Error(`Browserbase session create returned ${r.status}: ${body.slice(0, 200)}`);
    }
    session = await r.json();
  } catch (err) {
    throw new Error(
      `Could not start a Browserbase session: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!session?.id) {
    throw new Error("Browserbase session response missing `id`");
  }
  // Browserbase exposes a CDP endpoint; Playwright's connectOverCDP attaches
  // to the existing browser instance in their cloud.
  const wsUrl = `wss://connect.browserbase.com?apiKey=${encodeURIComponent(BROWSERBASE_API_KEY)}&sessionId=${encodeURIComponent(session.id)}`;
  return pw.chromium.connectOverCDP(wsUrl);
}

async function shutdown() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const oldPage = page;
  const oldContext = context;
  const oldBrowser = browser;
  page = null;
  context = null;
  browser = null;
  try {
    if (oldPage) await oldPage.close();
  } catch {
    // intentionally ignored — nothing to retry
  }
  try {
    // Browserbase contexts are owned by their cloud session; closing them
    // locally just detaches Playwright. We try anyway — the close is a
    // no-op when the context was never created.
    if (oldContext && BACKEND !== "browserbase") await oldContext.close();
  } catch {
    // intentionally ignored
  }
  try {
    if (oldBrowser) await oldBrowser.close();
  } catch {
    // intentionally ignored
  }
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    shutdown().catch(() => {
      // shutdown() already swallows; this is the unhandled-rejection guard
    });
  }, IDLE_TIMEOUT_MS);
}

// ---------- allow list ----------

/**
 * Parse the allow-list env var into a list of host globs. Lines starting
 * with `#` are comments; whitespace-only lines are dropped.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function parseAllowList(raw) {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

/**
 * Glob match a hostname against a single allow-list pattern. Only `*` is
 * a wildcard (matches one or more host segments at the position). All
 * matching is case-insensitive. Examples:
 *
 *   `*.gmail.com` matches `mail.gmail.com` but not `gmail.com`
 *   `gmail.com`   matches `gmail.com` exactly
 *   `*.notion.so` matches `notion.so` and any subdomain (we permit the
 *                 bare host since users naturally write the suffix form)
 *
 * @param {string} hostname
 * @param {string} pattern
 */
function hostMatches(hostname, pattern) {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    if (h === suffix) return true;
    if (h.endsWith("." + suffix)) return true;
    return false;
  }
  // Fallback: regex from glob, anchored.
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(h);
}

function urlAllowed(rawUrl) {
  if (ALLOWED_HOSTS.length === 0) return { ok: true };
  let host;
  try {
    host = new URL(rawUrl).hostname;
  } catch {
    return { ok: false, reason: "URL is not parseable" };
  }
  for (const pattern of ALLOWED_HOSTS) {
    if (hostMatches(host, pattern)) return { ok: true };
  }
  return {
    ok: false,
    reason: `Host \`${host}\` is not in the allow list. Allowed: ${ALLOWED_HOSTS.join(", ")}`,
  };
}

// ---------- snapshot helpers ----------

const A11Y_MAX_LINES = 200;
const TEXT_MAX_BYTES = 8 * 1024;

async function pageSnapshot(p) {
  const url = p.url();
  let title = "";
  try {
    title = await p.title();
  } catch {
    // ignore — title is best-effort
  }

  let a11yLines = [];
  try {
    const tree = await p.accessibility.snapshot({ interestingOnly: true });
    if (tree) formatA11y(tree, 0, a11yLines);
  } catch {
    // Playwright can fail on detached frames; we fall back to text below.
  }

  let truncatedA11y = false;
  if (a11yLines.length > A11Y_MAX_LINES) {
    truncatedA11y = true;
    a11yLines = a11yLines.slice(0, A11Y_MAX_LINES);
  }

  let bodyText = "";
  try {
    bodyText = await p.evaluate(() => document.body?.innerText ?? "");
  } catch {
    // ignore — body text is best-effort
  }
  let truncatedText = false;
  if (Buffer.byteLength(bodyText, "utf8") > TEXT_MAX_BYTES) {
    bodyText = bodyText.slice(0, TEXT_MAX_BYTES);
    truncatedText = true;
  }

  const sections = [
    `URL: ${url}`,
    `Title: ${title || "(none)"}`,
    "",
    "## Accessibility tree",
    a11yLines.length > 0 ? a11yLines.join("\n") : "(empty)",
  ];
  if (truncatedA11y) {
    sections.push(`(truncated to first ${A11Y_MAX_LINES} nodes)`);
  }
  sections.push("", "## Visible text", bodyText || "(empty)");
  if (truncatedText) {
    sections.push(`(truncated to first ${TEXT_MAX_BYTES} bytes)`);
  }
  return sections.join("\n");
}

/**
 * @param {any} node
 * @param {number} depth
 * @param {string[]} out
 */
function formatA11y(node, depth, out) {
  if (!node) return;
  const role = node.role || "";
  let name = node.name || "";
  if (name.length > 120) name = name.slice(0, 117) + "...";
  let line = "  ".repeat(depth) + `- ${role}`;
  if (name) line += `: ${JSON.stringify(name)}`;
  if (node.value) line += ` value=${JSON.stringify(String(node.value).slice(0, 60))}`;
  if (node.checked) line += ` checked`;
  if (node.disabled) line += ` disabled`;
  out.push(line);
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      if (out.length >= A11Y_MAX_LINES + 1) break;
      formatA11y(child, depth + 1, out);
    }
  }
}

// ---------- locator helpers ----------

async function locate(p, selector, timeoutMs) {
  if (typeof selector !== "string" || selector.length === 0) {
    throw new Error("`selector` is required");
  }
  const loc = p.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: timeoutMs });
  return loc;
}

async function waitForIdle(p) {
  try {
    await p.waitForLoadState("networkidle", { timeout: 3_000 });
  } catch {
    // networkidle is advisory, not required
  }
}

// ---------- approval callbacks ----------

/**
 * POST a body to the internal MCP API and return parsed JSON. Errors are
 * thrown — the caller wraps them in tool-error results.
 */
async function callGenosyn(endpoint, body) {
  if (!API_BASE || !TOKEN) {
    throw new Error(
      "GENOSYN_MCP_API / GENOSYN_MCP_TOKEN not set — cannot reach the Genosyn server. Approval flows are disabled.",
    );
  }
  const url = API_BASE.replace(/\/+$/, "") + endpoint;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON reply (${r.status}): ${text.slice(0, 300)}`);
  }
}

async function getGenosyn(endpoint) {
  if (!API_BASE || !TOKEN) {
    throw new Error("GENOSYN_MCP_API / GENOSYN_MCP_TOKEN not set");
  }
  const url = API_BASE.replace(/\/+$/, "") + endpoint;
  const r = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 300)}`);
  }
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
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("`url` must be an absolute http(s) URL");
  }
  const allowed = urlAllowed(url);
  if (!allowed.ok) throw new Error(allowed.reason);
  const p = await ensurePage();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
  return textResult(await pageSnapshot(p));
}

async function browserSnapshot() {
  const p = await ensurePage();
  return textResult(await pageSnapshot(p));
}

async function browserClick(args) {
  const p = await ensurePage();
  const loc = await locate(p, args?.selector, DEFAULT_TIMEOUT_MS);
  await loc.click({ timeout: DEFAULT_TIMEOUT_MS });
  await waitForIdle(p);
  return textResult(await pageSnapshot(p));
}

async function browserFill(args) {
  const p = await ensurePage();
  const value = typeof args?.value === "string" ? args.value : "";
  const loc = await locate(p, args?.selector, DEFAULT_TIMEOUT_MS);
  await loc.fill(value, { timeout: DEFAULT_TIMEOUT_MS });
  return textResult(await pageSnapshot(p));
}

async function browserPress(args) {
  const key = String(args?.key ?? "").trim();
  if (!key) throw new Error("`key` is required (e.g. 'Enter', 'Tab', 'ArrowDown')");
  const p = await ensurePage();
  if (typeof args?.selector === "string" && args.selector.length > 0) {
    const loc = await locate(p, args.selector, DEFAULT_TIMEOUT_MS);
    await loc.press(key, { timeout: DEFAULT_TIMEOUT_MS });
  } else {
    await p.keyboard.press(key);
  }
  await waitForIdle(p);
  return textResult(await pageSnapshot(p));
}

async function browserScreenshot() {
  const p = await ensurePage();
  const buf = await p.screenshot({ type: "png", fullPage: false });
  return {
    content: [
      {
        type: "image",
        data: buf.toString("base64"),
        mimeType: "image/png",
      },
    ],
  };
}

async function browserClose() {
  await shutdown();
  return textResult("Browser closed.");
}

/**
 * Submit a form. When approval mode is on this is the gated tool — calling
 * it queues an Approval and returns `pending_approval`; the model has to
 * call `browser_resume(approvalId)` to actually fire the action once a
 * human approves. When approval mode is off it behaves like a click on
 * `selector` (or an Enter press if `key: "Enter"` is supplied) so models
 * can use it uniformly without branching.
 *
 * Args:
 *   selector  — element to act on (a submit button, or the input that
 *               should receive the key press).
 *   key       — optional. "Enter" / "Tab" / etc. When set, the action is
 *               a key press on `selector` instead of a click.
 *   summary   — short human-readable description of why this submit is
 *               happening; surfaced to the approver.
 */
async function browserSubmit(args) {
  const selector = String(args?.selector ?? "").trim();
  if (!selector) throw new Error("`selector` is required");
  const key = typeof args?.key === "string" ? args.key : undefined;
  const summary =
    typeof args?.summary === "string" ? args.summary.trim() : "Submit a form via the browser MCP";

  if (!APPROVAL_REQUIRED) {
    return executeSubmit(selector, key);
  }

  // Approval gate is on. Snapshot the current URL so the approver has
  // context, then queue the Approval and stash the action.
  const p = await ensurePage();
  let pageUrl = "";
  try {
    pageUrl = p.url();
  } catch {
    // best-effort — empty pageUrl means we couldn't grab the URL but we
    // still go ahead with the queue
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
    // Server may have minted its own id — re-key the pending entry so
    // `browser_resume(approvalId)` finds the action.
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
  const p = await ensurePage();
  const loc = await locate(p, selector, DEFAULT_TIMEOUT_MS);
  if (key) {
    await loc.press(key, { timeout: DEFAULT_TIMEOUT_MS });
  } else {
    await loc.click({ timeout: DEFAULT_TIMEOUT_MS });
  }
  await waitForIdle(p);
  return textResult(await pageSnapshot(p));
}

/**
 * Poll the status of a queued browser-action approval. When the row flips
 * to `approved`, re-fire the held action and return the post-action
 * snapshot. `pending` and `rejected` come back as informational results
 * (no isError flag for pending — the model is supposed to retry).
 */
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

/** @type {{ name: string; description: string; inputSchema: any; handler: (args: any) => Promise<any> }[]} */
const TOOLS = [
  {
    name: "browser_open",
    description:
      "Navigate to an absolute http(s) URL in the headless browser and return a snapshot of the loaded page (URL, title, accessibility tree, visible text). Use this first to land on a page. Some employees have an allow list; opening an off-list URL returns an error.",
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
      "Return a fresh snapshot of the current page (URL, title, accessibility tree, visible text). Use after a click/fill/press to see what changed.",
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
      "Capture a PNG screenshot of the current viewport and return it as image content. Use sparingly — screenshots are heavy in the context window. Prefer browser_snapshot when you only need text.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: browserScreenshot,
  },
  {
    name: "browser_close",
    description:
      "Shut down the browser and free its memory. The next browser_open will launch a fresh instance. Optional — the browser auto-closes after 5 minutes of inactivity.",
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

const SERVER_INFO = { name: "genosyn-browser", version: "0.2.0" };
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
  shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
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
