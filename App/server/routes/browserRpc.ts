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
  pushSessionNotice,
  takeSessionNotices,
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
 * Snapshots are Playwright aria snapshots in `ai` mode: a YAML outline of
 * the page in which every interactive element carries a `[ref=eN]` marker.
 * The model acts on those refs directly (`aria-ref=e12` as the selector),
 * which resolves instantly and unambiguously — no CSS guessing. Refs stay
 * valid until the next snapshot replaces them, and every action returns a
 * fresh snapshot, so the refs the model sees are always current.
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

const SNAPSHOT_MAX_LINES = 400;
const TEXT_MAX_BYTES = 8 * 1024;
/** Navigation budget (goto / goBack) — pages can genuinely be slow. */
const NAV_TIMEOUT_MS = 30_000;
/**
 * How long a selector gets to match a visible element. Kept short on
 * purpose: a wrong guess should fail in seconds, not eat a 30s navigation
 * budget — the model recovers by reading the snapshot in the error and
 * picking a real ref. `browser_wait` exists for genuinely slow content.
 */
const LOCATE_TIMEOUT_MS = 5_000;
/** Actionability budget once the element exists (scroll into view, enabled…). */
const ACTION_TIMEOUT_MS = 10_000;
const ARIA_SNAPSHOT_TIMEOUT_MS = 5_000;
const WAIT_MAX_MS = 15_000;

async function requireBrowserSession(req: BrowserRpcReq, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  if (!token) return res.status(401).json({ error: "Missing bearer token" });
  const sessionId = await resolveBrowserSessionToken(token);
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
  goBack: (opts: unknown) => Promise<unknown>;
  locator: (sel: string) => PageLocator;
  keyboard: { press: (key: string) => Promise<void> };
  mouse: { wheel: (dx: number, dy: number) => Promise<void> };
  waitForLoadState: (state: string, opts: unknown) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  evaluate: <T>(fn: () => T) => Promise<T>;
  ariaSnapshot: (opts: { mode: "ai" | "default"; timeout?: number }) => Promise<string>;
  screenshot: (opts: unknown) => Promise<Buffer>;
};

type PageLocator = {
  first: () => Locator;
  count: () => Promise<number>;
};

type Locator = {
  waitFor: (opts: unknown) => Promise<void>;
  click: (opts: unknown) => Promise<void>;
  fill: (value: string, opts: unknown) => Promise<void>;
  press: (key: string, opts: unknown) => Promise<void>;
  hover: (opts: unknown) => Promise<void>;
  selectOption: (values: unknown, opts: unknown) => Promise<string[]>;
  scrollIntoViewIfNeeded: (opts: unknown) => Promise<void>;
};

function parseAllowList(raw: string | null): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("#"));
}

/**
 * Allow-list matching rules (documented in the UI hint and the Browser docs
 * page — keep all three in sync):
 *   - `example.com`   → the apex and every subdomain (what every written
 *                       example assumes; an exact-only apex match stranded
 *                       agents on `www.` redirects)
 *   - `*.example.com` → the apex and every subdomain (same as above, kept
 *                       for backwards compatibility)
 *   - `app.example.com` → that exact host and its subdomains
 *   - patterns with `*` elsewhere are general globs matched against the host
 */
function hostMatches(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (!p.includes("*")) {
    return h === p || h.endsWith("." + p);
  }
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

/** Byte-accurate UTF-8 truncation that never splits a code point. */
function truncateUtf8(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return { text: s, truncated: false };
  let text = buf.subarray(0, maxBytes).toString("utf8");
  // A code point split at the boundary decodes to U+FFFD — drop it.
  if (text.endsWith("�")) text = text.slice(0, -1);
  return { text, truncated: true };
}

async function pageSnapshot(p: Page, sessionId: string): Promise<string> {
  const url = p.url();
  const [title, tree] = await Promise.all([
    p.title().catch(() => ""),
    p.ariaSnapshot({ mode: "ai", timeout: ARIA_SNAPSHOT_TIMEOUT_MS }).catch(() => ""),
  ]);

  const sections: string[] = [];
  for (const notice of takeSessionNotices(sessionId)) {
    sections.push(`NOTE: ${notice}`);
  }
  sections.push(`URL: ${url}`, `Title: ${title || "(none)"}`, "");

  if (tree.trim().length > 0) {
    let lines = tree.split("\n");
    const total = lines.length;
    const truncated = total > SNAPSHOT_MAX_LINES;
    if (truncated) lines = lines.slice(0, SNAPSHOT_MAX_LINES);
    sections.push(
      "## Page snapshot",
      "Interactive elements carry [ref=eN] markers — act on them by passing `aria-ref=eN` as the selector.",
      ...lines,
    );
    if (truncated) {
      sections.push(
        `(truncated: showing lines 1-${SNAPSHOT_MAX_LINES} of ${total} — the page continues; use browser_scroll or a more specific action to reach content further down)`,
      );
    }
    return sections.join("\n");
  }

  // Aria snapshot came back empty (blank page, or a page still rendering).
  // Fall back to raw visible text so the model isn't left with nothing.
  let bodyText = "";
  try {
    bodyText = await p.evaluate(() => (document.body?.innerText ?? "").slice(0, 16_384));
  } catch {
    // ignore
  }
  const { text, truncated } = truncateUtf8(bodyText, TEXT_MAX_BYTES);
  sections.push(
    "## Visible text",
    text ||
      "(empty — the page may still be rendering; call browser_wait or browser_snapshot to retry)",
  );
  if (truncated) sections.push(`(truncated to first ${TEXT_MAX_BYTES} bytes)`);
  return sections.join("\n");
}

/**
 * Resolve a selector to its first visible match, failing fast. On no match
 * the error carries a fresh snapshot so the model can pick a valid ref
 * without spending another turn on browser_snapshot. When a CSS/text
 * selector matches several elements, a notice flags the ambiguity instead
 * of silently acting on the first.
 */
async function locate(p: Page, sessionId: string, selector: string): Promise<Locator> {
  const base = p.locator(selector);
  const loc = base.first();
  try {
    await loc.waitFor({ state: "visible", timeout: LOCATE_TIMEOUT_MS });
  } catch (err) {
    // Distinguish "nothing matched in time" from a malformed selector —
    // Playwright reports the latter with a parse error worth relaying.
    const raw = errText(err);
    const timedOut = raw.includes("Timeout");
    let snap = "";
    try {
      snap = await pageSnapshot(p, sessionId);
    } catch {
      // page may be mid-navigation — the message alone still helps
    }
    throw new Error(
      (timedOut
        ? `No visible element matched selector \`${selector}\` within ${LOCATE_TIMEOUT_MS}ms. `
        : `Selector \`${selector}\` failed: ${raw}. `) +
        `Prefer an \`aria-ref=eN\` ref from the snapshot below.` +
        (snap ? `\n\nCurrent page:\n${snap}` : ""),
    );
  }
  if (!selector.startsWith("aria-ref=")) {
    try {
      const n = await base.count();
      if (n > 1) {
        pushSessionNotice(
          sessionId,
          `Selector \`${selector}\` matched ${n} elements — acted on the first. Use an aria-ref from the snapshot to target precisely.`,
        );
      }
    } catch {
      // advisory only
    }
  }
  return loc;
}

/**
 * Let the page settle after an action before snapshotting. Waits for the
 * DOM to go quiet (no mutations for 250ms, capped at 1.5s) — far cheaper
 * than the old `networkidle` wait, which burned its full 3s timeout on any
 * page with analytics beacons or sockets. If the action kicked off a
 * navigation, the quiescence evaluate dies with the old document; the
 * bounded `domcontentloaded` wait below covers that case (and resolves
 * instantly when no navigation happened).
 */
async function settle(p: Page): Promise<void> {
  try {
    await p.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const QUIET_MS = 250;
          const CAP_MS = 1_500;
          const done = () => {
            observer.disconnect();
            clearTimeout(quietTimer);
            clearTimeout(capTimer);
            resolve();
          };
          let quietTimer = setTimeout(done, QUIET_MS);
          const capTimer = setTimeout(done, CAP_MS);
          const observer = new MutationObserver(() => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(done, QUIET_MS);
          });
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
        }),
    );
  } catch {
    // navigation destroyed the evaluation context — fall through
  }
  try {
    await p.waitForLoadState("domcontentloaded", { timeout: 5_000 });
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

/**
 * The page to snapshot after an action — re-read from the runtime because
 * the action may have opened a popup that `adoptPage` has since made the
 * active page.
 */
function currentPage(sessionId: string, fallback: Page): Page {
  const runtime = getRuntime(sessionId);
  return (runtime?.page as Page | undefined) ?? fallback;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    // Give SPAs a beat to hydrate — a snapshot at bare domcontentloaded is
    // often an empty shell that costs the model a retry turn.
    await settle(page);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

browserRpcRouter.post("/snapshot", async (req: BrowserRpcReq, res) => {
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

/**
 * Lightweight current-location read for the approval flow — no snapshot
 * machinery and, deliberately, no `bumpAndAcquire`: asking "where are we?"
 * must not launch Chromium.
 */
browserRpcRouter.post("/url", async (req: BrowserRpcReq, res) => {
  const session = req.browserSession!;
  const runtime = getRuntime(session.id);
  const page = runtime?.page as { url: () => string; isClosed: () => boolean } | undefined | null;
  if (page && !page.isClosed()) {
    return res.json({ url: page.url(), title: session.pageTitle ?? null });
  }
  res.json({ url: session.pageUrl ?? "", title: session.pageTitle ?? null });
});

const clickSchema = z.object({ selector: z.string().min(1).max(500) });
browserRpcRouter.post("/click", validateBody(clickSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof clickSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, sessionId, body.selector);
    await loc.click({ timeout: ACTION_TIMEOUT_MS });
    await settle(page);
    const p = currentPage(sessionId, page);
    res.json({ snapshot: await pageSnapshot(p, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

const fillSchema = z.object({
  selector: z.string().min(1).max(500),
  value: z.string().max(50_000),
});
browserRpcRouter.post("/fill", validateBody(fillSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof fillSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, sessionId, body.selector);
    await loc.fill(body.value, { timeout: ACTION_TIMEOUT_MS });
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

const pressSchema = z.object({
  key: z.string().min(1).max(60),
  selector: z.string().max(500).optional(),
});
browserRpcRouter.post("/press", validateBody(pressSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof pressSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    if (body.selector && body.selector.length > 0) {
      const loc = await locate(page, sessionId, body.selector);
      await loc.press(body.key, { timeout: ACTION_TIMEOUT_MS });
    } else {
      await page.keyboard.press(body.key);
    }
    await settle(page);
    const p = currentPage(sessionId, page);
    res.json({ snapshot: await pageSnapshot(p, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

const selectSchema = z.object({
  selector: z.string().min(1).max(500),
  value: z.string().max(500),
});
browserRpcRouter.post("/select", validateBody(selectSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof selectSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, sessionId, body.selector);
    // Try the option's `value` attribute first, then its visible label —
    // the model usually quotes whichever it saw in the snapshot.
    try {
      await loc.selectOption(body.value, { timeout: ACTION_TIMEOUT_MS });
    } catch {
      await loc.selectOption({ label: body.value }, { timeout: ACTION_TIMEOUT_MS });
    }
    await settle(page);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

const hoverSchema = z.object({ selector: z.string().min(1).max(500) });
browserRpcRouter.post("/hover", validateBody(hoverSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof hoverSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const loc = await locate(page, sessionId, body.selector);
    await loc.hover({ timeout: ACTION_TIMEOUT_MS });
    await settle(page);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

const scrollSchema = z.object({
  direction: z.enum(["up", "down"]).optional(),
  selector: z.string().max(500).optional(),
});
browserRpcRouter.post("/scroll", validateBody(scrollSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof scrollSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    if (body.selector && body.selector.length > 0) {
      const loc = await locate(page, sessionId, body.selector);
      await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    } else {
      // A wheel gesture (not scrollBy) so infinite-scroll listeners fire.
      const dy = body.direction === "up" ? -640 : 640;
      await page.mouse.wheel(0, dy);
    }
    await settle(page);
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

browserRpcRouter.post("/back", async (req: BrowserRpcReq, res) => {
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    const result = await page.goBack({ waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    if (result === null) {
      pushSessionNotice(sessionId, "There is no earlier page in this tab's history — staying put.");
    } else {
      await settle(page);
    }
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

const waitSchema = z
  .object({
    selector: z.string().max(500).optional(),
    ms: z.number().int().min(1).max(WAIT_MAX_MS).optional(),
  })
  .refine((v) => v.selector || v.ms, { message: "Pass `selector`, `ms`, or both" });
browserRpcRouter.post("/wait", validateBody(waitSchema), async (req: BrowserRpcReq, res) => {
  const body = req.body as z.infer<typeof waitSchema>;
  const sessionId = req.browserSession!.id;
  try {
    const page = await bumpAndAcquire(req);
    if (body.ms) await page.waitForTimeout(body.ms);
    if (body.selector && body.selector.length > 0) {
      const loc = page.locator(body.selector).first();
      await loc.waitFor({ state: "visible", timeout: WAIT_MAX_MS });
    }
    res.json({ snapshot: await pageSnapshot(page, sessionId) });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
  }
});

browserRpcRouter.post("/screenshot", async (req: BrowserRpcReq, res) => {
  try {
    const page = await bumpAndAcquire(req);
    // JPEG at the same quality as the live-view screencast — 3-5x smaller
    // than PNG in the model's context for visually identical content.
    const buf = await page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
    res.json({ data: buf.toString("base64"), mimeType: "image/jpeg" });
  } catch (err) {
    res.status(500).json({ error: errText(err) });
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
