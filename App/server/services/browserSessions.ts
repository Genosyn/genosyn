import crypto from "node:crypto";
import { WebSocket } from "ws";
import { AppDataSource } from "../db/datasource.js";
import { BrowserSession, type BrowserSessionCloseReason } from "../db/entities/BrowserSession.js";
import { getRuntime, holdRuntime, releaseRuntime, markActivity } from "./browserChromium.js";
import { withSchedulerLease } from "./schedulerLeases.js";
import { registerMembershipAuthorizationChangeSink } from "./resourceEvents.js";

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
 * Frames are not persisted. Recording is out of scope.
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
  (sessionId: string, value: string, kind: SensitiveObservationKind) => void
>();

/** Register process-local cleanup owned by a browser RPC extension. */
export function registerBrowserSessionCleanup(listener: (sessionId: string) => void): () => void {
  cleanupListeners.add(listener);
  return () => cleanupListeners.delete(listener);
}

/** Let the browser RPC boundary retain password values before human input can reveal them. */
export function registerBrowserSensitiveValueListener(
  listener: (sessionId: string, value: string, kind: SensitiveObservationKind) => void,
): () => void {
  sensitiveValueListeners.add(listener);
  return () => sensitiveValueListeners.delete(listener);
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
  | { type: "control.takeover"; userId: string; takeover: boolean };

type ViewerSocket = {
  ws: WebSocket;
  userId: string;
  takeover: boolean;
};

type SessionState = {
  id: string;
  companyId: string;
  employeeId: string;
  viewers: Set<ViewerSocket>;
  /** Frames waiting on viewer-side ack before we tell CDP to advance. */
  pendingCdpAcks: Map<number, string>; // ourFrameId → cdpSessionId
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
};

const sessions = new Map<string, SessionState>();
/** Index used by the WS upgrade handler to resolve a token to a session. */
const tokenToSessionId = new Map<string, string>();

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
    viewportWidth: args.viewportWidth ?? 1280,
    viewportHeight: args.viewportHeight ?? 800,
  });
  await repo.save(row);
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
  if (row.status === "closed" || row.status === "expired") {
    teardown(sessionId);
    return;
  }
  row.status = "closed";
  row.closeReason = reason;
  row.closedAt = new Date();
  await repo.save(row);
  const state = sessions.get(sessionId);
  if (state) {
    broadcastToViewers(state, { type: "closed", reason });
    for (const v of state.viewers) {
      try {
        v.ws.close(1000, "session closed");
      } catch {
        /* best-effort */
      }
    }
  }
  tokenToSessionId.delete(row.mcpToken);
  teardown(sessionId);
}

function teardown(sessionId: string): void {
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

/**
 * Flip the row from `pending` to `live` once the App actually launches
 * Chromium for it. Called by `mcpInternalRouter` after the first tool
 * call succeeds.
 */
export async function markSessionLive(sessionId: string): Promise<void> {
  const repo = AppDataSource.getRepository(BrowserSession);
  const row = await repo.findOneBy({ id: sessionId });
  if (!row) return;
  if (row.status === "pending") {
    row.status = "live";
    row.startedAt = new Date();
    await repo.save(row);
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
  state.pendingCdpAcks.clear();
  cdpListenerAttached.delete(sessionId);
  if (wasCasting && state.viewers.size > 0) {
    await startScreencast(state);
  }
}

// ---------- screencast control (called when viewers come and go) ----------

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
      if (state.viewers.size === 0) {
        // No viewers — ack the frame to CDP immediately so Chromium doesn't
        // pile up a backlog on a frame nobody's drawing.
        cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {
          /* ignore */
        });
        return;
      }
      state.pendingCdpAcks.set(id, ev.sessionId);
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
  state.pendingCdpAcks.clear();
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
  ws: WebSocket;
  userId: string;
}): void {
  const { sessionId, companyId, employeeId, ws, userId } = args;
  const state = ensureState(sessionId);
  state.companyId = companyId;
  state.employeeId = employeeId;
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

  if (state.lastFrame) {
    sendToWs(ws, state.lastFrame);
    const frame = state.lastFrame as { frameId: number };
    state.pendingCdpAcks.has(frame.frameId);
  }

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
    if (state.viewers.size === 0) {
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
    const cdpSid = state.pendingCdpAcks.get(msg.frameId);
    if (!cdpSid) return;
    state.pendingCdpAcks.delete(msg.frameId);
    const runtime = getRuntime(state.id);
    if (!runtime) return;
    const cdp = runtime.cdp as { send: (m: string, p?: unknown) => Promise<unknown> } | null;
    if (!cdp) return;
    try {
      await cdp.send("Page.screencastFrameAck", { sessionId: cdpSid });
    } catch {
      /* ignore */
    }
    return;
  }
  if (msg.type === "control.takeover") {
    viewer.takeover = !!msg.takeover;
    return;
  }
  if (msg.type === "input.mouse" || msg.type === "input.key") {
    if (!viewer.takeover) return;
    markActivity(state.id);
    const runtime = getRuntime(state.id);
    if (!runtime) return;
    const cdp = runtime.cdp as { send: (m: string, p?: unknown) => Promise<unknown> } | null;
    if (!cdp) return;
    // Capture every current password value before a human click can toggle a
    // field to plain text. The browser RPC layer keeps these values redacted
    // for the full session and clears them through the teardown hook above.
    await observeRuntimePasswordValues(state.id);
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
        await observeRuntimePasswordValues(state.id);
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
        await observeRuntimePasswordValues(state.id);
      } catch {
        /* ignore */
      }
    }
    return;
  }
}

async function observeRuntimePasswordValues(sessionId: string): Promise<void> {
  if (sensitiveValueListeners.size === 0) return;
  const runtime = getRuntime(sessionId);
  const page = runtime?.page as
    | {
        frames: () => Array<{
          evaluate: <T>(fn: () => T) => Promise<T>;
        }>;
      }
    | null
    | undefined;
  if (!page) return;
  const observations = await Promise.all(
    page.frames().map((frame) =>
      frame
        .evaluate(() => {
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
          let active = document.activeElement;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          return {
            passwordPresent: passwordInputs.length > 0,
            passwordValues: passwordInputs.map((input) => input.value).filter(Boolean),
            activeInputValue:
              active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
                ? active.value
                : null,
          };
        })
        .catch(() => ({
          passwordPresent: true,
          passwordValues: [] as string[],
          activeInputValue: null as string | null,
        })),
    ),
  );
  for (const observation of observations) {
    for (const listener of sensitiveValueListeners) {
      try {
        if (observation.passwordPresent) listener(sessionId, "", "password-present");
        for (const value of observation.passwordValues) {
          listener(sessionId, value, "password-value");
        }
        if (observation.activeInputValue) {
          listener(sessionId, observation.activeInputValue, "active-input-value");
        }
      } catch {
        // Human input must continue even if a redaction extension failed.
      }
    }
  }
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
      viewers: new Set(),
      pendingCdpAcks: new Map(),
      lastFrame: null,
      pageUrl: "",
      pageTitle: null,
      viewportWidth: 1280,
      viewportHeight: 800,
      screencasting: false,
      frameCounter: 0,
    };
    sessions.set(sessionId, state);
  }
  return state;
}

/**
 * Adopt the real size of a browser we do not own.
 *
 * The App picks 1280×800 for its own Chromium and every downstream consumer
 * assumes it. A Member's browser is whatever size their screen made it, and
 * getting this wrong is not cosmetic: the screencast would be captured with
 * the wrong `maxWidth`/`maxHeight` caps (so the frame is downscaled and the
 * text is permanently soft), and the viewer scales take-over clicks by
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
  // next page swap to do it.
  if (state.screencasting) {
    stopScreencast(state);
    startScreencast(state);
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
