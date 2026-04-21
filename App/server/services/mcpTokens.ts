import crypto from "node:crypto";

/**
 * Short-lived auth tokens for the built-in Genosyn MCP server.
 *
 * Every time `chat.ts` or `runner.ts` spawns a provider CLI for an employee,
 * we mint a token, stamp it into `.mcp.json` via an env var, and remember the
 * `{employeeId, companyId}` behind it here. When the MCP binary talks back to
 * our HTTP API, it presents the token as a Bearer credential and the internal
 * router resolves it to the acting employee.
 *
 * Kept in-process on purpose: the MCP binary always runs on the same host as
 * the Express server, and we don't want to persist tokens across restarts
 * (that would widen the blast radius of a leaked token with no real upside).
 */

export type McpTokenInfo = {
  token: string;
  employeeId: string;
  companyId: string;
  expiresAt: number;
};

const TTL_MS = 60 * 60 * 1000; // 1h covers the longest routine timeoutSec cap

const tokens = new Map<string, McpTokenInfo>();

/**
 * Mint a fresh token for an employee + company. 32 random bytes gives ~128
 * bits of entropy — plenty for a token that lives in memory and expires on
 * the hour.
 */
export function issueMcpToken(employeeId: string, companyId: string): string {
  sweep();
  const token = crypto.randomBytes(32).toString("hex");
  tokens.set(token, {
    token,
    employeeId,
    companyId,
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

/**
 * Resolve a token to its owner, or `null` if unknown / expired. Does not
 * consume the token — a single spawn can make many tool calls, and each
 * call must succeed for the full TTL window.
 */
export function resolveMcpToken(token: string): McpTokenInfo | null {
  const info = tokens.get(token);
  if (!info) return null;
  if (info.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return info;
}

/**
 * Revoke a token early — e.g. after the spawn finishes. Best-effort; the
 * sweep below handles tokens that are never explicitly revoked.
 */
export function revokeMcpToken(token: string): void {
  tokens.delete(token);
}

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of tokens) {
    if (v.expiresAt < now) tokens.delete(k);
  }
}
