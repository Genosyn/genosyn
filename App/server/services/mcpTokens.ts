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
  /**
   * The Run and Routine this token was minted for, when the spawn came from the
   * routine runner. Null for the chat seam and external MCP sessions, which
   * have an employee but no Run. Tools that record provenance (mail drafts, for
   * one) read these so a write can be traced back to the Routine that made it.
   */
  runId: string | null;
  routineId: string | null;
  expiresAt: number;
};

// Must outlive the longest a spawn can run so a routine's genosyn MCP
// callbacks keep resolving for its whole life. Routine `timeoutSec` caps at
// 6h (see routes/routines.ts), so 7h leaves an hour of margin over a routine
// that runs right up to the cap. The runner/chat seams revoke their token the
// moment a spawn finishes, so on the happy path this TTL only backstops
// spawns that die without cleaning up.
const TTL_MS = 7 * 60 * 60 * 1000;

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
 * Per-token staging area for arbitrary structured payloads a tool wants to
 * hand back to whichever surface ran the turn — same lifecycle as
 * `stagedAttachments`, but keyed by a payload kind so unrelated tools don't
 * trample each other. Today the only producer is `suggest_mail_actions`
 * (kind "mail.suggestions"); per-email AI chat drains it after the turn and
 * renders the payloads as one-click action buttons.
 */
const stagedSidecars = new Map<string, Map<string, unknown[]>>();

/**
 * Mint a fresh token for an employee + company. 32 random bytes gives ~128
 * bits of entropy — plenty for a token that lives in memory and expires on
 * the hour.
 *
 * `origin` is optional so the chat seam and external MCP sessions — which have
 * no Run — keep calling this with two arguments; the routine runner passes the
 * Run and Routine it is executing so tool writes can record their provenance.
 */
export function issueMcpToken(
  employeeId: string,
  companyId: string,
  origin: { runId?: string; routineId?: string } = {},
): string {
  sweep();
  const token = crypto.randomBytes(32).toString("hex");
  tokens.set(token, {
    token,
    employeeId,
    companyId,
    runId: origin.runId ?? null,
    routineId: origin.routineId ?? null,
    expiresAt: Date.now() + TTL_MS,
  });
  return token;
}

export function stageAttachmentForToken(token: string, attachmentId: string): void {
  // A revoked token's drain has already run (or never will) — staging for it
  // would leak the entry for the life of the process.
  if (!tokens.has(token)) return;
  const list = stagedAttachments.get(token) ?? [];
  list.push(attachmentId);
  stagedAttachments.set(token, list);
}

export function drainAttachmentsForToken(token: string): string[] {
  const list = stagedAttachments.get(token);
  stagedAttachments.delete(token);
  return list ?? [];
}

export function stageSidecarForToken(token: string, kind: string, payload: unknown): void {
  // Same dead-token guard as attachments: a handler that finishes after the
  // turn's revoke must not resurrect an undrainable entry.
  if (!tokens.has(token)) return;
  const byKind = stagedSidecars.get(token) ?? new Map<string, unknown[]>();
  const list = byKind.get(kind) ?? [];
  list.push(payload);
  byKind.set(kind, list);
  stagedSidecars.set(token, byKind);
}

/** Drain every staged sidecar payload for a token, grouped by kind. */
export function drainSidecarsForToken(token: string): Record<string, unknown[]> {
  const byKind = stagedSidecars.get(token);
  stagedSidecars.delete(token);
  if (!byKind) return {};
  return Object.fromEntries(byKind);
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
  stagedSidecars.delete(token);
}

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of tokens) {
    if (v.expiresAt < now) {
      tokens.delete(k);
      stagedAttachments.delete(k);
      stagedSidecars.delete(k);
    }
  }
  // Reclaim staged entries whose token is gone entirely — belt-and-braces
  // against any staging that raced a revoke.
  for (const k of stagedAttachments.keys()) {
    if (!tokens.has(k)) stagedAttachments.delete(k);
  }
  for (const k of stagedSidecars.keys()) {
    if (!tokens.has(k)) stagedSidecars.delete(k);
  }
}
