import type { MailAccount } from "../../../db/entities/MailAccount.js";
import { accessTokenForAccount } from "../accounts.js";
import {
  createDraft,
  createLabel,
  decodeHtmlEntities,
  deleteDraft,
  extractBodies,
  getAttachment,
  getMessage,
  getThread,
  listDrafts,
  listLabels,
  modifyThread,
  sendDraft,
  sendMessage,
  trashThread,
  untrashThread,
  updateDraft,
  type GmailHeader,
  type GmailMessage,
  type ParsedAttachment,
} from "../gmailClient.js";
import { buildMimeString, toBase64Url, type MimeFields } from "../mime.js";
import {
  CANONICAL_LABELS,
  type DraftRef,
  type LabelRef,
  type Mailbox,
  type MailboxLabel,
  type MailboxMessage,
  type MailboxThreadState,
  type MessageRef,
  type ThreadRef,
} from "./types.js";

/**
 * Gmail, behind the neutral {@link Mailbox} interface.
 *
 * This adapter is deliberately thin: Gmail's own vocabulary *is* the canonical
 * vocabulary (see `types.ts`), so labels pass straight through and every
 * semantic method is one `modifyThread` call. The value of the file is that
 * the Gmail-shaped calls now stop here instead of appearing in `actions.ts`.
 *
 * Tokens are resolved per operation through `accessTokenForAccount`, which
 * refreshes and persists a rotated one. That is one extra decrypt per call and
 * exactly what the code did before this interface existed — caching a token on
 * the adapter would mean a long-lived object could out-live a reconnect and
 * keep using credentials the company has already replaced.
 */
export class GmailMailbox implements Mailbox {
  readonly kind = "gmail" as const;
  readonly displayName = "Gmail";

  constructor(private readonly account: MailAccount) {}

  private token(): Promise<string> {
    return accessTokenForAccount(this.account);
  }

  async listLabels(): Promise<MailboxLabel[]> {
    const labels = await listLabels(await this.token());
    return labels.map((l) => ({
      ref: l.id,
      name: l.name,
      labelType: l.type === "system" ? "system" : "user",
      color: l.color?.backgroundColor ?? "",
    }));
  }

  async createLabel(name: string): Promise<MailboxLabel> {
    const created = await createLabel(await this.token(), name);
    return { ref: created.id, name: created.name, labelType: "user", color: "" };
  }

  async setRead(thread: ThreadRef, read: boolean): Promise<void> {
    const token = await this.token();
    if (read) await modifyThread(token, thread, [], [CANONICAL_LABELS.unread]);
    else await modifyThread(token, thread, [CANONICAL_LABELS.unread], []);
  }

  async setFlagged(thread: ThreadRef, flagged: boolean): Promise<void> {
    const token = await this.token();
    if (flagged) await modifyThread(token, thread, [CANONICAL_LABELS.starred], []);
    else await modifyThread(token, thread, [], [CANONICAL_LABELS.starred]);
  }

  async archive(thread: ThreadRef): Promise<void> {
    await modifyThread(await this.token(), thread, [], [CANONICAL_LABELS.inbox]);
  }

  async moveToInbox(thread: ThreadRef): Promise<void> {
    await modifyThread(await this.token(), thread, [CANONICAL_LABELS.inbox], []);
  }

  async trash(thread: ThreadRef): Promise<void> {
    await trashThread(await this.token(), thread);
  }

  async untrash(thread: ThreadRef): Promise<void> {
    await untrashThread(await this.token(), thread);
  }

  async applyLabel(thread: ThreadRef, label: LabelRef): Promise<void> {
    await modifyThread(await this.token(), thread, [label], []);
  }

  async removeLabel(thread: ThreadRef, label: LabelRef): Promise<void> {
    await modifyThread(await this.token(), thread, [], [label]);
  }

  async readThreadState(thread: ThreadRef): Promise<MailboxThreadState> {
    const minimal = await getThread(await this.token(), thread, "minimal");
    return (minimal.messages ?? []).map((m) => ({ ref: m.id, labelIds: m.labelIds ?? [] }));
  }

  async getMessage(ref: MessageRef): Promise<MailboxMessage> {
    return toMailboxMessage(await getMessage(await this.token(), ref, "full"));
  }

  async getMessageHeaders(ref: MessageRef): Promise<GmailHeader[]> {
    const message = await getMessage(await this.token(), ref, "metadata");
    return message.payload?.headers ?? [];
  }

  async getAttachmentBytes(ref: MessageRef, part: ParsedAttachment): Promise<Buffer> {
    const payload = await getAttachment(await this.token(), ref, part.attachmentId);
    // Empty rather than thrown: the caller turns no bytes into a 404 with a
    // message about the attachment, which is what a person asking for a file
    // that is no longer there should get — not a 500 about Gmail.
    if (!payload.data) return Buffer.alloc(0);
    return Buffer.from(payload.data, "base64url");
  }

  async sendMessage(args: { mime: MimeFields; thread?: ThreadRef }): Promise<MailboxMessage> {
    const token = await this.token();
    const sent = await sendMessage(token, rawFor(args.mime), args.thread);
    return toMailboxMessage(await getMessage(token, sent.id, "full"));
  }

  async createDraft(args: {
    mime: MimeFields;
    thread?: ThreadRef;
  }): Promise<{ draftRef: DraftRef; message: MailboxMessage }> {
    const token = await this.token();
    const draft = await createDraft(token, rawFor(args.mime), args.thread);
    const messageId = draft.message?.id;
    if (!messageId) throw new Error("Gmail did not return the draft message");
    return {
      draftRef: draft.id,
      message: toMailboxMessage(await getMessage(token, messageId, "full")),
    };
  }

  async updateDraft(args: {
    draftRef: DraftRef;
    mime: MimeFields;
    thread?: ThreadRef;
  }): Promise<{ draftRef: DraftRef; message: MailboxMessage }> {
    const token = await this.token();
    const updated = await updateDraft(token, args.draftRef, rawFor(args.mime), args.thread);
    const messageId = updated.message?.id;
    if (!messageId) throw new Error("Gmail did not return the updated draft message");
    return {
      draftRef: updated.id,
      message: toMailboxMessage(await getMessage(token, messageId, "full")),
    };
  }

  async sendDraft(draftRef: DraftRef): Promise<MailboxMessage> {
    const token = await this.token();
    const sent = await sendDraft(token, draftRef);
    return toMailboxMessage(await getMessage(token, sent.id, "full"));
  }

  async deleteDraft(draftRef: DraftRef): Promise<void> {
    await deleteDraft(await this.token(), draftRef);
  }

  async listDraftRefs(): Promise<Array<{ draftRef: DraftRef; messageRef: MessageRef }>> {
    const drafts = await listDrafts(await this.token());
    const out: Array<{ draftRef: DraftRef; messageRef: MessageRef }> = [];
    for (const d of drafts) {
      if (d.message?.id) out.push({ draftRef: d.id, messageRef: d.message.id });
    }
    return out;
  }
}

/** Gmail's `raw` wire format. Composition itself is transport-neutral. */
function rawFor(mime: MimeFields): string {
  return toBase64Url(buildMimeString(mime));
}

/**
 * Normalize a Gmail message into the shape the mirror stores.
 *
 * `hasBodies` says whether this representation carries the message's content,
 * and it is a parameter rather than something inferred from the payload
 * because the payload cannot answer it. A `metadata` fetch and a single-part
 * attachment message look alike from the outside — headers, no inline data,
 * no parts — and guessing wrong on the second means a message whose only
 * attachment silently stops being listed. The caller asked for a format; it
 * knows.
 */
export function toMailboxMessage(gm: GmailMessage, hasBodies = true): MailboxMessage {
  const bodies = extractBodies(gm.payload);
  const sentAtMs = Number(gm.internalDate ?? "0");
  return {
    ref: gm.id,
    threadRef: gm.threadId,
    labelIds: gm.labelIds ?? [],
    headers: gm.payload?.headers ?? [],
    snippet: decodeHtmlEntities(gm.snippet ?? ""),
    bodyText: bodies.text,
    bodyHtml: bodies.html,
    attachments: bodies.attachments,
    sentAt: sentAtMs > 0 ? new Date(sentAtMs) : null,
    sizeEstimate: gm.sizeEstimate ?? 0,
    hasBodies,
    // Gmail message ids do not move, so there is no separate address to keep.
    location: "",
  };
}
