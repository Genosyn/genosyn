import { NextFunction, Request, Response } from "express";
import net from "node:net";

/**
 * Refuse anything that did not arrive on the loopback interface.
 *
 * `/api/internal/*` is the AI Employee tool surface — send mail, create and
 * delete Routines, write Bases — and its only credential is a bearer token
 * held in this process's memory. Both routers mount above
 * `requireTrustedOrigin` and above the session middleware, deliberately, so a
 * session-less machine caller is not gated on a cookie or an `Origin` header.
 * What was missing is the other half of that trade: nothing checked that the
 * caller was actually the machine we spawned.
 *
 * It is reachable today. The Helm ingress publishes `/` with `pathType:
 * Prefix`, so a hosted install forwards `/api/internal/...` from the public
 * internet to a router whose token has a seven-hour TTL, no `Origin` gate, no
 * session versioning, and no throttling.
 *
 * Every legitimate caller is loopback by construction — `protocol.ts`,
 * `genosyn.ts`, `taintPolicy.ts` and `mcpSources.ts` all build
 * `http://127.0.0.1:${config.port}`, and the browser MCP child is a sibling
 * process on the same host — so this costs nothing and closes the door.
 */

/** Loopback in every encoding Node hands us, including IPv4-mapped IPv6. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  // Node reports the scope on link-local addresses ("fe80::1%lo0"); loopback
  // never needs one, but strip it before parsing rather than fail open.
  const cleaned = address.replace(/%.*$/, "");
  const mapped = cleaned.match(/^::ffff:(.+)$/i);
  const candidate = mapped ? mapped[1] : cleaned;
  const kind = net.isIP(candidate);
  if (kind === 4) return candidate.startsWith("127.");
  if (kind === 6) return candidate === "::1";
  return false;
}

/**
 * Headers a reverse proxy adds. Their presence means the request was relayed,
 * which is decisive even when the socket itself is loopback: a proxy sharing
 * the host is exactly the topology that would otherwise smuggle a public
 * request in as a local one.
 */
const FORWARDED_HEADERS = [
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  "forwarded",
];

export function loopbackOnly(req: Request, res: Response, next: NextFunction) {
  const relayed = FORWARDED_HEADERS.some((header) => req.headers[header] !== undefined);
  if (relayed || !isLoopbackAddress(req.socket?.remoteAddress ?? undefined)) {
    // 404 rather than 403: an internal surface should not confirm it exists to
    // a caller that cannot reach it anyway.
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
}
