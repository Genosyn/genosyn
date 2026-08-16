import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { closeBrowserSession } from "./browserSessions.js";
import { markAiBrowserSessionRequestHeaders } from "./browserRequestBoundary.js";
import { loadStorageState, saveStorageState } from "./browserStorage.js";
import {
  chromeContextOptions,
  chromeMaskInitScript,
  chromiumLaunchOptions,
  loadChromiumLauncher,
} from "./browserProfile.js";

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

// The "look like desktop Chrome" profile lives in `browserProfile.ts` and is
// shared with the browser-login Integration drivers, which face the same
// login pages and need the same disguise.

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
};

const runtimes = new Map<string, SessionRuntime>();

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
  const storageState = await loadStorageState(sessionRow.companyId, sessionRow.employeeId);

  const chromium = await loadChromiumLauncher(
    "Browser tools require the App container to bundle Chromium and playwright-core.",
  );
  const browser = await chromium.launch(chromiumLaunchOptions());
  const context = await (
    browser as {
      newContext: (opts: unknown) => Promise<unknown>;
    }
  ).newContext({
    ...chromeContextOptions(),
    // Context routing is the security boundary that marks a Member session
    // used inside App-owned Chromium. Service workers can bypass Playwright
    // routes, so they are disabled in this governed Browser context.
    serviceWorkers: "block",
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
  };
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
  await AppDataSource.getRepository(BrowserSession).update(
    { id: r.id },
    { pageUrl: url, pageTitle: title || null },
  );
  // The fanout hub picks up nav events via the screencast loop's snapshot,
  // but pushing one explicitly keeps the viewer URL-bar in sync between
  // frames.
  const { broadcastNav } = await import("./browserSessions.js");
  broadcastNav(r.id, url, title || null);
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
  if (reason !== "error") {
    await saveStorageState(r.companyId, r.employeeId, r.context);
  }
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

