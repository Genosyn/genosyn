import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Socket } from "node:net";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { AppDataSource } from "../db/datasource.js";
import { Membership } from "../db/entities/Membership.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import {
  attachMcpSocket,
  attachViewerSocket,
  resolveBrowserSessionToken,
} from "./browserSessions.js";

/**
 * In-process WebSocket hub for the workspace-chat surface.
 *
 * Every authenticated client opens a single socket at `/api/ws` and is
 * subscribed to one "room" — their companyId. The server fans out events
 * (message.new, reaction.add, channel.new, ...) to every socket in that
 * room. Each event carries enough context for the client to decide whether
 * it cares; clients filter by `channelId` locally.
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
    };

type ConnectedSocket = {
  ws: WebSocket;
  userId: string;
  companyId: string;
  connectedAt: number;
};

const sockets = new Set<ConnectedSocket>();

/** userId → count of open sockets, scoped per company, for presence tracking. */
const presenceCounts = new Map<string, Map<string, number>>();

/** token → { userId, companyId, expiresAt } for short-lived WS upgrade auth. */
type TokenRecord = { userId: string; companyId: string; expiresAt: number };
const wsTokens = new Map<string, TokenRecord>();
const WS_TOKEN_TTL_MS = 60_000;

export function mintWsToken(userId: string, companyId: string): string {
  pruneTokens();
  const token = crypto.randomBytes(24).toString("base64url");
  wsTokens.set(token, {
    userId,
    companyId,
    expiresAt: Date.now() + WS_TOKEN_TTL_MS,
  });
  return token;
}

function consumeWsToken(token: string): TokenRecord | null {
  pruneTokens();
  const rec = wsTokens.get(token);
  if (!rec) return null;
  wsTokens.delete(token);
  if (rec.expiresAt < Date.now()) return null;
  return rec;
}

function pruneTokens(): void {
  const now = Date.now();
  for (const [k, v] of wsTokens) {
    if (v.expiresAt < now) wsTokens.delete(k);
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

/**
 * Broadcast an event to every socket subscribed to a company's room. Used by
 * the chat service whenever a persisted write needs to reach other clients.
 */
export function broadcastToCompany(companyId: string, event: WsEvent): void {
  const payload = JSON.stringify(event);
  for (const s of sockets) {
    if (s.companyId !== companyId) continue;
    if (s.ws.readyState !== WebSocket.OPEN) continue;
    try {
      s.ws.send(payload);
    } catch {
      // Client is in a weird state — drop the frame and let the `close`
      // handler tidy up when the socket finishes closing.
    }
  }
}

async function userHasMembership(
  userId: string,
  companyId: string,
): Promise<boolean> {
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
 * Match `/api/internal/mcp/browser-sessions/<uuid>/stream` for the MCP-side
 * upgrade. Returns the captured session id or null. Kept loose on the
 * suffix so future versions can append querystrings.
 */
function matchMcpStreamPath(pathname: string): string | null {
  const m = /^\/api\/internal\/mcp\/browser-sessions\/([0-9a-fA-F-]{36})\/stream$/.exec(pathname);
  return m ? m[1] : null;
}

/**
 * Match `/api/companies/<cid>/employees/<eid>/browser-sessions/<sid>/ws`.
 */
function matchViewerWsPath(pathname: string): { cid: string; eid: string; sid: string } | null {
  const m = /^\/api\/companies\/([0-9a-fA-F-]{36})\/employees\/([0-9a-fA-F-]{36})\/browser-sessions\/([0-9a-fA-F-]{36})\/ws$/.exec(
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

    // ---------- MCP-side screencast upload ----------
    const mcpStreamSid = matchMcpStreamPath(parsed.pathname);
    if (mcpStreamSid) {
      try {
        const token = parsed.searchParams.get("token") ?? "";
        const sid = resolveBrowserSessionToken(token);
        if (!sid || sid !== mcpStreamSid) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        const row = await AppDataSource.getRepository(BrowserSession).findOneBy({ id: sid });
        if (!row || row.status === "closed" || row.status === "expired") {
          socket.write("HTTP/1.1 410 Gone\r\n\r\n");
          socket.destroy();
          return;
        }
        if (row.mcpTokenExpiresAt.getTime() < Date.now()) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        browserWss.handleUpgrade(req, socket, head, (ws) => {
          attachMcpSocket(sid, ws).catch(() => {
            try { ws.close(1011, "attach failed"); } catch { /* ignore */ }
          });
        });
      } catch {
        socket.destroy();
      }
      return;
    }

    // ---------- Viewer-side iframe socket ----------
    const viewerMatch = matchViewerWsPath(parsed.pathname);
    if (viewerMatch) {
      try {
        const token = parsed.searchParams.get("token") ?? "";
        const rec = consumeWsToken(token);
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
      const rec = consumeWsToken(token);
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
      broadcastToCompany(companyId, {
        type: "typing",
        channelId: m.channelId,
        by: { kind: "user", id: userId, name: m.name ?? "" },
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
