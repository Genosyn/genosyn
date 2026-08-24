import { AppDataSource } from "../db/datasource.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { closeBrowserSession } from "./browserSessions.js";
import { markAiBrowserSessionRequestHeaders } from "./browserRequestBoundary.js";
import {
  browserProfileIsNew,
  ensureBrowserProfileDir,
  loadStorageState,
  saveStorageState,
} from "./browserStorage.js";
import {
  BROWSER_WINDOW_HEIGHT,
  BROWSER_WINDOW_WIDTH,
  chromeContextOptions,
  chromeMaskInitScript,
  chromiumLaunchOptions,
  loadChromiumLauncher,
  persistentContextOptions,
} from "./browserProfile.js";
import { installVaultPasskeyGate } from "./vaultBrowserAuthenticators.js";

/**
 * App-owned browser per `BrowserSession`. Decoupled from the MCP
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

export type BrowserNavigationMetadata = {
  url: string;
  title: string | null;
};

type BrowserNavigationMetadataSanitizer = (
  sessionId: string,
  metadata: BrowserNavigationMetadata,
) => BrowserNavigationMetadata | Promise<BrowserNavigationMetadata>;

let navigationMetadataSanitizer: BrowserNavigationMetadataSanitizer | null = null;

/**
 * Install the credential-aware boundary that runs before navigation metadata
 * is persisted or broadcast. Kept here as a narrow callback so the browser
 * lifecycle service does not need to know how Vault ciphertext is classified.
 */
export function registerBrowserNavigationMetadataSanitizer(
  sanitizer: BrowserNavigationMetadataSanitizer,
): () => void {
  navigationMetadataSanitizer = sanitizer;
  return () => {
    if (navigationMetadataSanitizer === sanitizer) navigationMetadataSanitizer = null;
  };
}

/**
 * How long after a navigation settles before we snapshot cookies to disk.
 *
 * `releasePage` is the authoritative save, but it only runs on a teardown we
 * chose — idle, manual, shutdown. A `SIGKILL`, an OOM kill, or a host power cut
 * reaches none of those, and everything the session had learned since it
 * started would be lost back to the previous snapshot. This bounds that loss to
 * "since the last page load", which for a sign-in flow is the difference
 * between keeping the login and re-doing it.
 */
const PERSIST_DEBOUNCE_MS = 20_000;

/**
 * How long an employee's Chrome stays up after its last session lets go.
 *
 * Closing the moment the last tab goes would make a Chrome shutdown+relaunch
 * the *normal* path rather than an edge: the model's `/close` at the end of a
 * turn is immediately followed by the next turn's first tool call, so every
 * turn boundary of every chat would cycle the browser — and every cycle is
 * another chance to race the profile lock. Deliberately well under
 * `IDLE_TIMEOUT_MS`, so an idle employee still frees the ~150 MB promptly.
 */
let profileLingerMs = 45 * 1000;

/**
 * Shorten the linger for tests. A suite that had to wait out the real 45s to
 * observe a teardown would either be slow or would fake timers around code that
 * is full of awaits; this is the smaller seam. Pass `null` to restore.
 */
export function setProfileLingerForTests(ms: number | null): void {
  profileLingerMs = ms ?? 45 * 1000;
}

/** Live profiles, for assertions. Zero means every employee Chrome is closed. */
export function liveProfileCountForTests(): number {
  return profiles.size;
}

/** How long to wait for a window we asked Chrome to open to surface. */
const WINDOW_OPEN_TIMEOUT_MS = 15 * 1000;

/**
 * One Chrome per employee, shared by every session that employee has open.
 *
 * This exists because a Chrome `user-data-dir` is **single-writer**. Two
 * processes against one profile either fail to start, hand off through
 * ProcessSingleton, or — the bad case — both write the Cookies SQLite and
 * corrupt it. So persistence and sharing are not two features: sharing is what
 * makes persistence safe. It also removes a bug the ephemeral path had, where
 * two concurrent sessions for one employee each snapshotted their own cookie
 * jar and the last writer silently discarded the other's fresh logins.
 *
 * Each session still gets its **own OS window** inside this context (see
 * {@link openSessionWindow}), not a tab. That is not cosmetic: Chrome only
 * emits `Page.screencastFrame` for a page it is actually compositing, so
 * sessions sharing one window would leave every live viewer but one showing a
 * frozen picture while still reporting healthy.
 */
type SharedProfile = {
  key: string;
  companyId: string;
  employeeId: string;
  userDataDir: string;
  /** The persistent BrowserContext. Owned here, never by a session. */
  context: unknown;
  /** Browser-level CDP session, used to open a window per session. */
  browserCdp: unknown;
  /** Sessions currently holding this profile. Liveness is `size > 0`. */
  sessionIds: Set<string>;
  /** Trailing-debounce for the cookie export, at profile level not session. */
  persistTimer: NodeJS.Timeout | null;
  /** Set while no session holds the profile but we have not closed it yet. */
  lingerTimer: NodeJS.Timeout | null;
  /** Non-null once teardown has begun; awaited by a racing re-acquire. */
  closing: Promise<void> | null;
  /**
   * Resolver for the window we are currently asking Chrome to open. The
   * context-level `page` listener hands the new page here rather than treating
   * an openerless page as a popup to adopt.
   */
  pendingWindow: ((page: unknown) => void) | null;
  /**
   * Windows that existed before any session asked for one — the window Chrome
   * always opens at launch, plus anything a previous run left in the profile's
   * session-restore. Handed out before opening new ones, so an employee's
   * browser does not accumulate a stray blank window per launch.
   */
  unclaimedPages: unknown[];
  /** Serialises window creation so `pendingWindow` is never ambiguous. */
  windowChain: Promise<unknown>;
  /**
   * True when we could not use a real profile (a Playwright build without
   * `launchPersistentContext`, or a profile dir we could not open) and fell
   * back to the old ephemeral Browser + Context. Everything else behaves the
   * same; the employee just does not accumulate history.
   */
  ephemeral: boolean;
  /** Only set on the ephemeral fallback, which owns a Browser to close. */
  browser: unknown | null;
};

const profiles = new Map<string, SharedProfile>();
/** In-flight launches, so concurrent acquirers share one Chrome. */
const profileLaunches = new Map<string, Promise<SharedProfile>>();

function profileKeyFor(companyId: string, employeeId: string): string {
  return `${companyId}:${employeeId}`;
}

// Which binary to launch, and how, lives in `browserProfile.ts` — shared with
// `browserFingerprint.ts`, which checks the same profile for
// self-contradictions. The image ships real Google Chrome running headed
// against a virtual display, so on the standard deployment there is no
// disguise involved at all.

type SessionRuntime = {
  id: string;
  /** Cached so the teardown path can persist storageState without a re-lookup. */
  companyId: string;
  employeeId: string;
  /**
   * The context this session's page lives in.
   *
   * For a local session this is the employee's **shared** persistent context,
   * owned by {@link SharedProfile} and never closed from here. For a member
   * browser it is the human's own context, reached over CDP.
   */
  context: unknown; // Playwright BrowserContext
  /**
   * Only set on the member-browser path: the CDP-connected Browser whose
   * socket we must close to let go of someone else's machine. Null for a local
   * session, whose Chrome is shared and outlives it.
   */
  remoteBrowser: unknown | null;
  /** Key into {@link profiles} for a local session; null for a member browser. */
  profileKey: string | null;
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
   * masquerade, a disconnect instead of a teardown — keys off this being
   * non-null. Tab adoption is opener-scoped on *both* paths now: the local
   * context is shared between an employee's sessions, so it faces the same
   * "whose tab is this?" question the member path always did.
   */
  memberBrowserId: string | null;
  /**
   * Pages this runtime opened itself.
   *
   * Ownership cannot be inferred from the context on either path: a CDP-attached
   * browser auto-attaches to every target, and a shared persistent context
   * carries every sibling session's windows. It has to be remembered.
   */
  ownedPages: WeakSet<object>;
};

const runtimes = new Map<string, SessionRuntime>();

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
    // Page was closed (e.g. agent called browser_close mid-turn). Reopen on
    // the same context so cookies / storage state survive — and on the local
    // path in a fresh *window*, not a tab, because a page Chrome is not
    // compositing produces no screencast frames.
    const profile = existing.profileKey ? profiles.get(existing.profileKey) : null;
    existing.page = profile
      ? await openSessionWindow(profile)
      : await (existing.context as { newPage: () => Promise<unknown> }).newPage();
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
  const profile = await acquireSharedProfile(sessionRow.companyId, sessionRow.employeeId);
  const page = await openSessionWindow(profile);
  const cdp = await attachCdp(page);

  const runtime: SessionRuntime = {
    id: sessionId,
    companyId: sessionRow.companyId,
    employeeId: sessionRow.employeeId,
    context: profile.context,
    remoteBrowser: null,
    profileKey: profile.key,
    page,
    cdp,
    idleTimer: null,
    activeHolders: 0,
    notices: [],
    pendingAdoption: null,
    navTimer: null,
    lastNavUrl: "",
    lastNavTitle: "",
    memberBrowserId: null,
    ownedPages: new WeakSet<object>(),
  };
  runtime.ownedPages.add(page as object);
  runtimes.set(sessionId, runtime);
  // Join the profile *after* the runtime is registered: the context-level page
  // listener resolves owners through `runtimes`, and a session that is a member
  // of the profile but absent from `runtimes` would be skipped.
  profile.sessionIds.add(sessionId);
  clearLinger(profile);
  resetIdleTimer(runtime);
  wirePage(runtime, page);

  // Headed Chrome paints into a real window, so the page is shorter than the
  // window by however much browser chrome the build draws. Ask the page rather
  // than assuming — with `viewport: null` there is no forced size to assume.
  await syncViewportFromBrowser(runtime).catch(() => {
    // The session keeps the default size; the viewer self-corrects from the
    // first screencast frame's metadata.
  });

  return page;
}

/**
 * Get the employee's Chrome, launching it if this is the first session.
 *
 * The loop exists because two things can be in flight when a caller arrives: a
 * launch (share it) or a teardown (wait for it, then launch fresh). Both are
 * the common case rather than the exotic one — `createBrowserSession` only
 * reuses a row for a matching conversation, so a Routine Run always mints a new
 * session and routinely cold-starts alongside a chat.
 */
async function acquireSharedProfile(companyId: string, employeeId: string): Promise<SharedProfile> {
  const key = profileKeyFor(companyId, employeeId);
  for (;;) {
    const existing = profiles.get(key);
    if (existing && !existing.closing) {
      clearLinger(existing);
      return existing;
    }
    if (existing?.closing) {
      // A teardown committed before we got here. Let it finish rather than
      // launching a second Chrome onto a profile the first is still unlocking.
      await existing.closing.catch(() => {});
      continue;
    }
    const inflight = profileLaunches.get(key);
    if (inflight) return inflight;
    // Registered in the same synchronous turn as the check above, so a racing
    // caller cannot slip between them and start a second launch.
    const launch = launchProfile(key, companyId, employeeId);
    profileLaunches.set(key, launch);
    void launch
      .catch(() => {})
      .finally(() => {
        if (profileLaunches.get(key) === launch) profileLaunches.delete(key);
      });
    return launch;
  }
}

/**
 * Start one Chrome for this employee against their on-disk profile.
 *
 * Falls back to the old ephemeral Browser + Context if a real profile is not
 * available — a Playwright build without `launchPersistentContext`, or a
 * profile directory we could not open. A degraded browser that works beats a
 * failed Run, and the only thing lost is the accumulated history.
 */
async function launchProfile(
  key: string,
  companyId: string,
  employeeId: string,
): Promise<SharedProfile> {
  const chromium = await loadChromiumLauncher(
    "Browser tools require the App container to bundle Chromium and playwright-core.",
  );

  let context: unknown;
  let browser: unknown = null;
  let ephemeral = false;
  let userDataDir = "";
  let seedSnapshot = false;

  if (chromium.launchPersistentContext) {
    try {
      userDataDir = await ensureBrowserProfileDir(companyId, employeeId);
      seedSnapshot = await browserProfileIsNew(companyId, employeeId);
      context = await chromium.launchPersistentContext(
        userDataDir,
        await persistentContextOptions(),
      );
    } catch (error) {
      // Disk permissions, a corrupt profile, a Chrome that refuses the dir.
      // Losing history is survivable; losing the browser tool is not.
      // eslint-disable-next-line no-console
      console.warn(
        `[browser] persistent profile unavailable for employee ${employeeId}, ` +
          `falling back to an ephemeral browser: ${(error as Error).message}`,
      );
      ephemeral = true;
      userDataDir = "";
      seedSnapshot = false;
    }
  } else {
    ephemeral = true;
  }

  if (ephemeral) {
    browser = await chromium.launch(await chromiumLaunchOptions());
    context = await (browser as { newContext: (opts: unknown) => Promise<unknown> }).newContext({
      ...(await chromeContextOptions()),
      serviceWorkers: "block",
      storageState: await loadStorageState(companyId, employeeId),
    });
  }

  const profile: SharedProfile = {
    key,
    companyId,
    employeeId,
    userDataDir,
    context: context!,
    browserCdp: null,
    sessionIds: new Set<string>(),
    persistTimer: null,
    lingerTimer: null,
    closing: null,
    pendingWindow: null,
    unclaimedPages: [],
    windowChain: Promise.resolve(),
    ephemeral,
    browser,
  };
  // Registered before any of the wiring below, so a throw part-way through
  // still leaves a closable handle. An orphaned persistent context would hold
  // the profile lock for the life of the process with nothing able to reach it.
  profiles.set(key, profile);

  try {
    await wireProfile(profile);
    if (seedSnapshot) await hydrateProfileFromSnapshot(profile);
  } catch (error) {
    profiles.delete(key);
    await closeProfileHandles(profile);
    throw error;
  }
  return profile;
}

/**
 * Install everything that belongs to the context rather than to a session: the
 * request marker, the compatibility mask, popup attribution, and crash
 * recovery. Exactly once per profile — these used to be registered per session,
 * which was harmless only while each session had a context to itself.
 */
async function wireProfile(profile: SharedProfile): Promise<void> {
  const context = profile.context as {
    route: (url: string, handler: (route: unknown) => Promise<void>) => Promise<void>;
    addInitScript: (script: { content: string }) => Promise<void>;
    on: (ev: string, cb: (arg: unknown) => void) => void;
    browser?: () => unknown;
    newCDPSession?: (page: unknown) => Promise<unknown>;
  };

  await context.route("**/*", async (route) => {
    const r = route as {
      request: () => { allHeaders: () => Promise<Record<string, string>> };
      continue: (options?: { headers: Record<string, string> }) => Promise<void>;
    };
    const headers = await r.request().allHeaders();
    const marked = markAiBrowserSessionRequestHeaders(headers);
    // Reference-identical when the marker is a no-op, which is every request
    // that is not headed back to Genosyn's own origin. Handing `continue()` no
    // options there lets Chrome compose and order its own headers.
    if (marked === headers) {
      await r.continue();
      return;
    }
    await r.continue({ headers: marked });
  });

  const maskScript = await chromeMaskInitScript();
  if (maskScript) await context.addInitScript({ content: maskScript });
  // This must run before any website document. It blocks ambient WebAuthn
  // requests and opens one bounded create/get only for the exact trusted
  // control selected by a Vault passkey action.
  await installVaultPasskeyGate(context);

  // A browser-level CDP session is how we open a *window* rather than a tab.
  if (!profile.ephemeral) {
    const browser = context.browser?.();
    const nb = browser as { newBrowserCDPSession?: () => Promise<unknown> } | null;
    if (nb?.newBrowserCDPSession) {
      profile.browserCdp = await nb.newBrowserCDPSession();
    }
  }

  // Whatever Chrome opened for itself is ours to hand out, not a popup and not
  // litter. Read it before the listener is installed so there is no window in
  // which a launch-time page could be mistaken for a claim.
  const existingPages = (profile.context as { pages?: () => unknown[] }).pages?.() ?? [];
  profile.unclaimedPages.push(...existingPages);

  // One listener for the whole profile. It answers two questions: "is this the
  // window we just asked for?" and, failing that, "which session's page opened
  // this popup?" A page with neither answer — a restored tab, an extension
  // page — is left alone rather than adopted by whoever happens to be first.
  context.on("page", (newPage) => {
    void attributeNewPage(profile, newPage);
  });

  // A Chrome crash, an OOM kill, or an operator closing the window takes every
  // session for this employee with it. Without this the record would still say
  // "alive" and every later acquire would be handed a dead context.
  context.on("close", () => {
    if (profiles.get(profile.key) === profile) profiles.delete(profile.key);
    if (profile.lingerTimer) clearTimeout(profile.lingerTimer);
    if (profile.persistTimer) clearTimeout(profile.persistTimer);
    for (const sessionId of [...profile.sessionIds]) {
      // "error" deliberately: it skips the cookie snapshot, and a context that
      // died under us is exactly the case where the snapshot cannot be trusted.
      void releasePage(sessionId, "error").catch(() => {});
    }
  });
}

/**
 * Decide what a newly appeared page is, and give it to whoever it belongs to.
 */
async function attributeNewPage(profile: SharedProfile, newPage: unknown): Promise<void> {
  const opener = await (newPage as { opener: () => Promise<unknown> }).opener().catch(() => null);

  if (!opener) {
    // No opener: either the window we just asked Chrome for, or a page nobody
    // asked for. Claiming is single-flight (see `openSessionWindow`), so there
    // is no ambiguity about which acquire this belongs to.
    const claim = profile.pendingWindow;
    if (claim) {
      profile.pendingWindow = null;
      claim(newPage);
    }
    return;
  }

  const owner = [...profile.sessionIds]
    .map((id) => runtimes.get(id))
    .find((r) => r && r.ownedPages.has(opener as object));
  if (!owner) return;

  owner.ownedPages.add(newPage as object);
  const prev = owner.pendingAdoption ?? Promise.resolve();
  const mine: Promise<void> = prev
    .then(() => adoptPage(owner.id, newPage))
    .catch(() => {
      // best-effort — worst case the agent stays on the old tab
    })
    .finally(() => {
      const cur = runtimes.get(owner.id);
      // Compare against this chain, not against `owner.pendingAdoption` as it
      // stands now — that was always true, so a second popup's adoption ran
      // with the field already nulled and `awaitAdoption` waited on nothing.
      if (cur && cur.pendingAdoption === mine) cur.pendingAdoption = null;
    });
  owner.pendingAdoption = mine;
  await mine;
}

/**
 * Open this session's own OS window inside the shared profile.
 *
 * Playwright has no "new window" API — `newPage()` is always a tab — so this
 * goes through CDP. It matters because Chrome only emits screencast frames for
 * a page it is compositing: sessions sharing one window would leave every live
 * viewer but the foreground one frozen on its last frame, with nothing
 * reporting a problem. Serialised per profile so the claim in
 * {@link attributeNewPage} is never ambiguous.
 */
function openSessionWindow(profile: SharedProfile): Promise<unknown> {
  const run = async (): Promise<unknown> => {
    while (profile.unclaimedPages.length) {
      const candidate = profile.unclaimedPages.shift();
      const pg = candidate as { isClosed?: () => boolean } | null;
      if (pg && !pg.isClosed?.()) return candidate;
    }
    const cdp = profile.browserCdp as { send: (m: string, p?: unknown) => Promise<unknown> } | null;
    if (!cdp) {
      // Ephemeral fallback, or a Playwright without a browser-level session.
      // A tab is worse but it is not broken; there is only one session's window
      // in play on that path anyway.
      return (profile.context as { newPage: () => Promise<unknown> }).newPage();
    }
    let settle: ((page: unknown) => void) | null = null;
    const claimed = new Promise<unknown>((resolve) => {
      settle = resolve;
    });
    profile.pendingWindow = settle;
    try {
      // A persistent profile remembers its last window geometry. Pin every
      // session window so an old, manually resized window cannot silently
      // undo the App browser's current desktop-size default.
      await cdp.send("Target.createTarget", {
        url: "about:blank",
        newWindow: true,
        width: BROWSER_WINDOW_WIDTH,
        height: BROWSER_WINDOW_HEIGHT,
      });
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Chrome did not open a window for this session")),
          WINDOW_OPEN_TIMEOUT_MS,
        );
      });
      try {
        return await Promise.race([claimed, timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    } finally {
      if (profile.pendingWindow === settle) profile.pendingWindow = null;
    }
  };
  // Chain on both settlements so one failed window does not wedge the queue.
  const next = profile.windowChain.then(run, run);
  profile.windowChain = next.catch(() => undefined);
  return next;
}

/**
 * Seed a brand-new profile from the cookie snapshot the ephemeral path left
 * behind, so upgrading does not sign every employee out of every site.
 *
 * Once only. After this the profile on disk is the source of truth and the
 * snapshot is a one-way export (see {@link schedulePersistForProfile}).
 */
async function hydrateProfileFromSnapshot(profile: SharedProfile): Promise<void> {
  const state = await loadStorageState(profile.companyId, profile.employeeId);
  if (!state) return;
  const snapshot = state as {
    cookies?: unknown[];
    origins?: Array<{ origin: string; localStorage?: Array<{ name: string; value: string }> }>;
  };
  const context = profile.context as {
    addCookies: (cookies: unknown[]) => Promise<void>;
    newPage: () => Promise<unknown>;
  };
  if (snapshot.cookies?.length) {
    await context.addCookies(snapshot.cookies).catch(() => {
      // A cookie the current Chrome rejects must not cost us the whole seed.
    });
  }
  const origins = (snapshot.origins ?? []).filter((o) => o.localStorage?.length);
  if (!origins.length) return;
  // localStorage is origin-scoped and can only be written from a document on
  // that origin, so each one needs a visit. Best-effort: a site that is down
  // costs that origin's localStorage, not the sign-in cookies above.
  const page = (await context.newPage()) as {
    goto: (url: string, opts?: unknown) => Promise<unknown>;
    evaluate: (fn: string, arg?: unknown) => Promise<unknown>;
    close: () => Promise<void>;
  };
  try {
    for (const origin of origins) {
      try {
        await page.goto(origin.origin, { waitUntil: "domcontentloaded", timeout: 10_000 });
        await page.evaluate(
          `(items) => { for (const i of items) { try { localStorage.setItem(i.name, i.value); } catch {} } }`,
          origin.localStorage,
        );
      } catch {
        // skip this origin
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}

function clearLinger(profile: SharedProfile): void {
  if (profile.lingerTimer) {
    clearTimeout(profile.lingerTimer);
    profile.lingerTimer = null;
  }
}

/**
 * Drop one session's claim on the profile, closing Chrome once nobody holds it.
 *
 * The membership drop and the emptiness test are one synchronous pair with no
 * await between them, so two sessions releasing concurrently cannot both see a
 * non-empty set and leave the browser up forever, nor both see an empty one and
 * close it twice.
 */
async function releaseSharedProfile(
  profile: SharedProfile,
  sessionId: string,
  reason: "idle" | "shutdown" | "error" | "manual",
): Promise<void> {
  profile.sessionIds.delete(sessionId);
  if (profile.sessionIds.size > 0) return;
  if (reason === "shutdown") {
    await closeProfile(profile);
    return;
  }
  clearLinger(profile);
  profile.lingerTimer = setTimeout(() => {
    profile.lingerTimer = null;
    if (profile.sessionIds.size === 0) void closeProfile(profile).catch(() => {});
  }, profileLingerMs);
}

/** Close the employee's Chrome, exporting its cookies on the way out. */
function closeProfile(profile: SharedProfile): Promise<void> {
  if (profile.closing) return profile.closing;
  clearLinger(profile);
  if (profile.persistTimer) {
    clearTimeout(profile.persistTimer);
    profile.persistTimer = null;
  }
  const done = (async () => {
    try {
      await saveStorageState(profile.companyId, profile.employeeId, profile.context);
    } catch {
      // A jar we could not export is not a reason to leak a browser.
    }
    await closeProfileHandles(profile);
  })().finally(() => {
    if (profiles.get(profile.key) === profile) profiles.delete(profile.key);
  });
  profile.closing = done;
  return done;
}

async function closeProfileHandles(profile: SharedProfile): Promise<void> {
  try {
    const cx = profile.context as { close: () => Promise<void> } | null;
    if (cx) await cx.close();
  } catch {
    // ignore
  }
  try {
    // Only the ephemeral fallback owns a Browser. `launchPersistentContext`
    // returns a context whose `close()` already stops the process.
    const br = profile.browser as { close: () => Promise<void> } | null;
    if (br) await br.close();
  } catch {
    // ignore
  }
}

/**
 * Debounced cookie export, at profile level.
 *
 * One timer per employee rather than one per session: N sessions sharing a
 * context each exporting the same jar is N times the work for one result, and
 * on the old per-session timers it was also N racing whole-file writes.
 */
function schedulePersistForProfile(profile: SharedProfile): void {
  if (profile.persistTimer) clearTimeout(profile.persistTimer);
  profile.persistTimer = setTimeout(() => {
    profile.persistTimer = null;
    void saveStorageState(profile.companyId, profile.employeeId, profile.context).catch(() => {
      // Opportunistic — the teardown save is the authoritative one.
    });
  }, PERSIST_DEBOUNCE_MS);
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
  const { acquireMemberBrowserLease, isMemberBrowserOnline } =
    await import("./memberBrowserHub.js");
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
  const chromium = await loadChromiumLauncher(
    "Member browsers require playwright-core in the App container.",
  );
  if (!chromium.connectOverCDP) {
    throw new Error("This Playwright build cannot attach to an existing browser.");
  }
  const browser = await chromium.connectOverCDP(endpoint);
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
    context,
    remoteBrowser: browser,
    profileKey: null,
    page,
    cdp,
    idleTimer: null,
    activeHolders: 0,
    notices: [],
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

  await syncViewportFromBrowser(runtime).catch(() => {
    // The session keeps the default size; the viewer self-corrects from the
    // first screencast frame's metadata.
  });

  return page;
}

/**
 * Read the real window size out of the browser and tell the session about it,
 * so the screencast is captured at native resolution and the viewer's
 * take-over clicks land where the human aimed them. Both paths need this: a
 * Member's browser is whatever size their screen made it, and the container's
 * own Chrome is headed against a virtual display.
 */
async function syncViewportFromBrowser(runtime: SessionRuntime): Promise<void> {
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
  if (!r || r.page === newPage) return;
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
  // Identity, not presence: the session may have been torn down and a new
  // runtime registered under the same id while we awaited the load state.
  if (runtimes.get(sessionId) !== r || np.isClosed()) return;
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
  const profile = r.profileKey ? profiles.get(r.profileKey) : null;
  if (profile) schedulePersistForProfile(profile);
}

async function mirrorNav(r: SessionRuntime): Promise<void> {
  // The runtime may have been torn down while the debounce was pending —
  // a stale write here would resurrect hub state for a closed session.
  if (runtimes.get(r.id) !== r) return;
  const p = r.page as { url: () => string; title: () => Promise<string>; isClosed: () => boolean };
  if (p.isClosed()) return;
  const rawUrl = p.url();
  let title = "";
  try {
    title = await p.title();
  } catch {
    // best-effort
  }
  let metadata: BrowserNavigationMetadata = { url: rawUrl, title: title || null };
  if (navigationMetadataSanitizer) {
    try {
      metadata = await navigationMetadataSanitizer(r.id, metadata);
    } catch {
      // Credential metadata must fail closed. Persistence and viewer fanout
      // receive only the origin if classification itself ever fails.
      metadata = { url: originOnly(rawUrl), title: null };
    }
  }
  // Teardown can run while `title()` or the sanitizer awaits. Never let that
  // stale continuation write to a closed session or broadcast metadata after
  // its credential-redaction state has been cleared.
  if (runtimes.get(r.id) !== r || p.isClosed()) return;
  // On a Member's own machine the mirror keeps the origin only. The full URL
  // is written to the App database and broadcast to every attached viewer, and
  // on plenty of sites the path carries a token or a document the human would
  // not expect to leave their laptop.
  const mirroredUrl = r.memberBrowserId ? originOnly(metadata.url) : metadata.url;
  const mirroredTitle = metadata.title || null;
  if (mirroredUrl === r.lastNavUrl && (mirroredTitle ?? "") === r.lastNavTitle) return;
  r.lastNavUrl = mirroredUrl;
  r.lastNavTitle = mirroredTitle ?? "";
  await AppDataSource.getRepository(BrowserSession).update(
    { id: r.id },
    { pageUrl: mirroredUrl, pageTitle: mirroredTitle },
  );
  // The fanout hub picks up nav events via the screencast loop's snapshot,
  // but pushing one explicitly keeps the viewer URL-bar in sync between
  // frames.
  const { broadcastNav } = await import("./browserSessions.js");
  broadcastNav(r.id, mirroredUrl, mirroredTitle);
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
  // Last chance to scan while the page still exists. A navigation can reveal a
  // password field after the final browser RPC and before teardown, and later
  // screenshots must stay redacted when it does.
  const { flushBrowserRecordingFrameScans, observeRuntimePasswordValues } =
    await import("./browserSessions.js");
  const { browserRecordingDemand, freezeBrowserRecording } = await import(
    "./browserRecordings.js"
  );
  const finalScanRequired = browserRecordingDemand(sessionId);
  freezeBrowserRecording(sessionId);
  await flushBrowserRecordingFrameScans(sessionId);
  await observeRuntimePasswordValues(sessionId, {
    failClosedIfUnavailable: finalScanRequired,
  }).catch(() => {
    // Redaction bookkeeping only; teardown still finalizes the recording.
  });
  runtimes.delete(sessionId);
  if (r.idleTimer) clearTimeout(r.idleTimer);
  if (r.navTimer) clearTimeout(r.navTimer);

  // Close only the windows this session opened. On the local path the context
  // is the employee's shared Chrome and closing it here would take every
  // sibling session's window with it, mid-turn; on the member path it is a
  // human's own browser and was never ours to close. `ownedPages` is the only
  // trustworthy answer to "is this ours" on either path.
  const pages = [r.page, ...collectOwned(r)].filter(Boolean);
  for (const candidate of new Set(pages)) {
    if (!r.ownedPages.has(candidate as object)) continue;
    try {
      await (candidate as { close: () => Promise<void> }).close();
    } catch {
      // ignore — a page that is already gone is the outcome we wanted
    }
  }

  if (r.memberBrowserId) {
    try {
      // Closes our CDP socket and nothing else: the human's Chrome keeps
      // running, because Playwright's teardown for a connected browser is
      // `transport.closeAndWait()`. Never a `context.close()` — on a
      // CDP-attached persistent context that severs the whole transport.
      const br = r.remoteBrowser as { close: () => Promise<void> } | null;
      if (br) await br.close();
    } catch {
      // ignore
    }
    const { releaseMemberBrowserLease } = await import("./memberBrowserHub.js");
    releaseMemberBrowserLease(r.memberBrowserId, sessionId);
  } else if (r.profileKey) {
    const profile = profiles.get(r.profileKey);
    // No save here. The jar belongs to the profile, not to this session, and
    // siblings may still be writing to it — `closeProfile` does the
    // authoritative export once nobody is left, and `schedulePersistForProfile`
    // covers the long-running case. A crashed context never reaches either,
    // which is what we want: a partial export must not overwrite a good one.
    if (profile) await releaseSharedProfile(profile, sessionId, reason);
  }

  await closeBrowserSession(sessionId, reason);
}

/**
 * The pages this runtime owns that we can still enumerate.
 *
 * `ownedPages` is a WeakSet — deliberately, so a closed page can be collected —
 * which means it can be asked but not listed. The context can list, so
 * intersect the two: every page currently in the context that this session
 * remembers opening. On a shared profile that is precisely this session's
 * windows and none of its siblings'.
 */
function collectOwned(r: SessionRuntime): unknown[] {
  const cx = r.context as { pages?: () => unknown[] } | null;
  if (!cx?.pages) return [];
  try {
    return cx.pages().filter((p) => r.ownedPages.has(p as object));
  } catch {
    return [];
  }
}

/**
 * Tear every live session down, flushing each one's cookies on the way out.
 *
 * This is what a process signal calls. Without it, `docker stop` and every
 * `genosyn update` killed live browsers mid-flight: the storage snapshot only
 * ever happened on a teardown we initiated, so an employee who had just signed
 * into a site lost that login unless the idle watchdog happened to fire first.
 * The `"shutdown"` reason existed in {@link releasePage} from the start — it
 * simply had no caller.
 *
 * Never rejects. A shutdown path that throws is a shutdown path that skips the
 * remaining sessions, and one browser refusing to close is not a reason to drop
 * the others' cookies on the floor.
 */
export async function releaseAllPages(reason: "shutdown" | "manual" = "shutdown"): Promise<number> {
  // Snapshot the ids first: `releasePage` mutates the map as it goes.
  const ids = [...runtimes.keys()];
  await Promise.all(
    ids.map((id) =>
      releasePage(id, reason).catch(() => {
        // best-effort, per session
      }),
    ),
  );
  // Second pass: a profile whose last session just left is sitting in its
  // linger window, and on shutdown there is no later acquire to justify the
  // wait. Without this, `docker stop` leaves a Chrome per employee to be killed
  // by the runtime — which is exactly how a profile lock gets left behind.
  await Promise.all(
    [...profiles.values()].map((profile) =>
      closeProfile(profile).catch(() => {
        // best-effort, per profile
      }),
    ),
  );
  return ids.length;
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
