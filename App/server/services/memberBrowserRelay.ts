import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

import { constantTimeEqual } from "../lib/constantTime.js";
import { openCdpChannel, type CdpChannel } from "./memberBrowserHub.js";

/**
 * A loopback-only WebSocket endpoint that looks like a Chrome DevTools browser
 * endpoint, so `chromium.connectOverCDP()` can dial it.
 *
 * Playwright needs a URL. The bridge socket is inbound and multiplexed, so it
 * cannot be one. This module bridges the two: it listens on `127.0.0.1` on an
 * ephemeral port, and every accepted socket is pinned to a single-use ticket
 * that names one {@link MemberBrowser}. Frames are piped verbatim in both
 * directions — the App speaks whatever CDP Playwright emits, and the agent on
 * the far end is the thing that decides which of it is allowed.
 *
 * It is a separate `http.Server` rather than a branch on the main one for two
 * reasons: the main server's upgrade chain is cookie-authenticated and
 * public-facing, and binding here to `127.0.0.1` makes "not reachable off this
 * host" a property of the socket instead of a property of a check.
 */

/** A ticket is spent the moment a socket presents it. */
const TICKET_TTL_MS = 60_000;

type Ticket = {
  id: string;
  secret: string;
  browserId: string;
  sessionId: string;
  expiresAt: number;
};

const tickets = new Map<string, Ticket>();
let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
let listening: Promise<number> | null = null;

function sweepTickets(): void {
  const now = Date.now();
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt < now) tickets.delete(id);
  }
}

async function ensureRelay(): Promise<number> {
  if (listening) return listening;
  listening = (async () => {
    const httpServer = http.createServer((_req, res) => {
      // Nothing here serves HTTP. Playwright is handed a `ws://` endpoint
      // directly, so it never fetches `/json/version`.
      res.statusCode = 404;
      res.end();
    });
    const sockets = new WebSocketServer({ noServer: true });

    httpServer.on("upgrade", (req, socket, head) => {
      const url = req.url ?? "";
      const match = /^\/cdp\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{16,128})$/.exec(url);
      if (!match) {
        socket.destroy();
        return;
      }
      const [, ticketId, secret] = match;
      sweepTickets();
      const ticket = tickets.get(ticketId);
      if (!ticket || ticket.expiresAt < Date.now() || !constantTimeEqual(secret, ticket.secret)) {
        socket.destroy();
        return;
      }
      // Single use: a replayed URL finds nothing.
      tickets.delete(ticketId);
      sockets.handleUpgrade(req, socket, head, (ws) => {
        void attach(ws, ticket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(0, "127.0.0.1", () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });
    httpServer.unref();
    server = httpServer;
    wss = sockets;
    return (httpServer.address() as AddressInfo).port;
  })().catch((err) => {
    listening = null;
    throw err;
  });
  return listening;
}

async function attach(ws: WebSocket, ticket: Ticket): Promise<void> {
  let channel: CdpChannel | null = null;
  let closed = false;

  const shutdown = (reason: string) => {
    if (closed) return;
    closed = true;
    try {
      channel?.close(reason);
    } catch {
      // ignore
    }
    try {
      ws.close(1000, reason.slice(0, 120));
    } catch {
      // ignore
    }
  };

  // Frames that arrive before the channel is up would otherwise be dropped on
  // the floor; Playwright starts talking immediately after the handshake.
  const pending: string[] = [];
  ws.on("message", (raw: Buffer | string) => {
    const data = typeof raw === "string" ? raw : raw.toString("utf8");
    if (channel) channel.send(data);
    else pending.push(data);
  });
  ws.on("close", () => shutdown("the App closed the CDP connection"));
  ws.on("error", () => shutdown("the App's CDP connection failed"));

  try {
    channel = await openCdpChannel(ticket.browserId, {
      onMessage: (data) => {
        if (closed) return;
        try {
          ws.send(data);
        } catch {
          shutdown("relay send failed");
        }
      },
      onClose: (reason) => shutdown(reason),
    });
  } catch (err) {
    shutdown(err instanceof Error ? err.message : String(err));
    return;
  }
  if (closed) {
    channel.close("the App closed the CDP connection");
    return;
  }
  for (const data of pending) channel.send(data);
  pending.length = 0;
}

/**
 * Mint a one-shot `ws://127.0.0.1:<port>/cdp/<id>/<secret>` endpoint for one
 * session. The host is deliberately an IP literal: Playwright dials through
 * its own happy-eyeballs agent, and a hostname would take a DNS path that the
 * outbound network policy treats as a non-public address.
 */
export async function mintCdpEndpoint(params: {
  browserId: string;
  sessionId: string;
}): Promise<string> {
  const port = await ensureRelay();
  const ticket: Ticket = {
    id: crypto.randomUUID(),
    secret: crypto.randomBytes(24).toString("base64url"),
    browserId: params.browserId,
    sessionId: params.sessionId,
    expiresAt: Date.now() + TICKET_TTL_MS,
  };
  tickets.set(ticket.id, ticket);
  return `ws://127.0.0.1:${port}/cdp/${ticket.id}/${ticket.secret}`;
}

/** Test seam: the relay is process-global, so tests need a way back. */
export async function shutdownMemberBrowserRelayForTests(): Promise<void> {
  tickets.clear();
  const current = server;
  const currentSockets = wss;
  server = null;
  wss = null;
  listening = null;
  currentSockets?.close();
  if (current) {
    await new Promise<void>((resolve) => current.close(() => resolve()));
  }
}

/** Test seam: how many unspent tickets are outstanding. */
export function outstandingCdpTicketsForTests(): number {
  sweepTickets();
  return tickets.size;
}
