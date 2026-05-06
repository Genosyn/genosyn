import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { validateBody } from "../middleware/validate.js";
import { resolveBrowserSessionToken, markSessionLive } from "../services/browserSessions.js";
import {
  acquirePage,
  releasePage,
  getRuntime,
  markActivity,
} from "../services/browserChromium.js";

/**
 * Internal HTTP surface called by the stripped-down `browser` MCP child.
 *
 * Each browser tool the AI invokes (`browser_open`, `browser_click`, …)
 * round-trips here as a POST. The App owns the headless Chromium, so the
 * MCP child stays a thin protocol translator — Chromium persists across
 * MCP spawns / chat turns, which is what makes "I'll wait while you drop
 * your credentials in" actually work.
 *
 * Auth: bearer token = `BrowserSession.mcpToken` (per-session). The
 * resolved session id is stamped on the request for downstream handlers.
 *
 * Mounted at `/api/internal/browser/sessions/:id/`. The session-id
 * segment is redundant with the bearer token (which already implies the
 * session) but appears in the URL so the routes read naturally and
 * accidental token reuse across sessions surfaces as a 403.
 */

export const browserRpcRouter = Router({ mergeParams: true });

type BrowserRpcReq = Request<{ id: string }> & {
  browserSession?: BrowserSession;
  browserEmployee?: AIEmployee;
};

const A11Y_MAX_LINES = 200;
const TEXT_MAX_BYTES = 8 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

async function requireBrowserSession(req: BrowserRpcReq, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  const sessionId = resolveBrowserSessionToken(token);
  if (!sessionId) return res.status(401).json({ error: "Invalid token" });
  if (sessionId !== req.params.id) {
    return res.status(403).json({ error: "Token does not match session id" });
  }
  const repo = AppDataSource.getRepository(BrowserSession);
  const row = await repo.findOneBy({ id: sessionId });
  if (!row) return res.status(404).json({ error: "Session not found" });
  if (row.status === "closed" || row.status === "expired") {
    return res.status(410).json({ error: "Session is closed" });
  }
  if (row.mcpTokenExpiresAt.getTime() < Date.now()) {
    return res.status(401).json({ error: "Token expired" });
  }
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: row.employeeId });
  if (!emp) return res.status(404).json({ error: "Employee not found" });
  req.browserSession = row;
  req.browserEmployee = emp;
  next();
}

browserRpcRouter.use(requireBrowserSession);

// ---------- helpers ----------

type Page = {
  url: () => string;
  title: () => Promise<string>;
  goto: (url: string, opts: unknown) => Promise<unknown>;
  locator: (sel: string) => { first: () => Locator };
  keyboard: { press: (key: string) => Promise<void> };
  waitForLoadState: (state: string, opts: unknown) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  accessibility: { snapshot: (opts: unknown) => Promise<unknown> };
  screenshot: (opts: unknown) => Promise<Buffer>;
};

type Locator = {
  waitFor: (opts: unknown) => Promise<void>;
  click: (opts: unknown) => Promise<void>;
  fill: (value: string, opts: unknown) => Promise<void>;
  press: (key: string, opts: unknown) => Promise<void>;
};

function parseAllowList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

function hostMatches(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(2);
    if (h === suffix) return true;
    if (h.endsWith("." + suffix)) return true;
    return false;
  }
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(h);
}

function urlAllowed(url: string, allowList: string[]): { ok: true } | { ok: false; reason: string } {
  if (allowList.length === 0) return { ok: true };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, reason: "URL is not parseable" };
  }
  for (const pattern of allowList) {
    if (hostMatches(host, pattern)) return { ok: true };
  }
  return {
    ok: false,
    reason: `Host \`${host}\` is not in the allow list. Allowed: ${allowList.join(", ")}`,
  };
}

async function pageSnapshot(p: Page): Promise<string> {
  const url = p.url();
  let title = "";
  try {
    title = await p.title();
  } catch {
    // best-effort
  }

  let a11yLines: string[] = [];
  try {
    const tree = await p.accessibility.snapshot({ interestingOnly: true });
    if (tree) formatA11y(tree, 0, a11yLines);
  } catch {
    // ignore
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
    // ignore
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
  if (truncatedA11y) sections.push(`(truncated to first ${A11Y_MAX_LINES} nodes)`);
  sections.push("", "## Visible text", bodyText || "(empty)");
  if (truncatedText) sections.push(`(truncated to first ${TEXT_MAX_BYTES} bytes)`);
  return sections.join("\n");
}

function formatA11y(node: unknown, depth: number, out: string[]): void {
  if (!node || typeof node !== "object") return;
  const n = node as { role?: string; name?: string; value?: unknown; checked?: boolean; disabled?: boolean; children?: unknown[] };
  const role = n.role || "";
  let name = n.name || "";
  if (name.length > 120) name = name.slice(0, 117) + "...";
  let line = "  ".repeat(depth) + `- ${role}`;
  if (name) line += `: ${JSON.stringify(name)}`;
  if (n.value) line += ` value=${JSON.stringify(String(n.value).slice(0, 60))}`;
  if (n.checked) line += ` checked`;
  if (n.disabled) line += ` disabled`;
  out.push(line);
  if (Array.isArray(n.children)) {
    for (const child of n.children) {
      if (out.length >= A11Y_MAX_LINES + 1) break;
      formatA11y(child, depth + 1, out);
    }
  }
}

async function locate(p: Page, selector: string, timeoutMs: number): Promise<Locator> {
  if (typeof selector !== "string" || selector.length === 0) {
    throw new Error("`selector` is required");
  }
  const loc = p.locator(selector).first();
  await loc.waitFor({ state: "visible", timeout: timeoutMs });
  return loc;
}

async function waitForIdle(p: Page): Promise<void> {
  try {
    await p.waitForLoadState("networkidle", { timeout: 3_000 });
  } catch {
    // advisory
  }
}

async function bumpAndAcquire(req: BrowserRpcReq): Promise<Page> {
  const session = req.browserSession!;
  markActivity(session.id);
  const page = (await acquirePage(session.id)) as Page;
  await markSessionLive(session.id);
  return page;
}

// ---------- routes ----------

const openSchema = z.object({ url: z.string().min(1).max(2048) });
browserRpcRouter.post("/open", validateBody(openSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof openSchema>;
  const url = body.url.trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "`url` must be an absolute http(s) URL" });
  }
  const allow = parseAllowList(req.browserEmployee!.browserAllowedHosts);
  const ok = urlAllowed(url, allow);
  if (!ok.ok) return res.status(403).json({ error: ok.reason });
  try {
    const page = await bumpAndAcquire(req);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT_MS });
    res.json({ snapshot: await pageSnapshot(page) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

browserRpcRouter.post("/snapshot", async (req: BrowserRpcReq, res) => {
  try {
    const page = await bumpAndAcquire(req);
    res.json({ snapshot: await pageSnapshot(page) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const clickSchema = z.object({ selector: z.string().min(1).max(500) });
browserRpcRouter.post("/click", validateBody(clickSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof clickSchema>;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, body.selector, DEFAULT_TIMEOUT_MS);
    await loc.click({ timeout: DEFAULT_TIMEOUT_MS });
    await waitForIdle(page);
    res.json({ snapshot: await pageSnapshot(page) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const fillSchema = z.object({
  selector: z.string().min(1).max(500),
  value: z.string().max(50_000),
});
browserRpcRouter.post("/fill", validateBody(fillSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof fillSchema>;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, body.selector, DEFAULT_TIMEOUT_MS);
    await loc.fill(body.value, { timeout: DEFAULT_TIMEOUT_MS });
    res.json({ snapshot: await pageSnapshot(page) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const pressSchema = z.object({
  key: z.string().min(1).max(60),
  selector: z.string().max(500).optional(),
});
browserRpcRouter.post("/press", validateBody(pressSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof pressSchema>;
  try {
    const page = await bumpAndAcquire(req);
    if (body.selector && body.selector.length > 0) {
      const loc = await locate(page, body.selector, DEFAULT_TIMEOUT_MS);
      await loc.press(body.key, { timeout: DEFAULT_TIMEOUT_MS });
    } else {
      await page.keyboard.press(body.key);
    }
    await waitForIdle(page);
    res.json({ snapshot: await pageSnapshot(page) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

browserRpcRouter.post("/screenshot", async (req: BrowserRpcReq, res) => {
  try {
    const page = await bumpAndAcquire(req);
    const buf = await page.screenshot({ type: "png", fullPage: false });
    res.json({ data: buf.toString("base64"), mimeType: "image/png" });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

browserRpcRouter.post("/close", async (req: BrowserRpcReq, res) => {
  const session = req.browserSession!;
  // Only tear down if no viewer is watching — humans actively in the
  // panel shouldn't be stomped by a model that decides to call
  // browser_close at the end of its turn.
  const runtime = getRuntime(session.id);
  if (!runtime) return res.json({ ok: true });
  if (runtime.activeHolders > 0) {
    return res.json({ ok: true, kept: "viewer-active" });
  }
  await releasePage(session.id, "shutdown");
  res.json({ ok: true });
});
