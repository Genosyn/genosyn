import crypto from "node:crypto";
import { WebSocket } from "ws";
import { AppDataSource } from "../db/datasource.js";
import {
  BrowserSession,
  type BrowserSessionCloseReason,
} from "../db/entities/BrowserSession.js";

/**
 * Browser-session lifecycle + in-memory fanout hub.
 *
 * Two distinct WebSocket cohorts join each session:
 *
 *   * **MCP child** — exactly one. Pushes binary screencast frames up;
 *     receives input events back.
 *   * **Viewers** — zero or more humans watching the iframe. Receive frames;
 *     send mouse/keyboard events when they "take over."
 *
 * Frames are not persisted. The hub keeps just enough per-session state to
 * fan out frames, aggregate viewer-side acks, and tell the MCP child when
 * to start / stop the screencast (saves CPU when no humans are watching).
 */

const MCP_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
const EXPIRE_GRACE_MS = 30_000;

/**
 * Outbound message shape from MCP child / App → viewers, and from viewers →
 * MCP child via the App. Encoded as JSON over the WebSocket. Frame payloads
 * are inline base64 — small enough at JPEG q60 for v1, and avoids the
 * complications of binary WebSocket framing across the proxy.
 */
export type LiveMessage =
  | { type: "hello"; sessionId: string; viewportWidth: number; viewportHeight: number; pageUrl: string; pageTitle: string | null }
  | { type: "frame"; frameId: number; data: string; metadata?: { offsetTop?: number; pageScaleFactor?: number; deviceWidth?: number; deviceHeight?: number; scrollOffsetX?: number; scrollOffsetY?: number; timestamp?: number } }
  | { type: "frame.ack"; frameId: number }
  | { type: "nav"; url: string; title: string | null }
  | { type: "viewers"; count: number }
  | { type: "closed"; reason: BrowserSessionCloseReason }
  | { type: "input.mouse"; action: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel"; x: number; y: number; button?: "none" | "left" | "middle" | "right"; clickCount?: number; deltaX?: number; deltaY?: number; modifiers?: number }
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
  mcp: WebSocket | null;
  viewers: Set<ViewerSocket>;
  /** Frames waiting on viewer-side ack before we tell the MCP to advance. */
  pendingAcks: Map<number, Set<ViewerSocket>>;
  /** Last frame metadata we saw, replayed to viewers that connect mid-stream. */
  lastFrame: LiveMessage | null;
  pageUrl: string;
  pageTitle: string | null;
  viewportWidth: number;
  viewportHeight: number;
};

const sessions = new Map<string, SessionState>();
/** Index used by the WS upgrade handler to resolve a token to a session. */
const tokenToSessionId = new Map<string, string>();

// ---------- token / lifecycle ----------

function newToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Create a new BrowserSession row for an upcoming MCP spawn. Called from
 * the MCP materializer when the employee's `browserEnabled` is on.
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

/** Resolve an MCP-side bearer token to its session id, or null. */
export function resolveBrowserSessionToken(token: string): string | null {
  return tokenToSessionId.get(token) ?? null;
}

/**
 * Mark a session closed and tear down its hub state. Idempotent — repeated
 * calls (e.g. MCP socket close + manual UI close racing) are no-ops after
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
  // Notify any connected viewers, then drop the hub entry.
  const state = sessions.get(sessionId);
  if (state) {
    broadcastToViewers(state, { type: "closed", reason });
    for (const v of state.viewers) {
      try { v.ws.close(1000, "session closed"); } catch { /* best-effort */ }
    }
    if (state.mcp && state.mcp.readyState === WebSocket.OPEN) {
      try { state.mcp.close(1000, "session closed"); } catch { /* best-effort */ }
    }
  }
  teardown(sessionId);
}

function teardown(sessionId: string): void {
  const state = sessions.get(sessionId);
  if (state) {
    sessions.delete(sessionId);
  }
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

// ---------- hub: MCP-side socket ----------

/**
 * Attach the MCP child's WebSocket to a session. Called once from the WS
 * upgrade handler in `realtime.ts` after the bearer-token check.
 */
export async function attachMcpSocket(sessionId: string, ws: WebSocket): Promise<void> {
  const state = ensureState(sessionId);
  state.mcp = ws;

  // Flip status to live + record startedAt on first attach.
  const repo = AppDataSource.getRepository(BrowserSession);
  const row = await repo.findOneBy({ id: sessionId });
  if (row && row.status === "pending") {
    row.status = "live";
    row.startedAt = new Date();
    await repo.save(row);
    state.companyId = row.companyId;
    state.employeeId = row.employeeId;
    state.pageUrl = row.pageUrl;
    state.pageTitle = row.pageTitle;
    state.viewportWidth = row.viewportWidth;
    state.viewportHeight = row.viewportHeight;
  }

  // Tell the child how many viewers are already watching so it can decide
  // whether to start the screencast right away.
  sendToMcp(state, { type: "viewers", count: state.viewers.size });

  ws.on("message", (raw) => {
    let msg: LiveMessage | null = null;
    try {
      msg = JSON.parse(String(raw)) as LiveMessage;
    } catch {
      return;
    }
    handleMcpMessage(state, msg).catch(() => {
      // Errors here just drop the message — the MCP will retry on next frame.
    });
  });

  ws.on("close", () => {
    if (state.mcp === ws) state.mcp = null;
    // The child closing is not necessarily a session end (it might reconnect
    // after a transient blip). Mark closed only when the session row's TTL
    // expires; the sweeper handles that.
    void closeBrowserSession(sessionId, "shutdown");
  });

  ws.on("error", () => {
    // Let close handler clean up.
  });
}

async function handleMcpMessage(state: SessionState, msg: LiveMessage): Promise<void> {
  if (msg.type === "frame") {
    state.lastFrame = msg;
    if (state.viewers.size === 0) {
      // No viewers — ack immediately so the child doesn't pile up frames.
      sendToMcp(state, { type: "frame.ack", frameId: msg.frameId });
      return;
    }
    state.pendingAcks.set(msg.frameId, new Set(state.viewers));
    broadcastToViewers(state, msg);
    return;
  }
  if (msg.type === "nav") {
    state.pageUrl = msg.url;
    state.pageTitle = msg.title;
    const repo = AppDataSource.getRepository(BrowserSession);
    const row = await repo.findOneBy({ id: state.id });
    if (row) {
      row.pageUrl = msg.url;
      row.pageTitle = msg.title;
      await repo.save(row);
    }
    broadcastToViewers(state, msg);
    return;
  }
  if (msg.type === "hello") {
    state.viewportWidth = msg.viewportWidth;
    state.viewportHeight = msg.viewportHeight;
    state.pageUrl = msg.pageUrl;
    state.pageTitle = msg.pageTitle;
    const repo = AppDataSource.getRepository(BrowserSession);
    const row = await repo.findOneBy({ id: state.id });
    if (row) {
      row.viewportWidth = msg.viewportWidth;
      row.viewportHeight = msg.viewportHeight;
      row.pageUrl = msg.pageUrl;
      row.pageTitle = msg.pageTitle;
      await repo.save(row);
    }
    broadcastToViewers(state, msg);
    return;
  }
  if (msg.type === "closed") {
    await closeBrowserSession(state.id, msg.reason ?? "shutdown");
    return;
  }
}

// ---------- hub: viewer-side socket ----------

/**
 * Attach a viewer's WebSocket to a session. Returns a teardown function the
 * upgrade handler invokes on close.
 */
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

  // Send a hello so the viewer knows the current viewport / page context
  // even if no frames have arrived yet.
  const hello: LiveMessage = {
    type: "hello",
    sessionId,
    viewportWidth: state.viewportWidth,
    viewportHeight: state.viewportHeight,
    pageUrl: state.pageUrl,
    pageTitle: state.pageTitle,
  };
  sendToWs(ws, hello);

  // Replay the last frame so the viewer sees the current page rather than
  // a blank canvas while the MCP is between frames.
  if (state.lastFrame) {
    sendToWs(ws, state.lastFrame);
    state.pendingAcks.get((state.lastFrame as { frameId: number }).frameId)?.add(viewer);
  }

  // Inform MCP of new viewer count — first viewer kicks the screencast on.
  if (wasEmpty) {
    sendToMcp(state, { type: "viewers", count: state.viewers.size });
  }

  ws.on("message", (raw) => {
    let msg: LiveMessage | null = null;
    try {
      msg = JSON.parse(String(raw)) as LiveMessage;
    } catch {
      return;
    }
    handleViewerMessage(state, viewer, msg);
  });

  ws.on("close", () => {
    state.viewers.delete(viewer);
    // Drop this viewer from any pending acks so a slow tab close doesn't
    // gate frame advancement for everyone else.
    for (const [frameId, set] of state.pendingAcks) {
      set.delete(viewer);
      if (set.size === 0) {
        state.pendingAcks.delete(frameId);
        sendToMcp(state, { type: "frame.ack", frameId });
      }
    }
    if (state.viewers.size === 0) {
      sendToMcp(state, { type: "viewers", count: 0 });
    }
  });

  ws.on("error", () => {
    // Let close handler clean up.
  });
}

function handleViewerMessage(state: SessionState, viewer: ViewerSocket, msg: LiveMessage): void {
  if (msg.type === "frame.ack") {
    const set = state.pendingAcks.get(msg.frameId);
    if (!set) return;
    set.delete(viewer);
    if (set.size === 0) {
      state.pendingAcks.delete(msg.frameId);
      sendToMcp(state, { type: "frame.ack", frameId: msg.frameId });
    }
    return;
  }
  if (msg.type === "control.takeover") {
    viewer.takeover = !!msg.takeover;
    return;
  }
  if (msg.type === "input.mouse" || msg.type === "input.key" || msg.type === "viewport.set") {
    // Only forward input from viewers in takeover mode. Without this, two
    // observers fighting for control would race.
    if (!viewer.takeover && msg.type !== "viewport.set") return;
    sendToMcp(state, msg);
    return;
  }
}

// ---------- helpers ----------

function ensureState(sessionId: string): SessionState {
  let state = sessions.get(sessionId);
  if (!state) {
    state = {
      id: sessionId,
      companyId: "",
      employeeId: "",
      mcp: null,
      viewers: new Set(),
      pendingAcks: new Map(),
      lastFrame: null,
      pageUrl: "",
      pageTitle: null,
      viewportWidth: 1280,
      viewportHeight: 800,
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

function sendToMcp(state: SessionState, msg: LiveMessage): void {
  if (!state.mcp || state.mcp.readyState !== WebSocket.OPEN) return;
  try { state.mcp.send(JSON.stringify(msg)); } catch { /* best-effort */ }
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
    hasMcp: !!state.mcp,
  };
}
