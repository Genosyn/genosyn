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

// Pretend to be desktop Google Chrome on macOS so the sites we drive (login
// pages, captcha gates, etc.) don't bounce us as "headless Chromium". We
// can't ship the real Chrome binary — playwright's bundled Chromium is
// glibc-only and the Alpine image only has `chromium` from apk — so we
// fake the identity at every layer Chromium exposes:
//
//   * UA string → no "HeadlessChrome" token, no "Genosyn/" token, claims
//     "Chrome" with a realistic version.
//   * Sec-CH-UA / Sec-CH-UA-Platform request headers → "Google Chrome",
//     not "Chromium".
//   * `navigator.webdriver` → undefined (the `--disable-blink-features=
//     AutomationControlled` flag handles most of this; the init script is
//     belt-and-braces in case Chromium re-adds it).
//   * `navigator.userAgentData.brands` → contains "Google Chrome", which
//     is the Client-Hints equivalent of the UA spoof above.
//
// CHROME_MAJOR is the only piece that needs touching when we want to look
// like a newer Chrome — the rest is derived from it. Bump it when sites
// start sniffing for a newer baseline.
const CHROME_MAJOR = 134;
const CHROME_FULL_VERSION = `${CHROME_MAJOR}.0.6998.166`;
const CHROME_USER_AGENT = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_FULL_VERSION} Safari/537.36`;
const CHROME_SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}", "Not.A/Brand";v="24"`;

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
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      // Strips the `navigator.webdriver = true` tell that headless
      // Chromium injects, plus a handful of related automation hints
      // sites use to bounce bots.
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await (browser as {
    newContext: (opts: unknown) => Promise<unknown>;
  }).newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    userAgent: CHROME_USER_AGENT,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    extraHTTPHeaders: {
      "sec-ch-ua": CHROME_SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
  });
  await (context as {
    addInitScript: (script: { content: string }) => Promise<void>;
  }).addInitScript({ content: chromeMaskInitScript() });
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

/**
 * Page-init script that finishes the Chrome masquerade started in
 * `acquirePage`. Runs in every page (including iframes) before any site
 * script executes, so by the time the page's own bot-detection runs the
 * automation tells are already gone.
 */
function chromeMaskInitScript(): string {
  const brandsJson = JSON.stringify([
    { brand: "Chromium", version: String(CHROME_MAJOR) },
    { brand: "Google Chrome", version: String(CHROME_MAJOR) },
    { brand: "Not.A/Brand", version: "24" },
  ]);
  return `
    (() => {
      try {
        // navigator.webdriver — the canonical "is this a bot" check.
        // The launch flag covers most of it, but some Chromium builds
        // re-add the property; force-define it to undefined.
        Object.defineProperty(Navigator.prototype, 'webdriver', {
          configurable: true,
          enumerable: true,
          get: () => undefined,
        });
      } catch {}

      try {
        // navigator.userAgentData — Client Hints brands. Default
        // Chromium reports only "Chromium" and "Not.A/Brand"; real
        // Chrome adds a "Google Chrome" entry. Sites that key off this
        // (rather than the UA string) can tell us apart otherwise.
        const brands = ${brandsJson};
        const uaData = {
          brands,
          mobile: false,
          platform: 'macOS',
          getHighEntropyValues: (hints) => Promise.resolve({
            architecture: 'x86',
            bitness: '64',
            brands,
            fullVersionList: brands.map(b => ({ brand: b.brand, version: '${CHROME_FULL_VERSION}' })),
            mobile: false,
            model: '',
            platform: 'macOS',
            platformVersion: '10.15.7',
            uaFullVersion: '${CHROME_FULL_VERSION}',
            wow64: false,
          }),
          toJSON: () => ({ brands, mobile: false, platform: 'macOS' }),
        };
        Object.defineProperty(Navigator.prototype, 'userAgentData', {
          configurable: true,
          enumerable: true,
          get: () => uaData,
        });
      } catch {}

      try {
        // navigator.plugins / navigator.mimeTypes — headless Chromium
        // returns empty arrays; real desktop Chrome ships with a small
        // non-zero set. A length of 0 is a common bot heuristic.
        const fakePlugins = [
          { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        ];
        Object.defineProperty(Navigator.prototype, 'plugins', {
          configurable: true,
          get: () => fakePlugins,
        });
      } catch {}

      try {
        // navigator.languages — headless Chromium sometimes returns an
        // empty array if the locale isn't wired through. Pin to en-US
        // so it matches the Accept-Language header from the context.
        Object.defineProperty(Navigator.prototype, 'languages', {
          configurable: true,
          get: () => ['en-US', 'en'],
        });
      } catch {}

      try {
        // window.chrome — the runtime object real Chrome exposes that
        // bare Chromium does not. Sites probe \`window.chrome.runtime\`
        // as a "is this Google Chrome" gate; an empty stub is enough
        // to pass that probe without emulating the full surface.
        if (!window.chrome) {
          Object.defineProperty(window, 'chrome', {
            configurable: true,
            enumerable: true,
            writable: true,
            value: { runtime: {}, app: {}, csi: () => {}, loadTimes: () => {} },
          });
        }
      } catch {}

      try {
        // Notifications permission — headless Chromium always reports
        // 'denied'; real Chrome reports 'default' until the user grants
        // it. Some bot detectors compare \`Notification.permission\`
        // against the result of \`navigator.permissions.query\` and
        // flag the inconsistent headless pairing.
        const origQuery = navigator.permissions && navigator.permissions.query;
        if (origQuery) {
          navigator.permissions.query = (params) => (
            params && params.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission === 'denied' ? 'prompt' : Notification.permission })
              : origQuery.call(navigator.permissions, params)
          );
        }
      } catch {}
    })();
  `;
}
