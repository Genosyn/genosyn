import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { closeBrowserSession } from "./browserSessions.js";
import { markAiBrowserSessionRequestHeaders } from "./browserRequestBoundary.js";
import { loadStorageState, saveStorageState } from "./browserStorage.js";

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
/**
 * Member browsers get a longer leash. Tearing one down frees nothing on the
 * App side — Chromium is running on someone else's laptop — while it does cost
 * the human their page state and the model a reconnect. The watchdog is only
 * here so a forgotten session eventually lets go of the single-driver lease.
 */
const REMOTE_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
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
  /** Cached so the teardown path can persist storageState without a re-lookup. */
  companyId: string;
  employeeId: string;
  browser: unknown; // Playwright Browser
  context: unknown; // Playwright BrowserContext
  page: unknown; // Playwright Page
  cdp: unknown; // Playwright CDPSession
  idleTimer: NodeJS.Timeout | null;
  /** Counted by `markActivity`. When > 0 the idle watchdog is suspended. */
  activeHolders: number;
  /**
   * One-shot notices surfaced to the model at the top of the next snapshot
   * ("a dialog was dismissed", "a new tab opened", …). Drained by
   * `takeSessionNotices`.
   */
  notices: string[];
  /** True while acquirePage itself opens a page, so the context-level
   *  `page` listener doesn't mistake it for a popup to adopt. */
  selfCreating: boolean;
  /**
   * In-flight popup adoption, if any. An action that opens a new tab needs
   * to wait for the adoption to finish before it snapshots, or it would
   * return the old page and hand the model stale refs — see `awaitAdoption`.
   */
  pendingAdoption: Promise<void> | null;
  /** Trailing-debounce timer for the nav mirror (DB write + viewer fanout). */
  navTimer: NodeJS.Timeout | null;
  /** Last URL/title actually mirrored, to skip redundant writes. */
  lastNavUrl: string;
  lastNavTitle: string;
  /**
   * The {@link MemberBrowser} this runtime drives, when it is not the
   * container's own Chromium. Everything that differs — no storage state, no
   * masquerade, opener-scoped tab adoption, a disconnect instead of a
   * teardown — keys off this being non-null.
   */
  memberBrowserId: string | null;
  /**
   * Pages this runtime opened itself. On a CDP-attached browser Playwright
   * auto-attaches to every target, so "is this page ours?" cannot be inferred
   * from the context — it has to be remembered.
   */
  ownedPages: WeakSet<object>;
};

const runtimes = new Map<string, SessionRuntime>();
type PlaywrightChromium = {
  launch: (opts: unknown) => Promise<unknown>;
  connectOverCDP: (endpointURL: string, opts?: unknown) => Promise<unknown>;
};
let playwrightModule: { chromium: PlaywrightChromium } | null = null;

async function getPlaywright(): Promise<
  typeof playwrightModule extends infer T ? NonNullable<T> : never
> {
  if (!playwrightModule) {
    try {
      const mod = await import("playwright-core");
      playwrightModule = {
        chromium: mod.chromium as unknown as PlaywrightChromium,
      };
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

/** True when this session drives a Member's own machine, not the container. */
export function runtimeIsRemote(sessionId: string): boolean {
  return Boolean(runtimes.get(sessionId)?.memberBrowserId);
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
    existing.selfCreating = true;
    try {
      existing.page = await ctx.newPage();
    } finally {
      existing.selfCreating = false;
    }
    existing.ownedPages.add(existing.page as object);
    const oldCdp = existing.cdp;
    existing.cdp = await attachCdp(existing.page);
    wirePage(existing, existing.page);
    // The old page's screencast (if a viewer was watching) died with it;
    // restart the cast on the new CDP session so the live view doesn't
    // freeze for the rest of the session.
    await detachAndRewireCast(existing.id, oldCdp);
    return existing.page;
  }

  // Look up the session row so we know which employee to load state for.
  // Storage persistence is keyed by employee — every session for the same
  // employee shares cookies / localStorage so logging into X.com once
  // sticks across conversations and container restarts.
  const sessionRow = await AppDataSource.getRepository(BrowserSession).findOneBy({ id: sessionId });
  if (!sessionRow) {
    throw new Error(`browser session ${sessionId} not found in DB`);
  }
  if (sessionRow.memberBrowserId) {
    return acquireRemotePage(sessionRow);
  }
  const storageState = await loadStorageState(sessionRow.companyId, sessionRow.employeeId);

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
  const context = await (
    browser as {
      newContext: (opts: unknown) => Promise<unknown>;
    }
  ).newContext({
    viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    userAgent: CHROME_USER_AGENT,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    // Context routing is the security boundary that marks a Member session
    // used inside App-owned Chromium. Service workers can bypass Playwright
    // routes, so they are disabled in this governed Browser context.
    serviceWorkers: "block",
    extraHTTPHeaders: {
      "sec-ch-ua": CHROME_SEC_CH_UA,
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"macOS"',
    },
    storageState,
  });
  await (
    context as {
      route: (
        url: string,
        handler: (route: {
          request: () => { allHeaders: () => Promise<Record<string, string>> };
          continue: (options: { headers: Record<string, string> }) => Promise<void>;
        }) => Promise<void>,
      ) => Promise<void>;
    }
  ).route("**/*", async (route) => {
    const headers = await route.request().allHeaders();
    await route.continue({ headers: markAiBrowserSessionRequestHeaders(headers) });
  });
  await (
    context as {
      addInitScript: (script: { content: string }) => Promise<void>;
    }
  ).addInitScript({ content: chromeMaskInitScript() });
  const page = await (context as { newPage: () => Promise<unknown> }).newPage();
  const cdp = await attachCdp(page);

  const runtime: SessionRuntime = {
    id: sessionId,
    companyId: sessionRow.companyId,
    employeeId: sessionRow.employeeId,
    browser,
    context,
    page,
    cdp,
    idleTimer: null,
    activeHolders: 0,
    notices: [],
    selfCreating: false,
    pendingAdoption: null,
    navTimer: null,
    lastNavUrl: "",
    lastNavTitle: "",
    memberBrowserId: null,
    ownedPages: new WeakSet<object>(),
  };
  runtime.ownedPages.add(page as object);
  runtimes.set(sessionId, runtime);
  resetIdleTimer(runtime);
  wirePage(runtime, page);

  // Adopt popups: a click on a target=_blank link opens a page the agent's
  // tools would otherwise never see — it would keep driving the old tab
  // forever. Follow the newest page instead, like a human would. The action
  // that triggered the popup waits on `pendingAdoption` before snapshotting.
  (context as { on: (ev: string, cb: (p: unknown) => void) => void }).on("page", (newPage) => {
    const r = runtimes.get(sessionId);
    if (!r) return;
    const prev = r.pendingAdoption ?? Promise.resolve();
    r.pendingAdoption = prev
      .then(() => adoptPage(sessionId, newPage))
      .catch(() => {
        // best-effort — worst case the agent stays on the old tab
      })
      .finally(() => {
        const cur = runtimes.get(sessionId);
        if (cur && cur.pendingAdoption === r.pendingAdoption) cur.pendingAdoption = null;
      });
  });

  return page;
}

/**
 * Attach to the Chrome running on a Member's own computer, through the bridge
 * relay, and open one tab in it.
 *
 * Almost everything the local path does is wrong here, and each omission is
 * load-bearing rather than stylistic:
 *
 *  * **No `newContext`.** `connectOverCDP` hands back a *persistent* context
 *    whose options Playwright fixes at `{noDefaultViewport: true}`. Viewport,
 *    UA, locale, `serviceWorkers: "block"` and `storageState` are all
 *    unreachable — not ignored by us, unavailable. The service-worker block in
 *    particular is gone, so a response served from a worker's Cache API never
 *    passes through the request marker below.
 *  * **No storage state, in either direction.** `context.storageState()` works
 *    fine on a remote context, which is exactly the danger: it would copy the
 *    human's cookie jar into the App's data directory. Their sessions stay on
 *    their machine.
 *  * **No masquerade init script.** It is real Google Chrome, so there is
 *    nothing to fake — and `addInitScript` is context-wide, so it would
 *    redefine `navigator` internals in every tab of that browser.
 *  * **Real viewport, not ours.** The window is whatever size the human's
 *    screen made it. We read that and tell the session, rather than forcing
 *    1280×800 with `setViewportSize` — which desyncs the page from the window
 *    and makes `page.screenshot()` hang whenever the tab is in the background.
 */
async function acquireRemotePage(sessionRow: BrowserSession): Promise<unknown> {
  const sessionId = sessionRow.id;
  const memberBrowserId = sessionRow.memberBrowserId!;
  const { acquireMemberBrowserLease, isMemberBrowserOnline } = await import(
    "./memberBrowserHub.js"
  );
  const { mintCdpEndpoint } = await import("./memberBrowserRelay.js");
  const { describeMemberBrowserUnavailable } = await import("./memberBrowserErrors.js");

  if (!isMemberBrowserOnline(memberBrowserId)) {
    throw new Error(await describeMemberBrowserUnavailable(memberBrowserId, "offline"));
  }
  const lease = acquireMemberBrowserLease(memberBrowserId, sessionId);
  if (!lease.ok) {
    throw new Error(await describeMemberBrowserUnavailable(memberBrowserId, lease.reason));
  }

  const endpoint = await mintCdpEndpoint({ browserId: memberBrowserId, sessionId });
  const pw = await getPlaywright();
  const browser = await pw.chromium.connectOverCDP(endpoint);
  const contexts = (browser as { contexts: () => unknown[] }).contexts();
  const context = contexts[0];
  if (!context) {
    await (browser as { close: () => Promise<void> }).close().catch(() => {});
    throw new Error(await describeMemberBrowserUnavailable(memberBrowserId, "no-context"));
  }

  // Same marker as the local path, and it does reach the wire over CDP. Here
  // it only covers the Genosyn-profile browser the agent launched, which is
  // the entire point of the agent owning that browser instead of attaching to
  // the human's everyday one.
  await (
    context as {
      route: (
        url: string,
        handler: (route: {
          request: () => { allHeaders: () => Promise<Record<string, string>> };
          continue: (options: { headers: Record<string, string> }) => Promise<void>;
        }) => Promise<void>,
      ) => Promise<void>;
    }
  ).route("**/*", async (route) => {
    const headers = await route.request().allHeaders();
    await route.continue({ headers: markAiBrowserSessionRequestHeaders(headers) });
  });

  const page = await (context as { newPage: () => Promise<unknown> }).newPage();
  const cdp = await attachCdp(page);

  const runtime: SessionRuntime = {
    id: sessionId,
    companyId: sessionRow.companyId,
    employeeId: sessionRow.employeeId,
    browser,
    context,
    page,
    cdp,
    idleTimer: null,
    activeHolders: 0,
    notices: [],
    selfCreating: false,
    pendingAdoption: null,
    navTimer: null,
    lastNavUrl: "",
    lastNavTitle: "",
    memberBrowserId,
    ownedPages: new WeakSet<object>(),
  };
  runtime.ownedPages.add(page as object);
  runtimes.set(sessionId, runtime);
  resetIdleTimer(runtime);
  wirePage(runtime, page);

  // Only follow tabs *we* opened. On a CDP-attached browser Playwright
  // auto-attaches to every target, so without the opener check a tab the human
  // opened in that window would become the page the model snapshots, screenshots
  // and streams to the live viewer.
  (context as { on: (ev: string, cb: (p: unknown) => void) => void }).on("page", (newPage) => {
    const r = runtimes.get(sessionId);
    if (!r) return;
    const prev = r.pendingAdoption ?? Promise.resolve();
    r.pendingAdoption = prev
      .then(async () => {
        const opener = await (newPage as { opener: () => Promise<unknown> })
          .opener()
          .catch(() => null);
        if (!opener || !r.ownedPages.has(opener as object)) return;
        r.ownedPages.add(newPage as object);
        await adoptPage(sessionId, newPage);
      })
      .catch(() => {
        // best-effort — worst case the agent stays on the old tab
      })
      .finally(() => {
        const cur = runtimes.get(sessionId);
        if (cur && cur.pendingAdoption === r.pendingAdoption) cur.pendingAdoption = null;
      });
  });

  await syncRemoteViewport(runtime).catch(() => {
    // The session keeps the default size; the viewer self-corrects from the
    // first screencast frame's metadata.
  });

  return page;
}

/**
 * Read the real window size out of the remote browser and tell the session
 * about it, so the screencast is captured at native resolution and the
 * viewer's take-over clicks land where the human aimed them.
 */
async function syncRemoteViewport(runtime: SessionRuntime): Promise<void> {
  const cdp = runtime.cdp as { send: (m: string, p?: unknown) => Promise<unknown> } | null;
  if (!cdp) return;
  const metrics = (await cdp.send("Page.getLayoutMetrics")) as {
    cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
    layoutViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
  const width = Math.round(viewport?.clientWidth ?? 0);
  const height = Math.round(viewport?.clientHeight ?? 0);
  if (width < 320 || height < 240) return;
  const { setSessionViewport } = await import("./browserSessions.js");
  await setSessionViewport(runtime.id, width, height);
}

/**
 * Await any in-flight popup adoption for this session so the caller
 * snapshots the tab the model will actually act on next. Bounded — a popup
 * that never finishes loading must not hang the tool call.
 */
export async function awaitAdoption(sessionId: string, capMs: number): Promise<void> {
  const r = runtimes.get(sessionId);
  if (!r || !r.pendingAdoption) return;
  let timer: NodeJS.Timeout | null = null;
  const cap = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, capMs);
  });
  try {
    await Promise.race([r.pendingAdoption, cap]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pages already wired with nav/dialog listeners — guards double-wiring. */
const wiredPages = new WeakSet<object>();

/**
 * Attach the per-page listeners: the nav mirror (BrowserSession row +
 * viewer fanout) and the dialog handler. Registering a dialog listener
 * switches Playwright from silent auto-dismiss to our control, letting us
 * tell the model a dialog appeared — otherwise a confirm() silently
 * cancels and the model never learns why nothing happened.
 */
function wirePage(runtime: SessionRuntime, page: unknown): void {
  if (wiredPages.has(page as object)) return;
  wiredPages.add(page as object);
  const p = page as { on: (ev: string, cb: (arg: unknown) => void) => void };
  p.on("framenavigated", (frame) => {
    const f = frame as { parentFrame: () => unknown };
    if (f.parentFrame()) return;
    // Only mirror while this page is still the active one — a background
    // tab's redirects shouldn't clobber the viewer's URL bar.
    if (runtime.page !== page) return;
    scheduleNavMirror(runtime);
  });
  p.on("dialog", (dialog) => {
    const d = dialog as {
      type: () => string;
      message: () => string;
      accept: () => Promise<void>;
      dismiss: () => Promise<void>;
    };
    const kind = d.type();
    // beforeunload must be accepted or navigation deadlocks; everything
    // else is dismissed (the safe default for confirm/prompt) with the
    // message surfaced so the model knows what it missed.
    const verdict = kind === "beforeunload" ? "accepted" : "dismissed";
    pushSessionNotice(
      runtime.id,
      `A JavaScript ${kind} dialog appeared${
        d.message() ? ` — "${d.message().slice(0, 300)}"` : ""
      } — and was auto-${verdict}.`,
    );
    void (kind === "beforeunload" ? d.accept() : d.dismiss()).catch(() => {
      // dialog may already be gone
    });
  });
}

/**
 * Make a newly opened popup/tab the active page: repoint the runtime, move
 * the CDP session (so the live viewer follows), and tell the model via a
 * snapshot notice. Skips pages acquirePage opened itself.
 */
async function adoptPage(sessionId: string, newPage: unknown): Promise<void> {
  const r = runtimes.get(sessionId);
  if (!r || r.selfCreating || r.page === newPage) return;
  const np = newPage as {
    isClosed: () => boolean;
    url: () => string;
    waitForLoadState: (state: string, opts: unknown) => Promise<void>;
  };
  try {
    await np.waitForLoadState("domcontentloaded", { timeout: 5_000 });
  } catch {
    // adopt anyway — the URL is still useful
  }
  if (!runtimes.has(sessionId) || np.isClosed()) return;
  const previousUrl = (r.page as { url?: () => string } | null)?.url?.() ?? "";
  const oldCdp = r.cdp;
  r.page = newPage;
  try {
    r.cdp = await attachCdp(newPage);
  } catch {
    r.cdp = null;
  }
  wirePage(r, newPage);
  pushSessionNotice(
    sessionId,
    `A new tab opened and is now the active page: ${np.url()}. ` +
      (previousUrl ? `To return to the previous page, call browser_open with ${previousUrl}.` : ""),
  );
  scheduleNavMirror(r);
  // Stop the dead page's screencast and move the live view to the new tab.
  await detachAndRewireCast(sessionId, oldCdp);
}

/**
 * A page swap (popup adoption or a self-closed page being reopened) leaves
 * the previous CDP session — and any screencast on it — orphaned. Stop that
 * cast, detach the old session, and restart the cast on the new one so the
 * live viewer follows the swap instead of freezing or replaying dead frames.
 */
async function detachAndRewireCast(sessionId: string, oldCdp: unknown): Promise<void> {
  const cdp = oldCdp as {
    send: (m: string, p?: unknown) => Promise<unknown>;
    detach?: () => Promise<void>;
  } | null;
  if (cdp) {
    try {
      await cdp.send("Page.stopScreencast");
    } catch {
      // session may already be gone
    }
    try {
      await cdp.detach?.();
    } catch {
      // best-effort
    }
  }
  const { notifyPageSwapped } = await import("./browserSessions.js");
  await notifyPageSwapped(sessionId);
}

async function attachCdp(page: unknown): Promise<unknown> {
  const ctx = (
    page as { context: () => { newCDPSession: (p: unknown) => Promise<unknown> } }
  ).context();
  return ctx.newCDPSession(page);
}

/**
 * Trailing-debounce the nav mirror so a redirect chain collapses into one
 * DB write + one viewer broadcast instead of one per hop.
 */
function scheduleNavMirror(r: SessionRuntime): void {
  if (r.navTimer) clearTimeout(r.navTimer);
  r.navTimer = setTimeout(() => {
    r.navTimer = null;
    void mirrorNav(r).catch(() => {
      // best-effort
    });
  }, 300);
}

async function mirrorNav(r: SessionRuntime): Promise<void> {
  // The runtime may have been torn down while the debounce was pending —
  // a stale write here would resurrect hub state for a closed session.
  if (runtimes.get(r.id) !== r) return;
  const p = r.page as { url: () => string; title: () => Promise<string>; isClosed: () => boolean };
  if (p.isClosed()) return;
  const url = p.url();
  let title = "";
  try {
    title = await p.title();
  } catch {
    // best-effort
  }
  if (url === r.lastNavUrl && title === r.lastNavTitle) return;
  r.lastNavUrl = url;
  r.lastNavTitle = title;
  // On a Member's own machine the mirror keeps the origin only. The full URL
  // is written to the App database and broadcast to every attached viewer, and
  // on plenty of sites the path carries a token or a document the human would
  // not expect to leave their laptop.
  const mirroredUrl = r.memberBrowserId ? originOnly(url) : url;
  await AppDataSource.getRepository(BrowserSession).update(
    { id: r.id },
    { pageUrl: mirroredUrl, pageTitle: title || null },
  );
  // The fanout hub picks up nav events via the screencast loop's snapshot,
  // but pushing one explicitly keeps the viewer URL-bar in sync between
  // frames.
  const { broadcastNav } = await import("./browserSessions.js");
  broadcastNav(r.id, mirroredUrl, title || null);
}

function originOnly(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * Queue a one-shot notice for the model — surfaced at the top of the next
 * snapshot, then dropped. Used for events the model can't otherwise see:
 * auto-handled dialogs, adopted popups, ambiguous selectors.
 */
export function pushSessionNotice(sessionId: string, notice: string): void {
  const r = runtimes.get(sessionId);
  if (!r) return;
  // Cap so a dialog loop can't grow the array (and the snapshot) unboundedly.
  if (r.notices.length >= 10) r.notices.shift();
  r.notices.push(notice);
}

/** Drain the pending notices for a session (oldest first). */
export function takeSessionNotices(sessionId: string): string[] {
  const r = runtimes.get(sessionId);
  if (!r || r.notices.length === 0) return [];
  const out = r.notices;
  r.notices = [];
  return out;
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
  if (r.navTimer) clearTimeout(r.navTimer);
  // Snapshot cookies + localStorage before the context is torn down so the
  // next session for this employee picks up where we left off. Skip on
  // `error` — a context that crashed mid-flight may have a corrupted
  // storage state we don't want to overwrite the last good snapshot with.
  //
  // Never for a member browser. `context.storageState()` succeeds there, which
  // is precisely why the guard is a branch and not a comment: it would write
  // the human's own cookie jar into the App's data directory.
  if (reason !== "error" && !r.memberBrowserId) {
    await saveStorageState(r.companyId, r.employeeId, r.context);
  }
  try {
    const pg = r.page as { close: () => Promise<void> } | null;
    if (pg) await pg.close();
  } catch {
    // ignore
  }
  if (!r.memberBrowserId) {
    // Only for a context we created. On a CDP-attached persistent context
    // `context.close()` has no browserContextId to close, so Playwright closes
    // the whole transport instead — which would sever any other session
    // attached to the same machine.
    try {
      const cx = r.context as { close: () => Promise<void> } | null;
      if (cx) await cx.close();
    } catch {
      // ignore
    }
  }
  try {
    // For a member browser this closes our CDP socket and nothing else: the
    // human's Chrome keeps running, because Playwright's teardown for a
    // connected browser is `transport.closeAndWait()`.
    const br = r.browser as { close: () => Promise<void> } | null;
    if (br) await br.close();
  } catch {
    // ignore
  }
  if (r.memberBrowserId) {
    const { releaseMemberBrowserLease } = await import("./memberBrowserHub.js");
    releaseMemberBrowserLease(r.memberBrowserId, sessionId);
  }
  await closeBrowserSession(sessionId, reason);
}

function resetIdleTimer(r: SessionRuntime): void {
  if (r.idleTimer) clearTimeout(r.idleTimer);
  if (r.activeHolders > 0) return;
  r.idleTimer = setTimeout(
    () => {
      void releasePage(r.id, "idle");
    },
    r.memberBrowserId ? REMOTE_IDLE_TIMEOUT_MS : IDLE_TIMEOUT_MS,
  );
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
