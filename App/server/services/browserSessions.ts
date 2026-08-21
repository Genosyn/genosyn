import crypto from "node:crypto";
import { In } from "typeorm";
import { WebSocket } from "ws";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession, type BrowserSessionCloseReason } from "../db/entities/BrowserSession.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { Run } from "../db/entities/Run.js";
import {
  getRuntime,
  holdRuntime,
  releasePage,
  releaseRuntime,
  markActivity,
} from "./browserChromium.js";
import { normalizeViewerNavigationUrl, parseAllowList, urlAllowed } from "./browserHostPolicy.js";
import { memberBrowserUrlAllowed } from "./memberBrowsers.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import { registerMembershipAuthorizationChangeSink } from "./resourceEvents.js";
import {
  BROWSER_RECORDING_FPS,
  acceptBrowserRecordingFrame,
  beginBrowserRecording,
  browserSessionCreationBlocked,
  browserRecordingDemand,
  clearBrowserRecordingFreeze,
  finishBrowserRecording,
  freezeBrowserRecording,
  markBrowserRecordingRunFinalizing,
  pauseBrowserRecording,
  restrictBrowserRecording,
} from "./browserRecordings.js";
import { BROWSER_WINDOW_HEIGHT, BROWSER_WINDOW_WIDTH } from "./browserProfile.js";

/**
 * Browser-session lifecycle + in-memory fanout hub.
 *
 * Architecture (post-v0.3.23):
 *
 *   * The App owns Chromium per `BrowserSession` (`browserChromium.ts`).
 *     Chromium outlives any individual MCP child spawn so the agent can
 *     promise "I'll wait" without lying — the same browser is still up
 *     when the next chat turn fires.
 *   * The MCP child is a thin RPC translator. Each browser tool the model
 *     calls (`browser_open`, `browser_click`, …) is forwarded as an HTTP
 *     POST to the App, which performs it on the App-owned Chromium.
 *   * Screencast frames flow from the App's CDP session straight into the
 *     fanout hub here, then out to every connected viewer's WebSocket.
 *   * Viewer input events (mouse + keyboard, when "Take over" is on) are
 *     dispatched directly to the App's CDP session.
 *
 * Routine Run frames also feed the App-private recording service. Viewer
 * demand and recorder demand share one CDP screencast so recording behaves
 * identically for the App browser and a Member browser.
 */

// Must outlive the longest a spawn can run, or a browser-enabled routine
// starts getting 401 "Token expired" on every browser tool call partway
// through (browserRpc.ts) while the CLI keeps going. The token is stamped
// once at session creation and never refreshed, and routine `timeoutSec`
// caps at 6h (routes/routines.ts), so 7h covers the longest run with margin —
// matching the genosyn MCP token TTL (mcpTokens.ts). Only *pending* sessions
// are swept on this TTL; live Chromium is torn down by the idle watchdog, so
// a longer TTL doesn't keep real browsers alive any longer.
const MCP_TOKEN_TTL_MS = 7 * 60 * 60 * 1000; // 7h
const EXPIRE_GRACE_MS = 30_000;
const cleanupListeners = new Set<(sessionId: string) => void>();
type SensitiveObservationKind = "password-present" | "password-value" | "active-input-value";
const sensitiveValueListeners = new Set<
  (sessionId: string, value: string, kind: SensitiveObservationKind) => void | Promise<void>
>();
const recordingFrameInspectors = new Set<
  (sessionId: string, jpegBase64: string) => boolean | Promise<boolean>
>();
let passwordObservationRuntime: (sessionId: string) => unknown = getRuntime;
let beforeBrowserSessionSaveForTests: (() => Promise<void>) | null = null;
const passwordTaintKey = `__genosynPasswordTaint_${crypto.randomBytes(12).toString("hex")}`;
const passwordTaintProbeKey = `__genosynPasswordTaintProbe_${crypto.randomBytes(12).toString("hex")}`;
const passwordTaintSignal = `genosyn-password-taint:${crypto.randomBytes(24).toString("hex")}`;
const passwordTaintInstalledPages = new WeakSet<object>();
const passwordTaintInstalledContexts = new WeakSet<object>();
type PasswordCdpSession = {
  send: (method: string, params?: unknown) => Promise<unknown>;
  on: (event: string, callback: (payload: unknown) => void) => void;
  detach?: () => Promise<void>;
};
type PasswordDomGuardState = {
  closedTreeNodeIds: Set<number>;
  enabled: boolean;
  generation: number;
  listenersInstalled: boolean;
  ready: boolean;
  refresh: Promise<boolean> | null;
};
const passwordDomGuardStates = new WeakMap<object, PasswordDomGuardState>();
const passwordFrameCdpSessions = new WeakMap<object, PasswordCdpSession>();
const passwordParentCoveredFrames = new WeakSet<object>();
const passwordFrameLifecycleInstalledPages = new WeakSet<object>();

function forgetPasswordFrame(frame: object): void {
  const cdp = passwordFrameCdpSessions.get(frame);
  passwordFrameCdpSessions.delete(frame);
  passwordParentCoveredFrames.delete(frame);
  if (cdp?.detach) void cdp.detach().catch(() => undefined);
}

/**
 * Runs before page scripts in every document and child frame, then remains
 * sticky for that document's lifetime. Mutation records retain detached nodes
 * and old attribute values, so a password input that appears and disappears in
 * one task still taints the page before a later screencast-frame scan.
 */
function installStickyPasswordTaint(args: {
  key: string;
  probeKey: string;
  requireExisting?: boolean;
  signal: string;
  challenge?: string | null;
}): boolean {
  const { key, probeKey, requireExisting = false, signal, challenge = null } = args;
  const scope = globalThis as typeof globalThis & Record<string, unknown>;
  const existing = scope[key];
  if (typeof existing === "function") {
    if (challenge) {
      const probe = scope[probeKey];
      if (typeof probe !== "function") return true;
      try {
        (probe as (value: string) => void)(challenge);
      } catch {
        return true;
      }
    }
    try {
      return existing() === true;
    } catch {
      return true;
    }
  }
  // A nonblank page may be trusted only when the browser-context init script
  // already installed the observer before document scripts. Installing one
  // now could capture page-modified intrinsics after sensitive UI disappeared.
  if (requireExisting) return true;

  // Capture the browser's native console method before document scripts can
  // replace it. Playwright aggregates native console events from every frame,
  // including OOPIFs, so this avoids a page-visible exposed-binding wrapper and
  // its mutable transport/Promise/JSON dependencies. An already-running page
  // has to pass a random challenge before its observer is trusted.
  let emit: ((value: string) => void) | null = null;
  let safeApply: typeof Reflect.apply | null = null;
  try {
    const nativeDebug = console.debug;
    const nativeApply = Reflect.apply;
    const nativeConsole = console;
    if (typeof nativeDebug === "function" && typeof nativeApply === "function") {
      safeApply = nativeApply;
      emit = (value: string) => {
        nativeApply(nativeDebug, nativeConsole, [value]);
      };
    }
  } catch {
    emit = null;
  }

  let tainted = emit === null;
  let reported = false;
  const reportTaint = () => {
    if (!tainted || reported || emit === null) return;
    try {
      // ConsoleAPICalled is emitted synchronously. The document may navigate
      // immediately afterwards; Node has already received the sticky taint.
      emit(signal);
      reported = true;
    } catch {
      reported = false;
    }
  };
  const probe = (value: string) => {
    if (emit === null) throw new Error("Password taint reporter unavailable");
    // Bind the response to the init-script secret. A hostile current page can
    // see the one-time challenge passed to Runtime.evaluate, but it cannot
    // forge this response without the closure that ran before page scripts.
    emit(`${signal}:probe:${value}`);
    if (tainted) emit(signal);
  };
  try {
    Object.defineProperty(scope, probeKey, {
      value: probe,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    tainted = true;
  }
  try {
    Object.defineProperty(scope, key, {
      value: () => tainted,
      configurable: false,
      enumerable: false,
      writable: false,
    });
  } catch {
    // If page code somehow occupied our randomized, non-enumerable key before
    // the init script ran, its state cannot be trusted.
    return true;
  }

  if (challenge) {
    try {
      probe(challenge);
    } catch {
      tainted = true;
    }
  }

  const mark = () => {
    tainted = true;
    reportTaint();
  };
  const observedRoots = new WeakSet<Node>();

  // Declarative closed shadow roots created after parsing require one of the
  // unsafe HTML APIs. They cannot be rediscovered from JavaScript, so taint a
  // call that requests one; the CDP DOM guard separately inspects declarative
  // roots created by the network parser.
  const wrapUnsafeHtml = (owner: object, name: string) => {
    try {
      const original = (owner as Record<string, unknown>)[name];
      if (typeof original !== "function") return;
      Object.defineProperty(owner, name, {
        configurable: true,
        enumerable: false,
        writable: true,
        value: function (this: unknown, ...callArgs: unknown[]) {
          try {
            const markup = String(callArgs[0] ?? "");
            if (
              /\bshadowrootmode\s*=\s*(?:["']\s*closed\s*["']|closed(?:\s|>|\/))/i.test(markup) &&
              /<input\b[^>]*\btype\s*=\s*(?:["']\s*password\s*["']|password(?:\s|>|\/))/i.test(
                markup,
              )
            ) {
              mark();
            }
          } catch {
            mark();
          }
          if (safeApply === null) throw new Error("Native apply is unavailable");
          return safeApply(original as (...args: unknown[]) => unknown, this, callArgs);
        },
      });
    } catch {
      mark();
    }
  };
  wrapUnsafeHtml(Element.prototype, "setHTMLUnsafe");
  wrapUnsafeHtml(ShadowRoot.prototype, "setHTMLUnsafe");
  wrapUnsafeHtml(Document, "parseHTMLUnsafe");

  const inspectElement = (element: Element) => {
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") {
      mark();
    }
    if (element.shadowRoot) observeRoot(element.shadowRoot);
  };
  const scanSubtree = (node: Node) => {
    if (node instanceof Element) inspectElement(node);
    if (node instanceof Document || node instanceof ShadowRoot || node instanceof Element) {
      for (const element of node.querySelectorAll("*")) inspectElement(element);
    }
  };
  const observeRoot = (root: Document | ShadowRoot) => {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    scanSubtree(root);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.oldValue?.toLowerCase() === "password") mark();
          if (record.target instanceof Element) inspectElement(record.target);
          continue;
        }
        for (const added of record.addedNodes) scanSubtree(added);
      }
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["type"],
      attributeOldValue: true,
    });
  };

  // Closed shadow roots cannot be rediscovered from their host. Observe them
  // at creation time, before page code can append a transient password input.
  try {
    const originalAttachShadow = Element.prototype.attachShadow;
    Object.defineProperty(Element.prototype, "attachShadow", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: function (this: Element, init: ShadowRootInit): ShadowRoot {
        const root = originalAttachShadow.call(this, init);
        observeRoot(root);
        return root;
      },
    });
  } catch {
    // Without closed-shadow coverage the privacy promise cannot be proven.
    mark();
  }

  try {
    observeRoot(document);
  } catch {
    mark();
  }
  reportTaint();
  return tainted;
}

function passwordTaintScript(args: Parameters<typeof installStickyPasswordTaint>[0]): string {
  // tsx/esbuild can inject free `__name(...)` calls into a function's runtime
  // toString(). Playwright serializes that text into the page, where the helper
  // does not exist. Supply it inside the payload so dev/test and tsc builds run
  // the exact same self-contained document-start script.
  return `(() => { "use strict"; const __name = (value) => value; return (${installStickyPasswordTaint.toString()})(${JSON.stringify(
    args,
  )}); })()`;
}

/** Test seam for executing the exact self-contained Playwright init payload. */
export const passwordTaintScriptForTests = passwordTaintScript;

/** Test seam for final-scan failures without launching Chromium. */
export function setPasswordObservationRuntimeForTests(
  lookup: ((sessionId: string) => unknown) | null,
): void {
  passwordObservationRuntime = lookup ?? getRuntime;
}

export function setBeforeBrowserSessionSaveForTests(hook: (() => Promise<void>) | null): void {
  beforeBrowserSessionSaveForTests = hook;
}

/** Register process-local cleanup owned by a browser RPC extension. */
export function registerBrowserSessionCleanup(listener: (sessionId: string) => void): () => void {
  cleanupListeners.add(listener);
  return () => cleanupListeners.delete(listener);
}

/** Let the browser RPC boundary retain password values before human input can reveal them. */
export function registerBrowserSensitiveValueListener(
  listener: (
    sessionId: string,
    value: string,
    kind: SensitiveObservationKind,
  ) => void | Promise<void>,
): () => void {
  sensitiveValueListeners.add(listener);
  return () => sensitiveValueListeners.delete(listener);
}

/**
 * Inspect the exact JPEG bytes before a Routine recording accepts them.
 * Returning false, throwing, or rejecting withholds the entire recording.
 */
export function registerBrowserRecordingFrameInspector(
  inspector: (sessionId: string, jpegBase64: string) => boolean | Promise<boolean>,
): () => void {
  recordingFrameInspectors.add(inspector);
  return () => recordingFrameInspectors.delete(inspector);
}

/**
 * Outbound message shape, used for both viewer-side WS and the
 * cross-module fan-out helpers. Encoded as JSON over the WebSocket. Frame
 * payloads are inline base64 — small enough at JPEG q60 for v1, and
 * avoids the complications of binary WebSocket framing across proxies.
 */
export type LiveMessage =
  | {
      type: "hello";
      sessionId: string;
      viewportWidth: number;
      viewportHeight: number;
      pageUrl: string;
      pageTitle: string | null;
    }
  | {
      type: "frame";
      frameId: number;
      data: string;
      metadata?: {
        offsetTop?: number;
        pageScaleFactor?: number;
        deviceWidth?: number;
        deviceHeight?: number;
        scrollOffsetX?: number;
        scrollOffsetY?: number;
        timestamp?: number;
      };
    }
  | { type: "frame.ack"; frameId: number }
  | { type: "nav"; url: string; title: string | null }
  | { type: "viewers"; count: number }
  | { type: "closed"; reason: BrowserSessionCloseReason }
  | {
      type: "input.mouse";
      action: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "none" | "left" | "middle" | "right";
      buttons?: number;
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      type: "input.key";
      action: "keyDown" | "keyUp" | "char";
      key?: string;
      code?: string;
      text?: string;
      modifiers?: number;
      windowsVirtualKeyCode?: number;
    }
  | { type: "viewport.set"; width: number; height: number }
  | { type: "control.takeover"; userId: string; takeover: boolean }
  /** Address-bar navigation from a viewer that has taken control. */
  | { type: "control.navigate"; url: string }
  /** Back / forward / reload from the viewer's toolbar. */
  | { type: "control.history"; action: "back" | "forward" | "reload" }
  /** Why the last take-over navigation was refused, shown under the address bar. */
  | { type: "nav.error"; message: string };

type ViewerSocket = {
  ws: WebSocket;
  userId: string;
  takeover: boolean;
};

type PendingAck = {
  cdpSessionId: string;
  /**
   * Fires if no viewer acks in time. CDP will not emit another frame until the
   * current one is acked, so a viewer that stops acking — a decode failure, a
   * socket wedged behind a proxy — would otherwise freeze the picture for
   * *every* watcher until they all disconnect.
   */
  timer: NodeJS.Timeout;
};

type SessionState = {
  id: string;
  companyId: string;
  employeeId: string;
  runId: string | null;
  viewers: Set<ViewerSocket>;
  /** Frames waiting on viewer-side ack before we tell CDP to advance. */
  pendingCdpAcks: Map<number, PendingAck>; // ourFrameId → CDP ack bookkeeping
  /** Last frame we saw, replayed to viewers that connect mid-stream. */
  lastFrame: LiveMessage | null;
  pageUrl: string;
  pageTitle: string | null;
  viewportWidth: number;
  viewportHeight: number;
  /** True while a CDP `Page.startScreencast` is active. */
  screencasting: boolean;
  /** Increments per emitted frame so viewers can ack by id. */
  frameCounter: number;
  /** Latest recorder frame waiting for its fail-closed DOM privacy scan. */
  pendingRecordingFrame: { data: string; navigationGeneration: number } | null;
  /** Serialized scanner; new frames replace the pending one instead of piling up. */
  recordingFrameTask: Promise<void> | null;
  recordingFrameTimer: NodeJS.Timeout | null;
  lastRecordingFrameScanAt: number;
  /** Invalidates a captured frame when its document navigates before the scan settles. */
  recordingNavigationGeneration: number;
};

const sessions = new Map<string, SessionState>();
/** Index used by the WS upgrade handler to resolve a token to a session. */
const tokenToSessionId = new Map<string, string>();
type BrowserRpcActivityState = {
  active: number;
  idleWaiters: Set<() => void>;
};
const browserRpcActivity = new Map<string, BrowserRpcActivityState>();

/**
 * Enter one already-authorized browser RPC synchronously.
 *
 * Run finalization installs its tombstone before its first await. That gives
 * this function a strict either/or boundary: the RPC obtains a lease first and
 * finalization waits for it, or the tombstone wins and the RPC never starts.
 */
export function beginBrowserRpcActivity(
  session: Pick<BrowserSession, "id" | "companyId" | "runId">,
): (() => void) | null {
  if (browserSessionCreationBlocked(session.companyId, session.runId)) return null;
  let state = browserRpcActivity.get(session.id);
  if (!state) {
    state = { active: 0, idleWaiters: new Set() };
    browserRpcActivity.set(session.id, state);
  }
  state.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = browserRpcActivity.get(session.id);
    if (!current) return;
    current.active = Math.max(0, current.active - 1);
    if (current.active > 0) return;
    browserRpcActivity.delete(session.id);
    for (const resolve of current.idleWaiters) resolve();
    current.idleWaiters.clear();
  };
}

/** Wait for handlers that crossed the authorization boundary before finalization. */
export function waitForBrowserRpcActivity(sessionId: string): Promise<void> {
  const state = browserRpcActivity.get(sessionId);
  if (!state || state.active === 0) return Promise.resolve();
  return new Promise((resolve) => state.idleWaiters.add(resolve));
}

/** Isolated-test cleanup for an intentionally process-local lifecycle guard. */
export function resetBrowserRpcActivityForTests(): void {
  for (const state of browserRpcActivity.values()) {
    for (const resolve of state.idleWaiters) resolve();
  }
  browserRpcActivity.clear();
}

export function browserRpcActivityStateForTests(sessionId: string): {
  active: number;
  waiters: number;
} {
  const state = browserRpcActivity.get(sessionId);
  return { active: state?.active ?? 0, waiters: state?.idleWaiters.size ?? 0 };
}

registerMembershipAuthorizationChangeSink((companyId) => {
  for (const state of sessions.values()) {
    if (state.companyId !== companyId) continue;
    for (const viewer of state.viewers) {
      try {
        viewer.ws.close(1008, "Browser viewer access changed");
      } catch {
        // The close handler removes the viewer; a dead socket needs no work.
      }
    }
  }
});

// ---------- token / lifecycle ----------

function newToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Find an existing live `BrowserSession` for this conversation/run, or
 * mint a fresh one. Reusing across turns of the same chat is what makes
 * the agent's "I'll wait" actually work — Chromium and the page state
 * persist as long as the row stays `live` or `pending`.
 */
export async function createBrowserSession(args: {
  companyId: string;
  employeeId: string;
  conversationId: string | null;
  runId: string | null;
  /** The Member's browser to drive, or null for the App's own Chromium. */
  memberBrowserId?: string | null;
  viewportWidth?: number;
  viewportHeight?: number;
}): Promise<BrowserSession> {
  if (browserSessionCreationBlocked(args.companyId, args.runId)) {
    throw new Error("This browser session belongs to a resource that is being removed.");
  }
  const runStillRunning = async (): Promise<boolean> =>
    args.runId === null ||
    AppDataSource.getRepository(Run).existsBy({ id: args.runId, status: "running" });
  if (!(await runStillRunning())) {
    throw new Error("This browser session belongs to a Run that has finished.");
  }
  const repo = AppDataSource.getRepository(BrowserSession);

  // Reuse an existing live/pending session when one already covers this
  // conversation or run. The conversation-keyed lookup is the primary
  // path — a routine spawn never reuses (each Run gets its own session).
  if (args.conversationId) {
    const existing = await repo
      .createQueryBuilder("s")
      .where("s.companyId = :companyId", { companyId: args.companyId })
      .andWhere("s.employeeId = :employeeId", { employeeId: args.employeeId })
      .andWhere("s.conversationId = :conversationId", { conversationId: args.conversationId })
      .andWhere("s.status IN (:...statuses)", { statuses: ["pending", "live"] })
      .orderBy("s.createdAt", "DESC")
      .getOne();
    // A session is only reusable if it drives the same browser. Someone who
    // switched the thread from Genosyn's browser to their own mid-conversation
    // must get a new session, not keep driving the old one.
    const sameTarget = (existing?.memberBrowserId ?? null) === (args.memberBrowserId ?? null);
    if (existing && sameTarget && existing.mcpTokenExpiresAt.getTime() > Date.now()) {
      // Re-register the token → session mapping: after an App restart the
      // in-memory map is empty, and without this line every tool call in a
      // resumed conversation 401s until the token's 7h TTL lapses.
      tokenToSessionId.set(existing.mcpToken, existing.id);
      return existing;
    }
  }

  const row = repo.create({
    companyId: args.companyId,
    employeeId: args.employeeId,
    conversationId: args.conversationId,
    runId: args.runId,
    memberBrowserId: args.memberBrowserId ?? null,
    mcpToken: newToken(),
    mcpTokenExpiresAt: new Date(Date.now() + MCP_TOKEN_TTL_MS),
    status: "pending",
    closeReason: null,
    pageUrl: "",
    pageTitle: null,
    viewportWidth: args.viewportWidth ?? BROWSER_WINDOW_WIDTH,
    viewportHeight: args.viewportHeight ?? BROWSER_WINDOW_HEIGHT,
  });
  if (browserSessionCreationBlocked(args.companyId, args.runId) || !(await runStillRunning())) {
    throw new Error("This browser session belongs to a resource that is being removed.");
  }
  await beforeBrowserSessionSaveForTests?.();
  await repo.save(row);
  if (browserSessionCreationBlocked(args.companyId, args.runId) || !(await runStillRunning())) {
    await repo.delete({ id: row.id }).catch(() => undefined);
    throw new Error("This browser session belongs to a resource that is being removed.");
  }
  tokenToSessionId.set(row.mcpToken, row.id);
  return row;
}

/**
 * Resolve the MCP-side bearer token to its session id, or null. The
 * in-memory map is a cache; on a miss (an App restart mid-conversation)
 * fall back to the DB — `mcpToken` is uniquely indexed — so an in-flight
 * browser session survives the restart instead of 401ing for the rest of
 * its 7h token TTL.
 */
export async function resolveBrowserSessionToken(token: string): Promise<string | null> {
  const cached = tokenToSessionId.get(token);
  if (cached) return cached;
  const row = await AppDataSource.getRepository(BrowserSession).findOneBy({ mcpToken: token });
  if (!row) return null;
  if (row.status === "closed" || row.status === "expired") return null;
  tokenToSessionId.set(row.mcpToken, row.id);
  return row.id;
}

/**
 * Mark a session closed and tear down its hub state. Idempotent — repeated
 * calls (e.g. idle watchdog + manual UI close racing) are no-ops after
 * the first.
 */
export async function closeBrowserSession(
  sessionId: string,
  reason: NonNullable<BrowserSessionCloseReason>,
): Promise<void> {
  const repo = AppDataSource.getRepository(BrowserSession);
  const row = await repo.findOneBy({ id: sessionId });
  if (!row) return;
  const finalScanRequired = browserRecordingDemand(sessionId);
  freezeBrowserRecording(sessionId);
  await flushBrowserRecordingFrameScans(sessionId);
  // Direct close paths do not necessarily pass through releasePage. Scan
  // before teardown while any process-local runtime is still observable.
  try {
    await observeRuntimePasswordValues(sessionId, {
      failClosedIfUnavailable: finalScanRequired,
    });
  } catch {
    if (row.runId) await restrictBrowserRecording(sessionId).catch(() => undefined);
  }
  const wasOpen = row.status !== "closed" && row.status !== "expired";
  if (wasOpen) {
    const closedAt = new Date();
    await repo.update(
      { id: row.id, status: In(["pending", "live"]) },
      { status: "closed", closeReason: reason, closedAt },
    );
    row.status = "closed";
    row.closeReason = reason;
    row.closedAt = closedAt;
  }
  // Revoke authority before waiting on the auxiliary encoder. A 5s ffmpeg
  // shutdown must not leave a window for fresh browser RPCs after the final
  // privacy scan.
  tokenToSessionId.delete(row.mcpToken);
  const state = sessions.get(sessionId);
  if (wasOpen && state) {
    broadcastToViewers(state, { type: "closed", reason });
    for (const v of state.viewers) {
      try {
        v.ws.close(1000, "session closed");
      } catch {
        /* best-effort */
      }
    }
  }
  if (row.runId) {
    await finishBrowserRecording(row).catch(() => undefined);
  } else {
    clearBrowserRecordingFreeze(sessionId);
  }
  pauseBrowserRecording(sessionId);
  teardown(sessionId);
}

function teardown(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (state) {
    clearPendingAcks(state);
    if (state.recordingFrameTimer) clearTimeout(state.recordingFrameTimer);
  }
  for (const listener of cleanupListeners) {
    try {
      listener(sessionId);
    } catch {
      // Teardown must continue even if an extension's memory cleanup fails.
    }
  }
  sessions.delete(sessionId);
}

/**
 * Background sweep: any pending session whose MCP token TTL has lapsed and
 * never went `live` flips to `expired`. Runs once a minute from boot.
 */
export async function sweepExpiredBrowserSessions(): Promise<void> {
  const repo = AppDataSource.getRepository(BrowserSession);
  const cutoff = new Date(Date.now() - EXPIRE_GRACE_MS);
  const stale = await repo
    .createQueryBuilder("s")
    .where("s.status = :status", { status: "pending" })
    .andWhere("s.mcpTokenExpiresAt < :cutoff", { cutoff })
    .getMany();
  for (const row of stale) {
    row.status = "expired";
    row.closedAt = new Date();
    await repo.save(row);
    tokenToSessionId.delete(row.mcpToken);
    teardown(row.id);
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
export function bootBrowserSessionSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    withSchedulerLease("browser-session-sweep", 55_000, () => sweepExpiredBrowserSessions()).catch(
      () => {
        // best-effort housekeeping
      },
    );
  }, 60_000);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
}

// ---------- App-side activity surface (called by the MCP RPC routes) ----------

let beforeMarkLiveCasForTests: (() => Promise<void>) | null = null;

export function setBeforeMarkLiveCasForTests(hook: (() => Promise<void>) | null): void {
  beforeMarkLiveCasForTests = hook;
}

/**
 * Flip the row from `pending` to `live` once the App has acquired its page.
 * Called before the first browser action so a Run recording is already
 * consuming frames when that action begins.
 */
export async function markSessionLive(
  sessionId: string,
  options: { allowFinalizingRun?: boolean } = {},
): Promise<void> {
  const repo = AppDataSource.getRepository(BrowserSession);
  let row = await repo.findOneBy({ id: sessionId });
  if (!row) return;
  if (row.status === "closed" || row.status === "expired") return;
  if (row.status === "pending") {
    await beforeMarkLiveCasForTests?.();
    const startedAt = new Date();
    const changed = await repo.update(
      { id: row.id, status: "pending" },
      { status: "live", startedAt },
    );
    if (changed.affected !== 1) return;
    row = await repo.findOneBy({ id: sessionId });
    if (!row || row.status !== "live") return;
  }
  if (row.runId) {
    const recording = await beginBrowserRecording(row, options).catch(() => null);
    if (recording?.status === "recording") {
      const state = ensureState(sessionId);
      state.companyId = row.companyId;
      state.employeeId = row.employeeId;
      state.runId = row.runId;
      state.viewportWidth = row.viewportWidth;
      state.viewportHeight = row.viewportHeight;
      await startScreencast(state);
    }
  }
}

/** Update the cached page URL/title and notify viewers. */
export function broadcastNav(sessionId: string, url: string, title: string | null): void {
  const state = ensureState(sessionId);
  state.pageUrl = url;
  state.pageTitle = title;
  broadcastToViewers(state, { type: "nav", url, title });
}

/**
 * The runtime swapped its active page (a popup was adopted). The old CDP
 * session — and the screencast riding on it — died with the old page, so
 * rewire: drop the stale frame-listener bookkeeping and restart the cast
 * on the new page if anyone is watching.
 */
export async function notifyPageSwapped(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (!state) return;
  const wasCasting = state.screencasting;
  state.screencasting = false;
  invalidateRecordingFramesForNavigation(state);
  clearPendingAcks(state);
  cdpListenerAttached.delete(sessionId);
  if (wasCasting && shouldScreencast(state)) {
    if (browserRecordingDemand(sessionId)) {
      // Prove the context-level observer reached the adopted popup before page
      // scripts, then scan it before its first JPEG can enter the recorder.
      await observeRuntimePasswordValues(sessionId, {
        failClosedIfUnavailable: true,
      });
    }
    await startScreencast(state);
  }
}

// ---------- screencast control (called when viewers come and go) ----------

/**
 * How long a frame may sit unacked before we tell CDP to advance anyway.
 *
 * Long enough that a viewer decoding at a sane rate always wins the race (so
 * back-pressure still works and Chromium doesn't render frames nobody will
 * see), short enough that a wedged viewer costs everyone a hiccup rather than
 * a frozen picture.
 */
const ACK_TIMEOUT_MS = 1200;

function shouldScreencast(state: SessionState): boolean {
  return state.viewers.size > 0 || browserRecordingDemand(state.id);
}

/** Tell CDP the frame is done with, once, whoever got there first. */
function ackCdpFrame(state: SessionState, frameId: number): void {
  const pending = state.pendingCdpAcks.get(frameId);
  if (!pending) return;
  clearTimeout(pending.timer);
  state.pendingCdpAcks.delete(frameId);
  const runtime = getRuntime(state.id);
  const cdp = runtime?.cdp as { send: (m: string, p?: unknown) => Promise<unknown> } | null;
  if (!cdp) return;
  cdp.send("Page.screencastFrameAck", { sessionId: pending.cdpSessionId }).catch(() => {
    // Chromium may have gone away between the frame and the ack.
  });
}

function clearPendingAcks(state: SessionState): void {
  for (const pending of state.pendingCdpAcks.values()) clearTimeout(pending.timer);
  state.pendingCdpAcks.clear();
}

function startRecordingFrameScan(state: SessionState): void {
  if (
    state.recordingFrameTask ||
    state.pendingRecordingFrame === null ||
    !browserRecordingDemand(state.id)
  ) {
    return;
  }
  const frame = state.pendingRecordingFrame;
  state.pendingRecordingFrame = null;
  state.lastRecordingFrameScanAt = Date.now();
  const task = (async () => {
    try {
      const verified = await observeRuntimePasswordValues(state.id, {
        discardIfUnavailable: true,
      });
      // A JPEG whose document could not be inspected is never written. This
      // is the safe navigation race: discard the unverified frame rather than
      // withholding already-verified video from the whole Run. Terminal scans
      // remain fail closed, and the sticky observer still withholds a real
      // password even if it appears and disappears between frames.
      if (!verified) return;
    } catch {
      await restrictBrowserRecording(state.id).catch(() => undefined);
      return;
    }
    for (const inspect of recordingFrameInspectors) {
      try {
        if (!(await inspect(state.id, frame.data))) {
          await restrictBrowserRecording(state.id).catch(() => undefined);
          return;
        }
      } catch {
        // A frame that cannot be classified never reaches ffmpeg. Withhold
        // the whole recording because an earlier accepted frame may belong to
        // the same sensitive ceremony.
        await restrictBrowserRecording(state.id).catch(() => undefined);
        return;
      }
    }
    if (frame.navigationGeneration === state.recordingNavigationGeneration) {
      acceptBrowserRecordingFrame(state.id, frame.data);
    }
  })();
  state.recordingFrameTask = task.finally(() => {
    state.recordingFrameTask = null;
    scheduleRecordingFrameScan(state);
  });
}

function scheduleRecordingFrameScan(state: SessionState): void {
  if (
    state.recordingFrameTask ||
    state.recordingFrameTimer ||
    state.pendingRecordingFrame === null ||
    !browserRecordingDemand(state.id)
  ) {
    return;
  }
  const delay = Math.max(
    0,
    state.lastRecordingFrameScanAt + 1000 / BROWSER_RECORDING_FPS - Date.now(),
  );
  if (delay === 0) {
    startRecordingFrameScan(state);
    return;
  }
  state.recordingFrameTimer = setTimeout(() => {
    state.recordingFrameTimer = null;
    startRecordingFrameScan(state);
  }, delay);
  if (typeof state.recordingFrameTimer.unref === "function") {
    state.recordingFrameTimer.unref();
  }
}

function queueRecordingFrame(state: SessionState, data: string): void {
  if (!browserRecordingDemand(state.id)) return;
  state.pendingRecordingFrame = {
    data,
    navigationGeneration: state.recordingNavigationGeneration,
  };
  scheduleRecordingFrameScan(state);
}

function invalidateRecordingFramesForNavigation(state: SessionState): void {
  state.recordingNavigationGeneration += 1;
  state.pendingRecordingFrame = null;
}

/** Test seam for the CDP main-frame navigation invalidation boundary. */
export function invalidateBrowserRecordingFramesForNavigationForTests(sessionId: string): void {
  invalidateRecordingFramesForNavigation(ensureState(sessionId));
}

export async function flushBrowserRecordingFrameScans(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (state?.recordingFrameTimer) clearTimeout(state.recordingFrameTimer);
  if (state) {
    state.recordingFrameTimer = null;
    state.pendingRecordingFrame = null;
  }
  await state?.recordingFrameTask?.catch(() => undefined);
}

/** Test seam for exercising recorder intake without a real CDP transport. */
export function queueBrowserRecordingFrameForTests(sessionId: string, data: string): void {
  queueRecordingFrame(ensureState(sessionId), data);
}

async function startScreencast(state: SessionState): Promise<void> {
  if (state.screencasting) return;
  const runtime = getRuntime(state.id);
  if (!runtime) return;
  const cdp = runtime.cdp as {
    send: (m: string, p?: unknown) => Promise<unknown>;
    on: (ev: string, cb: (e: unknown) => void) => void;
  } | null;
  if (!cdp) return;

  // Wire the frame listener once per runtime; it stays attached for the
  // lifetime of the CDP session and we toggle screencasting via
  // start/stop.
  if (!cdpListenerAttached.has(state.id)) {
    cdp.on("Page.frameNavigated", () => {
      // A pending JPEG contains the full viewport, including child frames. Any
      // document replacement can destroy an evaluate context while its old
      // pixels are queued, so invalidate the whole JPEG and scan the next one.
      invalidateRecordingFramesForNavigation(state);
    });
    cdp.on("Page.frameDetached", () => {
      // Normal widget/ad removal has the same destroyed-context race as a
      // navigation. Its old pixels cannot be verified against the settled DOM.
      invalidateRecordingFramesForNavigation(state);
    });
    cdp.on("Page.screencastFrame", (event) => {
      const ev = event as {
        sessionId: string;
        data: string;
        metadata: NonNullable<Extract<LiveMessage, { type: "frame" }>["metadata"]>;
      };
      const id = ++state.frameCounter;
      const msg: LiveMessage = { type: "frame", frameId: id, data: ev.data, metadata: ev.metadata };
      state.lastFrame = msg;
      queueRecordingFrame(state, ev.data);
      if (state.viewers.size === 0) {
        // No viewers — ack the frame to CDP immediately so Chromium doesn't
        // pile up a backlog on a frame nobody's drawing.
        cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {
          /* ignore */
        });
        return;
      }
      const timer = setTimeout(() => ackCdpFrame(state, id), ACK_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      state.pendingCdpAcks.set(id, { cdpSessionId: ev.sessionId, timer });
      broadcastToViewers(state, msg);
    });
    cdpListenerAttached.add(state.id);
  }

  try {
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: state.viewportWidth,
      maxHeight: state.viewportHeight,
      everyNthFrame: 1,
    });
    state.screencasting = true;
  } catch {
    // ignore — Chromium may have just been torn down
  }
}

async function stopScreencast(state: SessionState): Promise<void> {
  if (!state.screencasting) return;
  const runtime = getRuntime(state.id);
  state.screencasting = false;
  clearPendingAcks(state);
  if (!runtime) return;
  const cdp = runtime.cdp as { send: (m: string, p?: unknown) => Promise<unknown> } | null;
  if (!cdp) return;
  try {
    await cdp.send("Page.stopScreencast");
  } catch {
    // ignore
  }
}

const cdpListenerAttached = new Set<string>();

// ---------- hub: viewer-side socket ----------

export function attachViewerSocket(args: {
  sessionId: string;
  companyId: string;
  employeeId: string;
  runId: string | null;
  ws: WebSocket;
  userId: string;
}): void {
  const { sessionId, companyId, employeeId, runId, ws, userId } = args;
  const state = ensureState(sessionId);
  state.companyId = companyId;
  state.employeeId = employeeId;
  state.runId = runId;
  const viewer: ViewerSocket = { ws, userId, takeover: false };
  const wasEmpty = state.viewers.size === 0;
  state.viewers.add(viewer);

  // Suspend Chromium's idle timer while a viewer is watching — even if
  // the agent has finished its turn, we don't want the browser to die
  // from under the human's cursor.
  holdRuntime(sessionId);

  const hello: LiveMessage = {
    type: "hello",
    sessionId,
    viewportWidth: state.viewportWidth,
    viewportHeight: state.viewportHeight,
    pageUrl: state.pageUrl,
    pageTitle: state.pageTitle,
  };
  sendToWs(ws, hello);

  // Replay the last frame so a viewer joining mid-stream sees the page
  // immediately instead of a blank canvas until the next repaint. It may
  // already have been acked to CDP; the ack this viewer sends back is then a
  // no-op, which is exactly what we want.
  if (state.lastFrame) sendToWs(ws, state.lastFrame);

  broadcastViewerCount(state);

  if (wasEmpty) {
    void startScreencast(state);
  }

  ws.on("message", (raw) => {
    let msg: LiveMessage | null = null;
    try {
      msg = JSON.parse(String(raw)) as LiveMessage;
    } catch {
      return;
    }
    handleViewerMessage(state, viewer, msg).catch(() => {
      // ignore
    });
  });

  ws.on("close", () => {
    state.viewers.delete(viewer);
    broadcastViewerCount(state);
    releaseRuntime(sessionId);
    if (!shouldScreencast(state)) {
      void stopScreencast(state);
    }
  });

  ws.on("error", () => {
    // Let close handler clean up.
  });
}

async function handleViewerMessage(
  state: SessionState,
  viewer: ViewerSocket,
  msg: LiveMessage,
): Promise<void> {
  if (msg.type === "frame.ack") {
    ackCdpFrame(state, msg.frameId);
    return;
  }
  if (msg.type === "control.takeover") {
    viewer.takeover = !!msg.takeover;
    return;
  }
  if (
    msg.type !== "control.navigate" &&
    msg.type !== "control.history" &&
    msg.type !== "input.mouse" &&
    msg.type !== "input.key"
  ) {
    return;
  }
  if (!viewer.takeover) return;
  if (
    msg.type === "control.history" &&
    msg.action !== "back" &&
    msg.action !== "forward" &&
    msg.action !== "reload"
  ) {
    return;
  }

  const releaseActivity = beginBrowserRpcActivity({
    id: state.id,
    companyId: state.companyId,
    runId: state.runId,
  });
  if (!releaseActivity) {
    if (msg.type === "control.navigate" || msg.type === "control.history") {
      sendToWs(viewer.ws, {
        type: "nav.error",
        message: "This Run is finalizing; browser control is closed.",
      });
    }
    return;
  }
  try {
    // Install the sticky observer before a take-over action can create a
    // transient password field, then start (or resume) the Run recorder under
    // the same pre-finalization lease.
    await observeRuntimePasswordValues(state.id, {
      failClosedIfUnavailable: state.runId !== null,
    });
    await markSessionLive(state.id, { allowFinalizingRun: true });
    if (msg.type === "control.navigate") {
      await navigateFromViewer(state, viewer, msg.url);
      return;
    }
    if (msg.type === "control.history") {
      await historyFromViewer(state, viewer, msg.action);
      return;
    }

    markActivity(state.id);
    const runtime = getRuntime(state.id);
    if (!runtime) return;
    const cdp = runtime.cdp as { send: (m: string, p?: unknown) => Promise<unknown> } | null;
    if (!cdp) return;
    // Capture every current password value before a human click can toggle a
    // field to plain text. The browser RPC layer keeps these values redacted
    // for the full session and clears them through the teardown hook above.
    await observeRuntimePasswordValues(state.id, {
      failClosedIfUnavailable: state.runId !== null,
    });
    if (msg.type === "input.mouse") {
      try {
        await cdp.send("Input.dispatchMouseEvent", {
          type: msg.action,
          x: msg.x,
          y: msg.y,
          button: msg.button ?? "none",
          buttons: msg.buttons ?? 0,
          clickCount: msg.clickCount ?? 0,
          deltaX: msg.deltaX ?? 0,
          deltaY: msg.deltaY ?? 0,
          modifiers: msg.modifiers ?? 0,
        });
        await observeRuntimePasswordValues(state.id, {
          failClosedIfUnavailable: state.runId !== null,
        });
      } catch {
        /* ignore */
      }
    } else {
      try {
        await cdp.send("Input.dispatchKeyEvent", {
          type: msg.action,
          key: msg.key,
          code: msg.code,
          text: msg.text,
          unmodifiedText: msg.text,
          modifiers: msg.modifiers ?? 0,
          windowsVirtualKeyCode: msg.windowsVirtualKeyCode,
        });
        // Key input may have changed the focused password field. Capture the
        // resulting full value, not only the individual key event text.
        await observeRuntimePasswordValues(state.id, {
          failClosedIfUnavailable: state.runId !== null,
        });
      } catch {
        /* ignore */
      }
    }
  } finally {
    releaseActivity();
  }
}

function sessionCdp(
  sessionId: string,
): { send: (m: string, p?: unknown) => Promise<unknown> } | null {
  const runtime = getRuntime(sessionId);
  return (runtime?.cdp as { send: (m: string, p?: unknown) => Promise<unknown> } | null) ?? null;
}

/**
 * Whether a human who has taken control may send this browser to `url`.
 *
 * Take-over is a way to finish a step the model cannot — a captcha, a 2FA
 * prompt — not a way around the host policy the company set. It is still the
 * employee's browser, carrying the employee's cookies, so the address bar
 * answers to exactly the same two allow lists `browser_open` does. Re-read per
 * navigation rather than snapshotted, for the same reason every other browser
 * check is: revoking access has to bite the session already open.
 */
async function viewerNavigationAllowed(
  state: SessionState,
  url: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: state.employeeId,
  });
  if (!employee) return { ok: false, reason: "This AI Employee no longer exists." };
  const byEmployee = urlAllowed(url, parseAllowList(employee.browserAllowedHosts));
  if (!byEmployee.ok) return byEmployee;

  const row = await AppDataSource.getRepository(BrowserSession).findOneBy({ id: state.id });
  if (!row?.memberBrowserId) return { ok: true };
  const browser = await AppDataSource.getRepository(MemberBrowser).findOneBy({
    id: row.memberBrowserId,
  });
  if (!browser) return { ok: false, reason: "That browser is no longer connected." };
  return memberBrowserUrlAllowed(url, browser, (candidate, allowList) =>
    urlAllowed(candidate, allowList),
  );
}

/** Address-bar navigation from a viewer holding control. */
async function navigateFromViewer(
  state: SessionState,
  viewer: ViewerSocket,
  rawUrl: string,
): Promise<void> {
  const normalized = normalizeViewerNavigationUrl(String(rawUrl ?? ""));
  if (!normalized.ok) {
    sendToWs(viewer.ws, { type: "nav.error", message: normalized.reason });
    return;
  }
  const verdict = await viewerNavigationAllowed(state, normalized.url);
  if (!verdict.ok) {
    sendToWs(viewer.ws, { type: "nav.error", message: verdict.reason });
    return;
  }
  const cdp = sessionCdp(state.id);
  if (!cdp) {
    sendToWs(viewer.ws, { type: "nav.error", message: "The browser is no longer running." });
    return;
  }
  markActivity(state.id);
  // Last chance to see what the page held: navigating destroys it, and the
  // redaction listeners have to keep covering anything typed into it.
  await observeRuntimePasswordValues(state.id, {
    failClosedIfUnavailable: state.runId !== null,
  });
  try {
    // `Page.navigate` rather than Playwright's `page.goto` — this returns as
    // soon as the load is committed, so the viewer's toolbar doesn't sit dead
    // for the length of a slow page. The nav mirror on the page's
    // `framenavigated` listener updates the address bar when it lands.
    const result = (await cdp.send("Page.navigate", { url: normalized.url })) as {
      errorText?: string;
    };
    // A load that never starts — bad DNS, refused connection — comes back as a
    // result, not a rejection. Silence there reads as a broken address bar.
    if (result?.errorText) {
      sendToWs(viewer.ws, {
        type: "nav.error",
        message: `Couldn't open that page: ${result.errorText}`,
      });
    }
  } catch {
    sendToWs(viewer.ws, { type: "nav.error", message: "That page could not be opened." });
  }
}

/** Back / forward / reload from the viewer's toolbar. */
async function historyFromViewer(
  state: SessionState,
  viewer: ViewerSocket,
  action: "back" | "forward" | "reload",
): Promise<void> {
  const cdp = sessionCdp(state.id);
  if (!cdp) {
    sendToWs(viewer.ws, { type: "nav.error", message: "The browser is no longer running." });
    return;
  }
  markActivity(state.id);
  await observeRuntimePasswordValues(state.id, {
    failClosedIfUnavailable: state.runId !== null,
  });
  try {
    if (action === "reload") {
      await cdp.send("Page.reload", {});
      return;
    }
    const history = (await cdp.send("Page.getNavigationHistory")) as {
      currentIndex: number;
      entries: Array<{ id: number; url: string }>;
    };
    const target = history.entries[history.currentIndex + (action === "back" ? -1 : 1)];
    if (!target) {
      sendToWs(viewer.ws, {
        type: "nav.error",
        message: action === "back" ? "Nothing to go back to." : "Nothing to go forward to.",
      });
      return;
    }
    // The entry was allowed when it was first opened, but the list may have
    // been tightened since, and history is a way back to a host the company
    // has since removed.
    const verdict = await viewerNavigationAllowed(state, target.url);
    if (!verdict.ok) {
      sendToWs(viewer.ws, { type: "nav.error", message: verdict.reason });
      return;
    }
    await cdp.send("Page.navigateToHistoryEntry", { entryId: target.id });
  } catch {
    sendToWs(viewer.ws, { type: "nav.error", message: "That navigation could not be performed." });
  }
}

async function reportPasswordPresence(sessionId: string): Promise<void> {
  await restrictBrowserRecording(sessionId).catch(() => undefined);
  for (const listener of sensitiveValueListeners) {
    try {
      await listener(sessionId, "", "password-present");
    } catch {
      // Recording/redaction remains auxiliary to browser work.
    }
  }
}

async function searchCdpForPassword(cdp: PasswordCdpSession): Promise<boolean | null> {
  let searchId: string | null = null;
  try {
    const result = (await cdp.send("DOM.performSearch", {
      query: 'input[type="password"]',
      includeUserAgentShadowDOM: true,
    })) as { searchId: string; resultCount: number };
    searchId = result.searchId;
    return result.resultCount > 0;
  } catch {
    return null;
  } finally {
    if (searchId) {
      await cdp.send("DOM.discardSearchResults", { searchId }).catch(() => undefined);
    }
  }
}

async function ensurePasswordDomGuard(
  sessionId: string,
  cdp: PasswordCdpSession,
): Promise<boolean> {
  let state = passwordDomGuardStates.get(cdp as object);
  if (state) {
    if (state.refresh) await state.refresh;
    if (state.enabled && state.ready) return true;
  } else {
    state = {
      closedTreeNodeIds: new Set(),
      enabled: false,
      generation: 0,
      listenersInstalled: false,
      ready: false,
      refresh: null,
    };
    passwordDomGuardStates.set(cdp as object, state);
  }
  const guardState = state;
  const noteDomMutation = () => {
    guardState.generation += 1;
    guardState.ready = false;
    const recordingState = sessions.get(sessionId);
    if (recordingState) invalidateRecordingFramesForNavigation(recordingState);
  };
  const nodeHasPassword = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    const candidate = node as {
      nodeName?: string;
      nodeId?: number;
      shadowRootType?: string;
      attributes?: string[];
      children?: unknown[];
      shadowRoots?: unknown[];
      pseudoElements?: unknown[];
      contentDocument?: unknown;
    };
    const insideClosedTree =
      candidate.shadowRootType === "closed" ||
      (candidate.nodeId !== undefined && guardState.closedTreeNodeIds.has(candidate.nodeId));
    if (insideClosedTree && candidate.nodeId !== undefined) {
      guardState.closedTreeNodeIds.add(candidate.nodeId);
    }
    if (candidate.nodeName?.toUpperCase() === "INPUT") {
      const attributes = candidate.attributes ?? [];
      for (let index = 0; index + 1 < attributes.length; index += 2) {
        if (
          attributes[index]?.toLowerCase() === "type" &&
          attributes[index + 1]?.toLowerCase() === "password"
        ) {
          return true;
        }
      }
    }
    for (const collection of [
      candidate.children,
      candidate.shadowRoots,
      candidate.pseudoElements,
    ]) {
      if (
        collection?.some((child) => {
          if (
            insideClosedTree &&
            child &&
            typeof child === "object" &&
            "nodeId" in child &&
            typeof child.nodeId === "number"
          ) {
            guardState.closedTreeNodeIds.add(child.nodeId);
          }
          return nodeHasPassword(child);
        })
      ) {
        return true;
      }
    }
    return nodeHasPassword(candidate.contentDocument);
  };
  const refreshTree = (): Promise<boolean> => {
    if (guardState.refresh) return guardState.refresh;
    const generation = guardState.generation;
    const refresh = (async () => {
      try {
        const result = (await cdp.send("DOM.getDocument", {
          depth: -1,
          pierce: true,
        })) as { root?: unknown };
        if (nodeHasPassword(result.root)) await reportPasswordPresence(sessionId);
        if (guardState.generation === generation) guardState.ready = true;
        return guardState.generation === generation;
      } catch {
        guardState.ready = false;
        return false;
      }
    })().finally(() => {
      if (guardState.refresh === refresh) guardState.refresh = null;
    });
    guardState.refresh = refresh;
    return refresh;
  };
  const verifyMutation = (nodeId?: number): Promise<boolean> => {
    if (guardState.refresh) return guardState.refresh;
    const generation = guardState.generation;
    const refresh = (async () => {
      try {
        if (nodeId) {
          await cdp.send("DOM.requestChildNodes", { nodeId, depth: -1, pierce: true });
        }
        const present = await searchCdpForPassword(cdp);
        if (present) await reportPasswordPresence(sessionId);
        if (present === null || guardState.generation !== generation) return false;
        guardState.ready = true;
        return true;
      } catch {
        guardState.ready = false;
        return false;
      }
    })().finally(() => {
      if (guardState.refresh === refresh) guardState.refresh = null;
    });
    guardState.refresh = refresh;
    return refresh;
  };
  const scanSoon = (
    delays: number[],
    options: { refreshDocument?: boolean; nodeId?: number } = {},
  ) => {
    const generation = guardState.generation;
    for (const delay of delays) {
      const timer = setTimeout(() => {
        // The first successful scan proves this generation. Later retries are
        // only fallbacks for parser/navigation timing, not repeated full-tree
        // snapshots. A newer mutation schedules its own generation of work.
        if (guardState.generation !== generation || guardState.ready) return;
        void (options.refreshDocument ? refreshTree() : verifyMutation(options.nodeId));
      }, delay);
      if (typeof timer.unref === "function") timer.unref();
    }
  };
  try {
    if (!guardState.listenersInstalled) {
      // DOM events make transient parser/shadow changes sticky between the 4fps
      // JPEG checks. The native protocol cannot be replaced by page JavaScript.
      cdp.on("DOM.documentUpdated", () => {
        guardState.closedTreeNodeIds.clear();
        noteDomMutation();
        scanSoon([0, 25, 100, 250], { refreshDocument: true });
      });
      cdp.on("DOM.shadowRootPushed", (payload) => {
        const root = (payload as { root?: { nodeId?: number; shadowRootType?: string } }).root;
        if (root?.shadowRootType !== "closed") return;
        if (root.nodeId !== undefined) guardState.closedTreeNodeIds.add(root.nodeId);
        noteDomMutation();
        const rootId = root.nodeId;
        scanSoon([0, 25], { nodeId: rootId });
      });
      cdp.on("DOM.shadowRootPopped", (payload) => {
        const rootId = (payload as { rootId?: number }).rootId;
        if (rootId === undefined || !guardState.closedTreeNodeIds.has(rootId)) return;
        noteDomMutation();
        guardState.closedTreeNodeIds.delete(rootId);
        scanSoon([0]);
      });
      cdp.on("DOM.childNodeInserted", (payload) => {
        const event = payload as {
          parentNodeId?: number;
          node?: {
            nodeId?: number;
            nodeName?: string;
            attributes?: string[];
            childNodeCount?: number;
          };
        };
        const node = event.node;
        const insideClosedTree =
          event.parentNodeId !== undefined && guardState.closedTreeNodeIds.has(event.parentNodeId);
        if (insideClosedTree && node?.nodeId !== undefined) {
          guardState.closedTreeNodeIds.add(node.nodeId);
        }
        if (insideClosedTree) noteDomMutation();
        if (node?.nodeName?.toUpperCase() === "INPUT") {
          const attributes = node.attributes ?? [];
          for (let index = 0; index + 1 < attributes.length; index += 2) {
            if (
              attributes[index]?.toLowerCase() === "type" &&
              attributes[index + 1]?.toLowerCase() === "password"
            ) {
              void reportPasswordPresence(sessionId);
              break;
            }
          }
        }
        if (insideClosedTree) {
          scanSoon([0, 25], {
            nodeId: node?.childNodeCount ? node.nodeId : undefined,
          });
        }
      });
      cdp.on("DOM.childNodeRemoved", (payload) => {
        const event = payload as { parentNodeId?: number; nodeId?: number };
        if (
          event.parentNodeId === undefined ||
          !guardState.closedTreeNodeIds.has(event.parentNodeId)
        ) {
          return;
        }
        noteDomMutation();
        if (event.nodeId !== undefined) guardState.closedTreeNodeIds.delete(event.nodeId);
        scanSoon([0]);
      });
      cdp.on("DOM.attributeModified", (payload) => {
        const event = payload as { nodeId?: number; name?: string; value?: string };
        const becamePassword =
          event.name?.toLowerCase() === "type" && event.value?.toLowerCase() === "password";
        if (becamePassword) void reportPasswordPresence(sessionId);
        if (event.nodeId !== undefined && guardState.closedTreeNodeIds.has(event.nodeId)) {
          noteDomMutation();
          scanSoon([0]);
        }
      });
      cdp.on("DOM.setChildNodes", (payload) => {
        const event = payload as {
          parentId?: number;
          nodes?: unknown[];
        };
        if (event.parentId === undefined || !guardState.closedTreeNodeIds.has(event.parentId)) {
          return;
        }
        for (const entry of event.nodes ?? []) {
          if (
            entry &&
            typeof entry === "object" &&
            "nodeId" in entry &&
            typeof entry.nodeId === "number"
          ) {
            guardState.closedTreeNodeIds.add(entry.nodeId);
          }
          if (nodeHasPassword(entry)) void reportPasswordPresence(sessionId);
        }
      });
      guardState.listenersInstalled = true;
    }
    if (!guardState.enabled) {
      await cdp.send("DOM.enable");
      guardState.enabled = true;
    }
    return refreshTree();
  } catch {
    guardState.ready = false;
    return false;
  }
}

async function collectPasswordCdpTargets(
  page: {
    context?: () => {
      newCDPSession?: (target: unknown) => Promise<PasswordCdpSession>;
    };
    frames: () => unknown[];
    mainFrame?: () => unknown;
  },
  mainCdp: PasswordCdpSession | null,
): Promise<{
  targets: Array<{ cdp: PasswordCdpSession; frame: object | null }>;
  complete: boolean;
}> {
  const targets: Array<{ cdp: PasswordCdpSession; frame: object | null }> = [];
  let complete = true;
  if (mainCdp) targets.push({ cdp: mainCdp, frame: null });
  else complete = false;

  const context = page.context?.();
  const createSession = context?.newCDPSession;
  const mainFrame = page.mainFrame?.();
  if (!createSession || !mainFrame) return { targets, complete };
  for (const frame of page.frames()) {
    if (!frame || frame === mainFrame || typeof frame !== "object") continue;
    if (passwordParentCoveredFrames.has(frame)) continue;
    let cdp = passwordFrameCdpSessions.get(frame);
    if (!cdp) {
      try {
        cdp = await createSession.call(context, frame);
        passwordFrameCdpSessions.set(frame, cdp);
      } catch (error) {
        // Same-process frames are included by the page session. Any other
        // failure leaves an OOPIF renderer unverified and drops/fails closed.
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("part of the parent frame's session")) {
          passwordParentCoveredFrames.add(frame);
          continue;
        }
        complete = false;
        continue;
      }
    }
    targets.push({ cdp, frame });
  }
  return { targets, complete };
}

type PasswordObservationOptions = {
  failClosedIfUnavailable?: boolean;
  /** Drop an unverified screencast frame instead of classifying navigation as sensitive. */
  discardIfUnavailable?: boolean;
};

export async function observeRuntimePasswordValues(
  sessionId: string,
  opts?: PasswordObservationOptions,
): Promise<boolean> {
  const runtime = passwordObservationRuntime(sessionId) as
    | { page?: unknown; cdp?: unknown }
    | null
    | undefined;
  const page = runtime?.page as
    | {
        addInitScript?: (script: { content: string }) => Promise<void>;
        frames: () => Array<{
          evaluate: {
            <T>(expression: string): Promise<T>;
            <T, Arg>(fn: (arg: Arg) => T | Promise<T>, arg: Arg): Promise<T>;
          };
        }>;
        mainFrame?: () => unknown;
        context?: () => {
          addInitScript?: (script: { content: string }) => Promise<void>;
          newCDPSession?: (target: unknown) => Promise<PasswordCdpSession>;
        };
        on?: (event: string, callback: (message: unknown) => void) => void;
        url?: () => string;
      }
    | null
    | undefined;
  if (!page) {
    if (opts?.failClosedIfUnavailable && !opts.discardIfUnavailable) {
      await restrictBrowserRecording(sessionId).catch(() => undefined);
    }
    return false;
  }
  let fullyObserved = true;
  const installInCurrentDocuments = !passwordTaintInstalledPages.has(page as object);
  if (installInCurrentDocuments) {
    try {
      const context = page.context?.();
      if (!context?.addInitScript && !page.addInitScript) {
        throw new Error("Browser init scripts are unavailable");
      }
      if (!page.on) throw new Error("Page console events are unavailable");
      const pendingChallenges = new Map<string, () => void>();
      page.on("console", (rawMessage) => {
        const message = rawMessage as { text?: () => string; type?: () => string };
        let text = "";
        let type = "";
        try {
          text = message.text?.() ?? "";
          type = message.type?.() ?? "";
        } catch {
          return;
        }
        if (type !== "debug") return;
        const resolveChallenge = pendingChallenges.get(text);
        if (resolveChallenge) {
          resolveChallenge();
          return;
        }
        if (text === passwordTaintSignal) void reportPasswordPresence(sessionId);
      });
      if (!passwordFrameLifecycleInstalledPages.has(page as object)) {
        const forget = (frame: unknown) => {
          if (frame && typeof frame === "object") forgetPasswordFrame(frame);
        };
        page.on("framenavigated", forget);
        page.on("framedetached", forget);
        passwordFrameLifecycleInstalledPages.add(page as object);
      }

      // Context-level installation covers future popups before their first
      // script. The Page fallback still protects the current tab on runtimes
      // that do not expose BrowserContext.addInitScript; such a future popup
      // then fails the require-existing challenge closed.
      const initScript = {
        content: passwordTaintScript({
          key: passwordTaintKey,
          probeKey: passwordTaintProbeKey,
          signal: passwordTaintSignal,
          challenge: null,
        }),
      };
      const contextWasPrearmed = Boolean(
        context && passwordTaintInstalledContexts.has(context as object),
      );
      if (context?.addInitScript) {
        if (!contextWasPrearmed) {
          await context.addInitScript(initScript);
          passwordTaintInstalledContexts.add(context as object);
        }
      } else {
        await page.addInitScript!(initScript);
      }
      let stickyAtInstall: boolean[] | null = null;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const installFrames = page.frames();
        if (installFrames.length === 0) throw new Error("Page frames are unavailable");
        const currentUrl = page.url?.() ?? "about:blank";
        const blankPage =
          currentUrl === "" || currentUrl === "about:blank" || currentUrl === "chrome://newtab/";
        // Only the first App-created blank page may install late. A popup or
        // later tab in a pre-armed context must prove its observer ran at
        // document start, even while its initial blank document is navigating.
        const requireExisting = contextWasPrearmed || !blankPage;
        const challenges = installFrames.map(() => crypto.randomBytes(16).toString("hex"));
        const responses = challenges.map(
          (challenge) => `${passwordTaintSignal}:probe:${challenge}`,
        );
        let allChallengesReceived!: () => void;
        const challengeBarrier = new Promise<void>((resolve) => {
          allChallengesReceived = resolve;
        });
        for (const response of responses) {
          pendingChallenges.set(response, () => {
            pendingChallenges.delete(response);
            if (responses.every((candidate) => !pendingChallenges.has(candidate))) {
              allChallengesReceived();
            }
          });
        }
        let challengeTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          const result = await Promise.all(
            installFrames.map((frame, index) =>
              frame.evaluate<boolean>(
                passwordTaintScript({
                  key: passwordTaintKey,
                  probeKey: passwordTaintProbeKey,
                  requireExisting,
                  signal: passwordTaintSignal,
                  challenge: challenges[index]!,
                }),
              ),
            ),
          );
          if (!result.some(Boolean)) {
            await Promise.race([
              challengeBarrier,
              new Promise<never>((_resolve, reject) => {
                challengeTimer = setTimeout(
                  () => reject(new Error("Password observer console handshake timed out")),
                  500,
                );
              }),
            ]);
          }
          stickyAtInstall = result;
          break;
        } catch (error) {
          if (attempt === 7) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        } finally {
          if (challengeTimer) clearTimeout(challengeTimer);
          for (const response of responses) pendingChallenges.delete(response);
        }
      }
      if (!stickyAtInstall) throw new Error("Password observer could not inspect the page");
      if (stickyAtInstall.some(Boolean)) await reportPasswordPresence(sessionId);
      passwordTaintInstalledPages.add(page as object);
    } catch {
      // A current scan alone cannot prove that a password did not render and
      // disappear between screencast frames. Without the navigation-persistent
      // observer, withhold any Run recording while retaining ordinary browser
      // behavior and the best-effort model-output scan below.
      fullyObserved = false;
      await restrictBrowserRecording(sessionId).catch(() => undefined);
    }
  }
  let frames: ReturnType<typeof page.frames>;
  try {
    frames = page.frames();
  } catch {
    if (opts?.failClosedIfUnavailable && !opts.discardIfUnavailable) {
      // Losing the ability to inspect the final page is privacy-relevant at a
      // terminal boundary. Per-frame callers instead discard that JPEG.
      await restrictBrowserRecording(sessionId).catch(() => undefined);
      for (const listener of sensitiveValueListeners) {
        try {
          await listener(sessionId, "", "password-present");
        } catch {
          // Recording/redaction remains auxiliary to browser teardown.
        }
      }
    }
    return false;
  }
  if (frames.length === 0) {
    if (opts?.failClosedIfUnavailable && !opts.discardIfUnavailable) {
      await restrictBrowserRecording(sessionId).catch(() => undefined);
    }
    return false;
  }
  const observations = await Promise.all(
    frames.map(async (frame) => {
      const attempts = opts?.discardIfUnavailable ? 1 : 8;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const observation = await frame.evaluate((key) => {
            const passwordInputs: HTMLInputElement[] = [];
            const visit = (root: Document | ShadowRoot) => {
              for (const element of root.querySelectorAll("*")) {
                if (element instanceof HTMLInputElement && element.type === "password") {
                  passwordInputs.push(element);
                }
                if (element.shadowRoot) visit(element.shadowRoot);
              }
            };
            visit(document);
            const checker = (globalThis as typeof globalThis & Record<string, unknown>)[key];
            let passwordEverObserved = true;
            if (typeof checker === "function") {
              try {
                passwordEverObserved = checker() === true;
              } catch {
                passwordEverObserved = true;
              }
            }
            let active = document.activeElement;
            while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
            return {
              passwordPresent: passwordEverObserved || passwordInputs.length > 0,
              passwordValues: passwordInputs.map((input) => input.value).filter(Boolean),
              activeInputValue:
                active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
                  ? active.value
                  : null,
            };
          }, passwordTaintKey);
          return {
            ...observation,
            unavailable: false,
          };
        } catch {
          if (attempt + 1 < attempts) {
            await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
          }
        }
      }
      return {
        passwordPresent: true,
        passwordValues: [] as string[],
        activeInputValue: null as string | null,
        unavailable: true,
      };
    }),
  );

  // JavaScript cannot enumerate declarative closed shadow roots. Search each
  // renderer through CDP before accepting a JPEG; successful OOPIF sessions
  // are cached, while same-process frames remain covered by the page session.
  const frameSnapshot = [...frames];
  const mainCdp =
    runtime?.cdp && typeof runtime.cdp === "object" ? (runtime.cdp as PasswordCdpSession) : null;
  const cdpTargets = await collectPasswordCdpTargets(page, mainCdp);
  if (!cdpTargets.complete) fullyObserved = false;
  for (const target of cdpTargets.targets) {
    const attempts = opts?.discardIfUnavailable ? 1 : 8;
    let passwordPresent: boolean | null = null;
    let targetCdp = target.cdp;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await ensurePasswordDomGuard(sessionId, targetCdp)) {
        passwordPresent = await searchCdpForPassword(targetCdp);
        if (passwordPresent !== null) break;
      }
      if (target.frame) {
        forgetPasswordFrame(target.frame);
        try {
          const context = page.context?.();
          const createSession = context?.newCDPSession;
          if (!createSession) throw new Error("Frame CDP sessions are unavailable");
          targetCdp = await createSession.call(context, target.frame);
          passwordFrameCdpSessions.set(target.frame, targetCdp);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("part of the parent frame's session") && mainCdp) {
            passwordParentCoveredFrames.add(target.frame);
            passwordPresent = await searchCdpForPassword(mainCdp);
            if (passwordPresent !== null) break;
          }
        }
      }
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
    if (passwordPresent === null) {
      fullyObserved = false;
      if (target.frame) forgetPasswordFrame(target.frame);
      continue;
    }
    if (passwordPresent) {
      await reportPasswordPresence(sessionId);
    }
  }
  try {
    const framesAfterSearch = page.frames();
    if (
      framesAfterSearch.length !== frameSnapshot.length ||
      framesAfterSearch.some((frame, index) => frame !== frameSnapshot[index])
    ) {
      fullyObserved = false;
    }
  } catch {
    fullyObserved = false;
  }

  for (const observation of observations) {
    if (observation.unavailable) {
      fullyObserved = false;
      continue;
    }
    if (observation.passwordPresent) {
      await reportPasswordPresence(sessionId);
    }
    for (const listener of sensitiveValueListeners) {
      try {
        for (const value of observation.passwordValues) {
          await listener(sessionId, value, "password-value");
        }
        if (observation.activeInputValue) {
          await listener(sessionId, observation.activeInputValue, "active-input-value");
        }
      } catch {
        // Human input must continue even if a redaction extension failed.
      }
    }
  }
  if (!fullyObserved && opts?.failClosedIfUnavailable && !opts.discardIfUnavailable) {
    await reportPasswordPresence(sessionId);
  }
  return fullyObserved;
}

/**
 * Finalize every browser recording belonging to a Run. A last password scan
 * happens while the runtime still exists so a terminal navigation to a login
 * page cannot leave its final frame on disk. Every failure is returned as a
 * log warning; it never changes the Run verdict or retry policy.
 */
export async function finalizeBrowserRecordingsForRun(runId: string): Promise<string[]> {
  // Install before the first await: a BrowserSession create already in flight
  // will fail its post-save check, while future creates/begins are refused.
  markBrowserRecordingRunFinalizing(runId);
  const processed = new Set<string>();
  for (let pass = 0; pass < 2; pass += 1) {
    const rows = (
      await AppDataSource.getRepository(BrowserSession).find({
        where: { runId },
        order: { createdAt: "ASC", id: "ASC" },
      })
    ).filter((row) => !processed.has(row.id));
    // `markBrowserRecordingRunFinalizing` prevents new handlers from entering.
    // Drain leases that won the boundary first so their last navigation/frame
    // remains part of the recording and their side effects cannot outlive the
    // terminal Run row.
    await Promise.all(rows.map((row) => waitForBrowserRpcActivity(row.id)));
    const finalScanRequired = new Set(
      rows.filter((row) => browserRecordingDemand(row.id)).map((row) => row.id),
    );
    for (const row of rows) freezeBrowserRecording(row.id);
    await Promise.all(rows.map((row) => flushBrowserRecordingFrameScans(row.id)));
    await Promise.all(
      rows.map(async (row) => {
        try {
          await observeRuntimePasswordValues(row.id, {
            failClosedIfUnavailable: finalScanRequired.has(row.id),
          });
        } catch {
          await restrictBrowserRecording(row.id).catch(() => undefined);
        }
        try {
          await finishBrowserRecording(row);
        } catch {
          // Recording is auxiliary. Authorized metadata exposes a terminal
          // state; shared Run logs must not reveal recording existence.
        }
        const state = sessions.get(row.id);
        if (state && !shouldScreencast(state)) await stopScreencast(state);
        if (getRuntime(row.id)) {
          await releasePage(row.id, "manual").catch(() => undefined);
        } else {
          await closeBrowserSession(row.id, "manual").catch(() => undefined);
        }
        processed.add(row.id);
      }),
    );
  }
  return [];
}

function broadcastViewerCount(state: SessionState): void {
  broadcastToViewers(state, { type: "viewers", count: state.viewers.size });
}

// ---------- helpers ----------

function ensureState(sessionId: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      id: sessionId,
      companyId: "",
      employeeId: "",
      runId: null,
      viewers: new Set(),
      pendingCdpAcks: new Map(),
      lastFrame: null,
      pageUrl: "",
      pageTitle: null,
      viewportWidth: BROWSER_WINDOW_WIDTH,
      viewportHeight: BROWSER_WINDOW_HEIGHT,
      screencasting: false,
      frameCounter: 0,
      pendingRecordingFrame: null,
      recordingFrameTask: null,
      recordingFrameTimer: null,
      lastRecordingFrameScanAt: 0,
      recordingNavigationGeneration: 0,
    };
    sessions.set(sessionId, state);
  }
  return state;
}

/**
 * Adopt the real size of a browser we do not own.
 *
 * The App starts its own Chromium at the configured desktop window size. A
 * Member's browser is whatever size their screen made it, and getting this
 * wrong is not cosmetic: the screencast would be captured with the wrong
 * `maxWidth`/`maxHeight` caps (so the frame is downscaled and the text is
 * permanently soft), and the viewer scales take-over clicks by
 * `viewportWidth / rect.width` — with a stale width, a click near the right
 * edge lands hundreds of pixels away from where the human aimed it.
 *
 * The viewer does self-correct from the first frame's metadata, but frames
 * only arrive on repaint, so an idle page never sends one.
 */
export async function setSessionViewport(
  sessionId: string,
  width: number,
  height: number,
): Promise<void> {
  const state = ensureState(sessionId);
  if (state.viewportWidth === width && state.viewportHeight === height) return;
  state.viewportWidth = width;
  state.viewportHeight = height;
  await AppDataSource.getRepository(BrowserSession).update(
    { id: sessionId },
    { viewportWidth: width, viewportHeight: height },
  );
  broadcastToViewers(state, { type: "viewport.set", width, height });
  // Re-cap an in-flight cast at the true size rather than waiting for the
  // next page swap to do it. Awaited so the restart has actually happened by
  // the time the caller continues — `syncViewportFromBrowser` runs this during
  // page acquisition, and returning early leaves the first tool call racing a
  // cast that is still stopped.
  if (state.screencasting) {
    await stopScreencast(state);
    await startScreencast(state);
  }
}

function broadcastToViewers(state: SessionState, msg: LiveMessage): void {
  const payload = JSON.stringify(msg);
  for (const v of state.viewers) {
    if (v.ws.readyState !== WebSocket.OPEN) continue;
    try {
      v.ws.send(payload);
    } catch {
      /* best-effort */
    }
  }
}

function sendToWs(ws: WebSocket, msg: LiveMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* best-effort */
  }
}

/** Snapshot used by the live-panel poll endpoint. */
export function getSessionSnapshot(sessionId: string): {
  viewerCount: number;
  pageUrl: string;
  pageTitle: string | null;
  viewportWidth: number;
  viewportHeight: number;
  hasMcp: boolean;
} | null {
  const state = sessions.get(sessionId);
  if (!state) return null;
  return {
    viewerCount: state.viewers.size,
    pageUrl: state.pageUrl,
    pageTitle: state.pageTitle,
    viewportWidth: state.viewportWidth,
    viewportHeight: state.viewportHeight,
    // `hasMcp` is no longer the right name post-refactor — it now means
    // "is App-side Chromium up?". Kept under the same key so the existing
    // panel polling code keeps working unchanged.
    hasMcp: getRuntime(sessionId) !== null,
  };
}
