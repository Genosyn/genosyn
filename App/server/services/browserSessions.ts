import crypto from "node:crypto";
import { WebSocket } from "ws";
import { AppDataSource } from "../db/datasource.js";
import {
  BrowserSession,
  type BrowserSessionCloseReason,
} from "../db/entities/BrowserSession.js";
import { getRuntime, holdRuntime, releaseRuntime, markActivity } from "./browserChromium.js";

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

const MCP_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
const EXPIRE_GRACE_MS = 30_000;

/**
 * Outbound message shape, used for both viewer-side WS and the
 * cross-module fan-out helpers. Encoded as JSON over the WebSocket. Frame
 * payloads are inline base64 — small enough at JPEG q60 for v1, and
 * avoids the complications of binary WebSocket framing across proxies.
 */
export type LiveMessage =
  | { type: "hello"; sessionId: string; viewportWidth: number; viewportHeight: number; pageUrl: string; pageTitle: string | null }
  | { type: "frame"; frameId: number; data: string; metadata?: { offsetTop?: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number; scrollOffsetX?: number; scrollOffsetY?: number; timestamp?: number } }
  | { type: "frame.ack"; frameId: number }
  | { type: "nav"; url: string; title: string | null }
  | { type: "viewers"; count: number }
  | { type: "closed"; reason: BrowserSessionCloseReason }
  | { type: "input.mouse"; action: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"; x: number; y: number; button?: "none" | "left" | "middle" | "right"; buttons?: number; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number }
  | { type: "input.key"; action: "keyDown" | "keyUp" | "char"; key?: string; code?: string; text?: string; modifiers?: number; windowsVirtualKeyCode?: number }
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
    if (existing && existing.mcpTokenExpiresAt.getTime() > Date.now()) {
      return existing;
    }
  }

  const row = repo.create({
    companyId: args.companyId,
    employeeId: args.employeeId,
    conversationId: args.conversationId,
    runId: args.runId,
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

/** Resolve the MCP-side bearer token to its session id, or null. */
export function resolveBrowserSessionToken(token: string): string | null {
  return tokenToSessionId.get(token) ?? null;
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
      try { v.ws.close(1000, "session closed"); } catch { /* best-effort */ }
    }
  }
  tokenToSessionId.delete(row.mcpToken);
  teardown(sessionId);
}

function teardown(sessionId: string): void {
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
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
export function bootBrowserSessionSweeper(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepExpiredBrowserSessions().catch(() => {
      // best-effort housekeeping
    });
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

// ---------- screencast control (called when viewers come and go) ----------

async function startScreencast(state: SessionState): Promise<void> {
  if (state.screencasting) return;
  const runtime = getRuntime(state.id);
  if (!runtime) return;
  const cdp = runtime.cdp as { send: (m: string, p?: unknown) => Promise<unknown>; on: (ev: string, cb: (e: unknown) => void) => void } | null;
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
        cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => { /* ignore */ });
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
  ws: WebSocket;
  userId: string;
}): void {
  const { sessionId, ws, userId } = args;
  const state = ensureState(sessionId);
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
    try { await cdp.send("Page.screencastFrameAck", { sessionId: cdpSid }); } catch { /* ignore */ }
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
      } catch { /* ignore */ }
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
      } catch { /* ignore */ }
    }
    return;
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

function broadcastToViewers(state: SessionState, msg: LiveMessage): void {
  const payload = JSON.stringify(msg);
  for (const v of state.viewers) {
    if (v.ws.readyState !== WebSocket.OPEN) continue;
    try { v.ws.send(payload); } catch { /* best-effort */ }
  }
}

function sendToWs(ws: WebSocket, msg: LiveMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch { /* best-effort */ }
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
