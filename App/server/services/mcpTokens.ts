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
 * Per-token staging area for attachment ids the AI uploaded during this
 * turn via the `send_chat_attachment` MCP tool. The chat seam drains this
 * before revoking the token and the caller (employee/workspace chat)
 * binds the ids to the assistant message after persisting.
 *
 * Kept separate from the McpTokenInfo struct so callers that don't care
 * about attachments don't have to plumb empty arrays around.
 */
const stagedAttachments = new Map<string, string[]>();

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

export function stageAttachmentForToken(
  token: string,
  attachmentId: string,
): void {
  const list = stagedAttachments.get(token) ?? [];
  list.push(attachmentId);
  stagedAttachments.set(token, list);
}

export function drainAttachmentsForToken(token: string): string[] {
  const list = stagedAttachments.get(token);
  stagedAttachments.delete(token);
  return list ?? [];
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
  stagedAttachments.delete(token);
}

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of tokens) {
    if (v.expiresAt < now) {
      tokens.delete(k);
      stagedAttachments.delete(k);
    }
  }
}
