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
let beforeBrowserSessionSaveForTests: (() => Promise<void>) | null = null;

export function setBeforeBrowserSessionSaveForTests(hook: (() => Promise<void>) | null): void {
  beforeBrowserSessionSaveForTests = hook;
}

/** Register process-local cleanup owned by a browser RPC extension. */
export function registerBrowserSessionCleanup(listener: (sessionId: string) => void): () => void {
  cleanupListeners.add(listener);
  return () => cleanupListeners.delete(listener);
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
  /** Latest recorder frame waiting for the next fixed-cadence intake slot. */
  pendingRecordingFrame: string | null;
  recordingFrameTimer: NodeJS.Timeout | null;
  lastRecordingFrameAcceptedAt: number;
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
  // Resolve identity even after teardown so RPC can distinguish a closed
  // session from an unknown credential. Authorization still checks status,
  // expiry and live Browser policy on every request.
  if (row.status !== "closed" && row.status !== "expired")
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
  freezeBrowserRecording(sessionId);
  await flushBrowserRecordingFrameIntake(sessionId);
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
  // shutdown must not leave a window for fresh browser RPCs after finalization.
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
export async function sweepExpiredBrowserSessions(
  assertLeaseHeld: () => void = () => undefined,
): Promise<void> {
  const repo = AppDataSource.getRepository(BrowserSession);
  const cutoff = new Date(Date.now() - EXPIRE_GRACE_MS);
  const stale = await repo
    .createQueryBuilder("s")
    .where("s.status = :status", { status: "pending" })
    .andWhere("s.mcpTokenExpiresAt < :cutoff", { cutoff })
    .getMany();
  for (const row of stale) {
    assertLeaseHeld();
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
    withSchedulerLease("browser-session-sweep", 55_000, (lease) => sweepExpiredBrowserSessions(lease.assertHeld)).catch(
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
  clearPendingAcks(state);
  cdpListenerAttached.delete(sessionId);
  if (wasCasting && shouldScreencast(state)) {
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

function acceptPendingRecordingFrame(state: SessionState): void {
  if (state.pendingRecordingFrame === null || !browserRecordingDemand(state.id)) return;
  const frame = state.pendingRecordingFrame;
  state.pendingRecordingFrame = null;
  state.lastRecordingFrameAcceptedAt = Date.now();
  acceptBrowserRecordingFrame(state.id, frame);
  scheduleRecordingFrameAcceptance(state);
}

function scheduleRecordingFrameAcceptance(state: SessionState): void {
  if (
    state.recordingFrameTimer ||
    state.pendingRecordingFrame === null ||
    !browserRecordingDemand(state.id)
  ) {
    return;
  }
  const delay = Math.max(
    0,
    state.lastRecordingFrameAcceptedAt + 1000 / BROWSER_RECORDING_FPS - Date.now(),
  );
  if (delay === 0) {
    acceptPendingRecordingFrame(state);
    return;
  }
  state.recordingFrameTimer = setTimeout(() => {
    state.recordingFrameTimer = null;
    acceptPendingRecordingFrame(state);
  }, delay);
  if (typeof state.recordingFrameTimer.unref === "function") {
    state.recordingFrameTimer.unref();
  }
}

function queueRecordingFrame(state: SessionState, data: string): void {
  if (!browserRecordingDemand(state.id)) return;
  state.pendingRecordingFrame = data;
  scheduleRecordingFrameAcceptance(state);
}

export async function flushBrowserRecordingFrameIntake(sessionId: string): Promise<void> {
  const state = sessions.get(sessionId);
  if (state?.recordingFrameTimer) clearTimeout(state.recordingFrameTimer);
  if (state) {
    state.recordingFrameTimer = null;
    state.pendingRecordingFrame = null;
  }
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

/**
 * Finalize every browser recording belonging to a Run. Every failure is
 * returned as a log warning; it never changes the Run verdict or retry policy.
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
    for (const row of rows) freezeBrowserRecording(row.id);
    await Promise.all(rows.map((row) => flushBrowserRecordingFrameIntake(row.id)));
    await Promise.all(
      rows.map(async (row) => {
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
      recordingFrameTimer: null,
      lastRecordingFrameAcceptedAt: 0,
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
