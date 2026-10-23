import type { RequestListener } from "node:http";
import type { CallerStanding } from "./catalogue.js";

/**
 * Who a Genosyn MCP request comes from, and how to reach the App on their
 * behalf. Built by the route from the authenticated request (the key, its
 * Member, their standing in the company) and handed to every tool.
 *
 * The tools never act on this directly: `authorization` is the exact header
 * the MCP request carried, so each operation they call is authenticated —
 * and authorized — by the App afresh, as if the client had called the REST
 * API itself.
 */
export type CallerContext = {
  /** The Express app the server listens with; operations are sent to it in memory. */
  app: RequestListener;
  companyId: string;
  companyName: string;
  member: { id: string; name: string; email: string };
  /** The Member's role and Finance access as the request found them. */
  standing: CallerStanding;
  apiKey: { id: string; name: string; prefix: string };
  /** The `Authorization` header to send with every operation: the same API key. */
  authorization: string;
  /**
   * Headers the inner request repeats so the App sees the same caller: host,
   * user agent, language, and the proxy's `X-Forwarded-*` chain.
   */
  forwardedHeaders: Record<string, string>;
  /** The MCP request's peer, which the inner request reports as its own. */
  remote: { address?: string; port?: number; family?: string; encrypted?: boolean };
  /** The origin the client reached this server at, for links it can follow: `https://host`. */
  baseUrl: string;
};

/** Headers an operation repeats from the MCP request it was called from. */
export const FORWARDED_HEADERS = [
  "host",
  "user-agent",
  "accept-language",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
] as const;
