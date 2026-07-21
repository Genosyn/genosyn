import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { AppDataSource } from "../db/datasource.js";
import { Membership } from "../db/entities/Membership.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Channel } from "../db/entities/Channel.js";
import { ChannelMember } from "../db/entities/ChannelMember.js";
import { attachViewerSocket } from "./browserSessions.js";
import { createAuthFlowState, consumeAuthFlowState } from "./authFlowState.js";
import { config } from "../../config.js";
import { RealtimeEvent } from "../db/entities/RealtimeEvent.js";
import { Client as PostgresClient } from "pg";
import { LessThan } from "typeorm";

/**
 * In-process WebSocket hub for the workspace-chat surface.
 *
 * Every authenticated client opens a single socket at `/api/ws` and is
 * subscribed to one company room. Company-wide events fan out to the room;
 * channel and user events are authorized server-side for each socket before
 * any payload is sent. Client-side filtering is presentation only.
 *
 * Auth can't use `cookie-session` directly because session parsing is
 * middleware that needs Express req/res — WebSocket upgrades happen before
 * that runs. Instead the client hits `POST /api/ws/token` over the normal
 * session-authed HTTP surface, gets a short-lived random token, and passes
 * it as `?token=...` on the WS URL. Tokens are single-use and expire after
 * 60 seconds, so a stolen token is useless past the immediate handshake.
 */

export type WsEvent =
  | { type: "hello"; userId: string; companyId: string }
  | { type: "message.new"; channelId: string; message: unknown }
  | {
      type: "message.edit";
      channelId: string;
      messageId: string;
      content: string;
      editedAt: string;
    }
  | { type: "message.delete"; channelId: string; messageId: string }
  | {
      type: "reaction.add";
      channelId: string;
      messageId: string;
      emoji: string;
      by: { kind: "user" | "ai"; id: string; name: string };
    }
  | {
      type: "reaction.remove";
      channelId: string;
      messageId: string;
      emoji: string;
      by: { kind: "user" | "ai"; id: string };
    }
  | { type: "channel.new"; channel: unknown }
  | { type: "channel.update"; channelId: string; channel: unknown }
  | { type: "channel.archive"; channelId: string }
  | {
      type: "typing";
      channelId: string;
      by: { kind: "user" | "ai"; id: string; name: string };
    }
  | {
      type: "presence";
      userId: string;
      online: boolean;
    }
  | {
      type: "notification.new";
      /** Recipient — clients filter so each user only reacts to their own. */
      userId: string;
      notification: unknown;
    }
  | {
      type: "notification.read";
      userId: string;
      notificationIds: string[];
    }
  | {
      /** The Email section's local mirror changed (sync pass, write-through
       * action, or a handover finishing). Coarse on purpose: clients
       * refetch the views they have open rather than patching state. */
      type: "mail.updated";
      accountId: string;
      /** False when only account sync metadata changed. Omitted means the
       * mirrored messages, labels, or related Email state may have changed. */
      threadsChanged?: boolean;
    };

type ConnectedSocket = {
  ws: WebSocket;
  userId: string;
  companyId: string;
  connectedAt: number;
  /** Serialized per-socket delivery preserves event ordering across DB checks. */
  delivery: Promise<void>;
};

const sockets = new Set<ConnectedSocket>();

/** userId → count of open sockets, scoped per company, for presence tracking. */
const presenceCounts = new Map<string, Map<string, number>>();

/** token → { userId, companyId, expiresAt } for short-lived WS upgrade auth. */
type TokenRecord = { userId: string; companyId: string; expiresAt: number };
const WS_TOKEN_TTL_MS = 60_000;
const REALTIME_EVENT_TTL_MS = 5 * 60_000;
const REALTIME_CHANNEL = "genosyn_realtime";
const REALTIME_INSTANCE_ID = crypto.randomUUID();
let postgresListener: PostgresClient | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let publishCount = 0;

export function mintWsToken(userId: string, companyId: string): Promise<string> {
  return createAuthFlowState(
    "websocket",
    {
      userId,
      companyId,
      expiresAt: Date.now() + WS_TOKEN_TTL_MS,
    } satisfies TokenRecord,
    WS_TOKEN_TTL_MS,
  );
}

async function consumeWsToken(token: string): Promise<TokenRecord | null> {
  const rec = await consumeAuthFlowState<TokenRecord>("websocket", token);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) return null;
  return rec;
}

async function publishToOtherReplicas(companyId: string, event: WsEvent): Promise<void> {
  if (config.db.driver !== "postgres") return;
  const repo = AppDataSource.getRepository(RealtimeEvent);
  const row = await repo.save(
    repo.create({
      originId: REALTIME_INSTANCE_ID,
      companyId,
      eventJson: JSON.stringify(event),
      expiresAt: new Date(Date.now() + REALTIME_EVENT_TTL_MS),
    }),
  );
  await AppDataSource.query("SELECT pg_notify($1, $2)", [REALTIME_CHANNEL, row.id]);
  publishCount += 1;
  if (publishCount % 100 === 0) {
    await repo.delete({ expiresAt: LessThan(new Date()) });
  }
}

async function receiveRealtimeEvent(id: string): Promise<void> {
  const row = await AppDataSource.getRepository(RealtimeEvent).findOneBy({ id });
  if (!row || row.originId === REALTIME_INSTANCE_ID || row.expiresAt < new Date()) return;
  try {
    broadcastLocally(row.companyId, JSON.parse(row.eventJson) as WsEvent);
  } catch {
    // Invalid or stale fan-out rows are ignored; the source write still succeeded.
  }
}

function scheduleRealtimeReconnect(): void {
  if (reconnectTimer || config.db.driver !== "postgres") return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void bootRealtimeBridge();
  }, 5_000);
  if (typeof reconnectTimer.unref === "function") reconnectTimer.unref();
}

/** Start the dedicated Postgres LISTEN connection used by every app replica. */
export async function bootRealtimeBridge(): Promise<void> {
  if (config.db.driver !== "postgres" || postgresListener) return;
  const client = new PostgresClient({ connectionString: config.db.postgresUrl });
  postgresListener = client;
  client.on("notification", (message) => {
    if (message.channel === REALTIME_CHANNEL && message.payload) {
      void receiveRealtimeEvent(message.payload);
    }
  });
  const disconnected = () => {
    if (postgresListener === client) postgresListener = null;
    scheduleRealtimeReconnect();
  };
  client.on("error", disconnected);
  client.on("end", disconnected);
  try {
    await client.connect();
    await client.query(`LISTEN ${REALTIME_CHANNEL}`);
  } catch (error) {
    disconnected();
    await client.end().catch(() => {});
    if (config.security.multiTenant) {
      throw new Error("Postgres realtime bridge connection failed", { cause: error });
    }
    // eslint-disable-next-line no-console
    console.error("[realtime] Postgres bridge connection failed:", error);
  }
}

function incrementPresence(companyId: string, userId: string): boolean {
  let inner = presenceCounts.get(companyId);
  if (!inner) {
    inner = new Map();
    presenceCounts.set(companyId, inner);
  }
  const prev = inner.get(userId) ?? 0;
  inner.set(userId, prev + 1);
  return prev === 0;
}

function decrementPresence(companyId: string, userId: string): boolean {
  const inner = presenceCounts.get(companyId);
  if (!inner) return false;
  const prev = inner.get(userId) ?? 0;
  const next = prev - 1;
  if (next <= 0) {
    inner.delete(userId);
    if (inner.size === 0) presenceCounts.delete(companyId);
    return true;
  }
  inner.set(userId, next);
  return false;
}

export function onlineUserIdsFor(companyId: string): string[] {
  const inner = presenceCounts.get(companyId);
  if (!inner) return [];
  return Array.from(inner.keys());
}

function eventChannelId(event: WsEvent): string | null {
  if ("channelId" in event && typeof event.channelId === "string") return event.channelId;
  if (event.type !== "channel.new" || !event.channel || typeof event.channel !== "object") {
    return null;
  }
  const id = (event.channel as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

async function userCanReceiveChannelEvent(
  userId: string,
  companyId: string,
  channelId: string,
): Promise<boolean> {
  const channel = await AppDataSource.getRepository(Channel).findOneBy({
    id: channelId,
    companyId,
  });
  if (!channel) return false;
  if (channel.kind === "public") return true;
  return (
    (await AppDataSource.getRepository(ChannelMember).findOneBy({
      channelId,
      userId,
    })) !== null
  );
}

async function socketCanReceive(s: ConnectedSocket, event: WsEvent): Promise<boolean> {
  if (
    (event.type === "notification.new" || event.type === "notification.read") &&
    event.userId !== s.userId
  ) {
    return false;
  }
  const channelId = eventChannelId(event);
  if (!channelId) return true;
  return userCanReceiveChannelEvent(s.userId, s.companyId, channelId);
}

/** Authorize and enqueue an event separately for every connected Member. */
function broadcastLocally(companyId: string, event: WsEvent): void {
  const payload = JSON.stringify(event);
  for (const s of sockets) {
    if (s.companyId !== companyId) continue;
    s.delivery = s.delivery
      .then(async () => {
        if (s.ws.readyState !== WebSocket.OPEN) return;
        if (!(await socketCanReceive(s, event))) return;
        s.ws.send(payload);
      })
      .catch(() => {
        // Drop a failed frame and keep the queue usable. The close handler
        // removes dead sockets; an authorization lookup must never do so.
      });
  }
}

export function broadcastToCompany(companyId: string, event: WsEvent): void {
  broadcastLocally(companyId, event);
  void publishToOtherReplicas(companyId, event).catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[realtime] cross-replica publish failed:", error);
  });
}

async function userHasMembership(userId: string, companyId: string): Promise<boolean> {
  const m = await AppDataSource.getRepository(Membership).findOneBy({
    userId,
    companyId,
  });
  return m !== null;
}

/**
 * Attach the WebSocket server to an HTTP server. Called once during boot
 * from server/index.ts so the HTTP and WS surfaces share a port (the Vite
 * dev proxy and any prod reverse-proxy only need to forward `/api/ws` as
 * an upgradeable path, same as `/api/*` for REST).
 *
 * Upgrade flow:
 *   1. Client POSTs `/api/ws/token` with the wanted companyId. That route
 *      is session-authed, reads `req.session.userId`, confirms membership,
 *      and mints a one-shot token with a 60-second TTL.
 *   2. Client opens `ws://<host>/api/ws?token=<token>`.
 *   3. Server consumes the token here (single-use), re-confirms
 *      membership, then stashes {userId, companyId} on the socket record.
 */
/**
 * Match `/api/companies/<cid>/employees/<eid>/browser-sessions/<sid>/ws`.
 */
function matchViewerWsPath(pathname: string): { cid: string; eid: string; sid: string } | null {
  const m =
    /^\/api\/companies\/([0-9a-fA-F-]{36})\/employees\/([0-9a-fA-F-]{36})\/browser-sessions\/([0-9a-fA-F-]{36})\/ws$/.exec(
      pathname,
    );
  return m ? { cid: m[1], eid: m[2], sid: m[3] } : null;
}

export function attachRealtime(httpServer: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const browserWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req: IncomingMessage, socket: Socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/api/")) return;

    let parsed: URL;
    try {
      parsed = new URL(url, "http://localhost");
    } catch {
      socket.destroy();
      return;
    }

    // ---------- Viewer-side iframe socket ----------
    const viewerMatch = matchViewerWsPath(parsed.pathname);
    if (viewerMatch) {
      try {
        const token = parsed.searchParams.get("token") ?? "";
        const rec = await consumeWsToken(token);
        if (!rec) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        if (rec.companyId !== viewerMatch.cid) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        const ok = await userHasMembership(rec.userId, rec.companyId);
        if (!ok) {
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          socket.destroy();
          return;
        }
        const row = await AppDataSource.getRepository(BrowserSession).findOneBy({
          id: viewerMatch.sid,
        });
        if (!row || row.companyId !== rec.companyId || row.employeeId !== viewerMatch.eid) {
          socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
          socket.destroy();
          return;
        }
        if (row.status === "closed" || row.status === "expired") {
          socket.write("HTTP/1.1 410 Gone\r\n\r\n");
          socket.destroy();
          return;
        }
        browserWss.handleUpgrade(req, socket, head, (ws) => {
          attachViewerSocket({
            sessionId: row.id,
            ws,
            userId: rec.userId,
          });
        });
      } catch {
        socket.destroy();
      }
      return;
    }

    // ---------- Workspace chat (default) ----------
    if (!url.startsWith("/api/ws")) return;
    try {
      const token = parsed.searchParams.get("token");
      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const rec = await consumeWsToken(token);
      if (!rec) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const ok = await userHasMembership(rec.userId, rec.companyId);
      if (!ok) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        registerSocket(ws, rec.userId, rec.companyId);
      });
    } catch {
      socket.destroy();
    }
  });

  return wss;
}

function registerSocket(ws: WebSocket, userId: string, companyId: string): void {
  const record: ConnectedSocket = {
    ws,
    userId,
    companyId,
    connectedAt: Date.now(),
    delivery: Promise.resolve(),
  };
  sockets.add(record);

  const firstConnect = incrementPresence(companyId, userId);
  if (firstConnect) {
    broadcastToCompany(companyId, {
      type: "presence",
      userId,
      online: true,
    });
  }

  ws.on("message", (raw) => {
    // Clients mostly just receive. The only thing they need to send is a
    // typing indicator. Anything else we ignore.
    let msg: unknown;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const m = msg as { type?: string; channelId?: string; name?: string };
    if (m.type === "typing" && m.channelId) {
      void userCanReceiveChannelEvent(userId, companyId, m.channelId).then((allowed) => {
        if (!allowed) return;
        broadcastToCompany(companyId, {
          type: "typing",
          channelId: m.channelId!,
          by: { kind: "user", id: userId, name: m.name ?? "" },
        });
      });
    }
  });

  ws.on("close", () => {
    sockets.delete(record);
    const lastDisconnect = decrementPresence(companyId, userId);
    if (lastDisconnect) {
      broadcastToCompany(companyId, {
        type: "presence",
        userId,
        online: false,
      });
    }
  });

  ws.on("error", () => {
    // Let `close` clean up state; we don't need a separate path here.
  });

  try {
    const helloMsg: WsEvent = { type: "hello", userId, companyId };
    ws.send(JSON.stringify(helloMsg));
  } catch {
    // If this throws the socket is already dead; close handler runs.
  }
}
