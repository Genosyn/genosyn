import crypto from "node:crypto";
import type { MimeAttachment } from "./gmailClient.js";

/**
 * In-memory staging area for outbound attachments.
 *
 * The compose flow uploads files first (getting back a token each), then
 * sends/drafts referencing those tokens. Keeping the bytes in memory with a
 * short TTL avoids a new on-disk artifact for something that lives for
 * seconds — a staged attachment is drained into the MIME message the moment
 * the mail is sent or saved as a draft. Bounded per account so a stuck tab
 * can't grow the heap without limit.
 */

type Staged = {
  id: string;
  accountId: string;
  filename: string;
  mimeType: string;
  content: Buffer;
  stagedAt: number;
};

const TTL_MS = 60 * 60 * 1000; // 1h — plenty for composing a message.
/** Cap on total staged bytes per account. Matches the 25 MB human upload cap
 * used elsewhere, times a small fan-out for several files in one draft. */
const MAX_BYTES_PER_ACCOUNT = 25 * 1024 * 1024;

const staged = new Map<string, Staged>();

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, s] of staged) {
    if (s.stagedAt < cutoff) staged.delete(id);
  }
}

export type StagedAttachmentInfo = {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
};

/** Stage one file. Throws when the account's staged total would exceed the
 * cap. Returns the token the client references at send/draft time. */
export function stageAttachment(args: {
  accountId: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}): StagedAttachmentInfo {
  sweep();
  let used = 0;
  for (const s of staged.values()) {
    if (s.accountId === args.accountId) used += s.content.length;
  }
  if (used + args.content.length > MAX_BYTES_PER_ACCOUNT) {
    throw new Error("Attachment staging limit reached — send or remove pending files first.");
  }
  const id = crypto.randomBytes(16).toString("hex");
  staged.set(id, {
    id,
    accountId: args.accountId,
    filename: args.filename || "attachment",
    mimeType: args.mimeType || "application/octet-stream",
    content: args.content,
    stagedAt: Date.now(),
  });
  return {
    id,
    filename: args.filename || "attachment",
    mimeType: args.mimeType || "application/octet-stream",
    size: args.content.length,
  };
}

/**
 * Resolve staged tokens to MIME attachments for one account and remove them
 * from the store. Unknown/expired/other-account tokens are skipped silently —
 * a caller can't reach another account's files, and a dropped token just
 * means that file won't attach (surfaced to the user as a missing file, not
 * a crash).
 */
export function drainAttachments(
  accountId: string,
  ids: string[],
): MimeAttachment[] {
  sweep();
  const out: MimeAttachment[] = [];
  for (const id of ids) {
    const s = staged.get(id);
    if (!s || s.accountId !== accountId) continue;
    staged.delete(id);
    out.push({ filename: s.filename, mimeType: s.mimeType, content: s.content });
  }
  return out;
}
