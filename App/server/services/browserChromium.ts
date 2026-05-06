import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { closeBrowserSession } from "./browserSessions.js";

/**
 * App-owned headless Chromium per `BrowserSession`. Decoupled from the MCP
 * child's lifecycle so the browser persists across chat turns: the agent
 * can promise "I'll wait while you drop in your credentials" without
 * lying, because the same Chromium is still running when the next turn
 * fires and reattaches.
 *
 * One Browser + one Context + one Page per session, lazily launched on
 * the first tool call. An idle watchdog tears the browser down after
 * `IDLE_TIMEOUT_MS` of no agent activity AND no viewer attached, freeing
 * the ~150 MB RSS without surprising humans who are mid-flow.
 *
 * Screencast / input dispatch live elsewhere (`browserSessions.ts`) — this
 * module just owns the lifecycle of the headed objects and exposes a
 * `getPage` accessor for the routes that drive them.
 */

// Use `any` types here because pulling in the full Playwright types adds
// a heavy dependency surface for what is otherwise straightforward.
// playwright-core is loaded lazily so a stock dev host without Chromium
// installed only sees the friendly error when an employee actually
// flips browserEnabled on.

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;

const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

type SessionRuntime = {
  id: string;
  browser: unknown; // Playwright Browser
  context: unknown; // Playwright BrowserContext
  page: unknown; // Playwright Page
  cdp: unknown; // Playwright CDPSession
  idleTimer: NodeJS.Timeout | null;
  /** Counted by `markActivity`. When > 0 the idle watchdog is suspended. */
  activeHolders: number;
};

const runtimes = new Map<string, SessionRuntime>();
let playwrightModule: { chromium: { launch: (opts: unknown) => Promise<unknown> } } | null = null;

async function getPlaywright(): Promise<typeof playwrightModule extends infer T ? NonNullable<T> : never> {
  if (!playwrightModule) {
    try {
      const mod = await import("playwright-core");
      playwrightModule = { chromium: mod.chromium as unknown as { launch: (opts: unknown) => Promise<unknown> } };
    } catch (err) {
      throw new Error(
        `playwright-core is not installed: ${
          err instanceof Error ? err.message : String(err)
        }. Browser tools require the App container to bundle Chromium and playwright-core.`,
      );
    }
  }
  return playwrightModule as NonNullable<typeof playwrightModule>;
}

/**
 * Launch (or reuse) Chromium for this session and return a ready-to-use
 * Page. Resets the idle timer; callers don't need to `markActivity` again
 * after this. Throws on infra problems (Playwright missing, Chromium
 * binary missing) so the caller can surface a friendly tool error.
 */
export async function acquirePage(sessionId: string): Promise<unknown> {
  const existing = runtimes.get(sessionId);
  if (existing) {
    resetIdleTimer(existing);
    const p = existing.page as { isClosed: () => boolean } | null;
    if (p && !p.isClosed()) return existing.page;
    // Page was closed (e.g. agent called browser_close mid-turn). Reopen
    // on the same context so cookies / storage state survive.
    const ctx = existing.context as { newPage: () => Promise<unknown> };
    existing.page = await ctx.newPage();
    existing.cdp = await attachCdp(existing.page);
    return existing.page;
  }

  const pw = await getPlaywright();
  const browser = await pw.chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await (browser as { newContext: (opts: unknown) => Promise<unknown> }).newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Genosyn/0.4 Safari/537.36",
  });
  const page = await (context as { newPage: () => Promise<unknown> }).newPage();
  const cdp = await attachCdp(page);

  const runtime: SessionRuntime = {
    id: sessionId,
    browser,
    context,
    page,
    cdp,
    idleTimer: null,
    activeHolders: 0,
  };
  runtimes.set(sessionId, runtime);
  resetIdleTimer(runtime);

  // Mirror navigation events onto the BrowserSession row + fan-out hub so
  // viewers and the live-panel poll see the URL update without waiting
  // for the next tool call.
  (page as { on: (ev: string, cb: (frame: unknown) => void) => void }).on(
    "framenavigated",
    (frame) => {
      const f = frame as { url: () => string; parentFrame: () => unknown };
      if (f.parentFrame()) return;
      void onNavigated(sessionId, page).catch(() => {
        // best-effort
      });
    },
  );

  return page;
}

async function attachCdp(page: unknown): Promise<unknown> {
  const ctx = (page as { context: () => { newCDPSession: (p: unknown) => Promise<unknown> } }).context();
  return ctx.newCDPSession(page);
}

async function onNavigated(sessionId: string, page: unknown): Promise<void> {
  const p = page as { url: () => string; title: () => Promise<string> };
  const url = p.url();
  let title = "";
  try {
    title = await p.title();
  } catch {
    // best-effort
  }
  const repo = AppDataSource.getRepository(BrowserSession);
  const row = await repo.findOneBy({ id: sessionId });
  if (row) {
    row.pageUrl = url;
    row.pageTitle = title || null;
    await repo.save(row);
  }
  // The fanout hub picks up nav events via the screencast loop's snapshot,
  // but pushing one explicitly keeps the viewer URL-bar in sync between
  // frames.
  const { broadcastNav } = await import("./browserSessions.js");
  broadcastNav(sessionId, url, title || null);
}

/**
 * Look up an already-acquired Page without launching. Used by viewer
 * input dispatch — there's no point in spinning up Chromium just because
 * a human moved their mouse.
 */
export function getRuntime(sessionId: string): SessionRuntime | null {
  return runtimes.get(sessionId) ?? null;
}

/**
 * Bump the idle counter so the watchdog doesn't shut Chromium down while
 * a viewer or holder is actively using it. Pair every call with
 * `releaseHolder(sessionId)` to release the lock.
 */
export function holdRuntime(sessionId: string): void {
  const r = runtimes.get(sessionId);
  if (!r) return;
  r.activeHolders += 1;
  if (r.idleTimer) {
    clearTimeout(r.idleTimer);
    r.idleTimer = null;
  }
}

export function releaseRuntime(sessionId: string): void {
  const r = runtimes.get(sessionId);
  if (!r) return;
  r.activeHolders = Math.max(0, r.activeHolders - 1);
  if (r.activeHolders === 0) resetIdleTimer(r);
}

/**
 * Tear down Chromium for a session. Called by the idle watchdog, by
 * `browser_close`, and by manual session close from the UI. Idempotent —
 * a session already gone is a no-op.
 */
export async function releasePage(
  sessionId: string,
  reason: "idle" | "shutdown" | "error" | "manual",
): Promise<void> {
  const r = runtimes.get(sessionId);
  if (!r) return;
  runtimes.delete(sessionId);
  if (r.idleTimer) clearTimeout(r.idleTimer);
  try {
    const pg = r.page as { close: () => Promise<void> } | null;
    if (pg) await pg.close();
  } catch {
    // ignore
  }
  try {
    const cx = r.context as { close: () => Promise<void> } | null;
    if (cx) await cx.close();
  } catch {
    // ignore
  }
  try {
    const br = r.browser as { close: () => Promise<void> } | null;
    if (br) await br.close();
  } catch {
    // ignore
  }
  await closeBrowserSession(sessionId, reason);
}

function resetIdleTimer(r: SessionRuntime): void {
  if (r.idleTimer) clearTimeout(r.idleTimer);
  if (r.activeHolders > 0) return;
  r.idleTimer = setTimeout(() => {
    void releasePage(r.id, "idle");
  }, IDLE_TIMEOUT_MS);
}

/** Mark this session as recently active, deferring the idle teardown. */
export function markActivity(sessionId: string): void {
  const r = runtimes.get(sessionId);
  if (!r) return;
  resetIdleTimer(r);
}
