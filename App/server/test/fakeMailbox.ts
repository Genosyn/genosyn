import type { GmailHeader, ParsedAttachment } from "../services/mail/gmailClient.js";
import type {
  DraftRef,
  LabelRef,
  Mailbox,
  MailboxLabel,
  MailboxMessage,
  MailboxThreadState,
  MessageRef,
  ThreadRef,
} from "../services/mail/mailbox/types.js";
import type { MimeFields } from "../services/mail/mime.js";

/**
 * An in-memory {@link Mailbox} for tests.
 *
 * The Email section's shared code — thread actions, drafts, attachments, the
 * unsubscribe gate — is provider-neutral, so the interesting behaviour can be
 * tested against a mailbox that is a few Maps rather than against Gmail's REST
 * API or an IMAP server. Every call is recorded in {@link FakeMailbox.calls}
 * so a test can assert what was asked of the server as well as what came back.
 *
 * It is deliberately strict: an operation on a message or draft it does not
 * hold throws, exactly as a real server would, because a fake that quietly
 * succeeds turns a genuine bug into a passing test.
 */
export type FakeMailboxCall = { method: string; args: unknown[] };

export class FakeMailbox implements Mailbox {
  readonly kind = "gmail" as const;
  readonly displayName = "Fake Mail";
  readonly calls: FakeMailboxCall[] = [];

  labels: MailboxLabel[] = [
    { ref: "INBOX", name: "Inbox", labelType: "system", color: "" },
    { ref: "UNREAD", name: "Unread", labelType: "system", color: "" },
  ];
  messages = new Map<MessageRef, MailboxMessage>();
  drafts = new Map<DraftRef, MessageRef>();
  attachments = new Map<string, Buffer>();

  /** Set to make the next call of a given method throw. */
  failNext: Record<string, Error | undefined> = {};

  /**
   * How the backend identifies a message it has just sent from a draft.
   *
   * Gmail reissues the message id, so the sent copy is a new row. IMAP appends
   * the draft's own bytes into Sent, so the copy carries the same
   * `Message-ID` and lands on the draft's existing row — which is where the
   * interesting bugs live. A fake that only ever models Gmail cannot see them.
   */
  sentIdentity: "reissued" | "same-as-draft" = "reissued";

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const failure = this.failNext[method];
    if (failure) {
      this.failNext[method] = undefined;
      throw failure;
    }
  }

  /** Seed a message. Returns it so a test can keep the ref. */
  seed(message: Partial<MailboxMessage> & { ref: string; threadRef: string }): MailboxMessage {
    const full: MailboxMessage = {
      labelIds: ["INBOX"],
      headers: [],
      snippet: "",
      bodyText: "",
      bodyHtml: "",
      attachments: [],
      sentAt: null,
      sizeEstimate: 0,
      hasBodies: true,
      location: "",
      ...message,
    };
    this.messages.set(full.ref, full);
    return full;
  }

  async listLabels(): Promise<MailboxLabel[]> {
    this.record("listLabels");
    return this.labels;
  }

  async createLabel(name: string): Promise<MailboxLabel> {
    this.record("createLabel", name);
    const label: MailboxLabel = {
      ref: `label-${name.toLowerCase().replace(/\s+/g, "-")}`,
      name,
      labelType: "user",
      color: "",
    };
    this.labels.push(label);
    return label;
  }

  private mutate(thread: ThreadRef, change: (labels: Set<string>) => void): void {
    for (const message of this.messages.values()) {
      if (message.threadRef !== thread) continue;
      const labels = new Set(message.labelIds);
      change(labels);
      message.labelIds = Array.from(labels);
    }
  }

  async setRead(thread: ThreadRef, read: boolean): Promise<void> {
    this.record("setRead", thread, read);
    this.mutate(thread, (labels) => (read ? labels.delete("UNREAD") : labels.add("UNREAD")));
  }

  async setFlagged(thread: ThreadRef, flagged: boolean): Promise<void> {
    this.record("setFlagged", thread, flagged);
    this.mutate(thread, (labels) =>
      flagged ? labels.add("STARRED") : labels.delete("STARRED"),
    );
  }

  async archive(thread: ThreadRef): Promise<void> {
    this.record("archive", thread);
    this.mutate(thread, (labels) => labels.delete("INBOX"));
  }

  async moveToInbox(thread: ThreadRef): Promise<void> {
    this.record("moveToInbox", thread);
    this.mutate(thread, (labels) => labels.add("INBOX"));
  }

  async trash(thread: ThreadRef): Promise<void> {
    this.record("trash", thread);
    this.mutate(thread, (labels) => {
      labels.delete("INBOX");
      labels.add("TRASH");
    });
  }

  async untrash(thread: ThreadRef): Promise<void> {
    this.record("untrash", thread);
    this.mutate(thread, (labels) => {
      labels.delete("TRASH");
      labels.add("INBOX");
    });
  }

  async applyLabel(thread: ThreadRef, label: LabelRef): Promise<void> {
    this.record("applyLabel", thread, label);
    this.mutate(thread, (labels) => labels.add(label));
  }

  async removeLabel(thread: ThreadRef, label: LabelRef): Promise<void> {
    this.record("removeLabel", thread, label);
    this.mutate(thread, (labels) => labels.delete(label));
  }

  async readThreadState(thread: ThreadRef): Promise<MailboxThreadState> {
    this.record("readThreadState", thread);
    return Array.from(this.messages.values())
      .filter((m) => m.threadRef === thread)
      .map((m) => ({ ref: m.ref, labelIds: m.labelIds }));
  }

  async getMessage(ref: MessageRef): Promise<MailboxMessage> {
    this.record("getMessage", ref);
    const message = this.messages.get(ref);
    if (!message) throw new Error(`No such message: ${ref}`);
    return message;
  }

  async getMessageHeaders(ref: MessageRef): Promise<GmailHeader[]> {
    this.record("getMessageHeaders", ref);
    return (await this.getMessage(ref)).headers;
  }

  async getAttachmentBytes(ref: MessageRef, part: ParsedAttachment): Promise<Buffer> {
    this.record("getAttachmentBytes", ref, part.attachmentId);
    return this.attachments.get(part.attachmentId) ?? Buffer.alloc(0);
  }

  async sendMessage(args: { mime: MimeFields; thread?: ThreadRef }): Promise<MailboxMessage> {
    this.record("sendMessage", args.mime, args.thread);
    return this.materialize(args.mime, args.thread, ["SENT"]);
  }

  async createDraft(args: {
    mime: MimeFields;
    thread?: ThreadRef;
  }): Promise<{ draftRef: DraftRef; message: MailboxMessage }> {
    this.record("createDraft", args.mime, args.thread);
    const message = this.materialize(args.mime, args.thread, ["DRAFT"]);
    const draftRef = `draft-${message.ref}`;
    this.drafts.set(draftRef, message.ref);
    return { draftRef, message };
  }

  async updateDraft(args: {
    draftRef: DraftRef;
    mime: MimeFields;
    thread?: ThreadRef;
  }): Promise<{ draftRef: DraftRef; message: MailboxMessage }> {
    this.record("updateDraft", args.draftRef, args.mime, args.thread);
    const previous = this.drafts.get(args.draftRef);
    if (!previous) throw new Error(`No such draft: ${args.draftRef}`);
    this.messages.delete(previous);
    this.drafts.delete(args.draftRef);
    const message = this.materialize(args.mime, args.thread, ["DRAFT"]);
    const draftRef = `draft-${message.ref}`;
    this.drafts.set(draftRef, message.ref);
    return { draftRef, message };
  }

  async sendDraft(draftRef: DraftRef): Promise<MailboxMessage> {
    this.record("sendDraft", draftRef);
    const ref = this.drafts.get(draftRef);
    if (!ref) throw new Error(`No such draft: ${draftRef}`);
    const draft = this.messages.get(ref);
    if (!draft) throw new Error(`No such draft message: ${ref}`);
    this.drafts.delete(draftRef);
    this.messages.delete(ref);
    const sentRef = this.sentIdentity === "reissued" ? `${ref}-sent` : ref;
    const sent: MailboxMessage = { ...draft, ref: sentRef, labelIds: ["SENT"] };
    this.messages.set(sent.ref, sent);
    return sent;
  }

  async deleteDraft(draftRef: DraftRef): Promise<void> {
    this.record("deleteDraft", draftRef);
    const ref = this.drafts.get(draftRef);
    if (ref) this.messages.delete(ref);
    this.drafts.delete(draftRef);
  }

  async listDraftRefs(): Promise<Array<{ draftRef: DraftRef; messageRef: MessageRef }>> {
    this.record("listDraftRefs");
    return Array.from(this.drafts, ([draftRef, messageRef]) => ({ draftRef, messageRef }));
  }

  private nextId = 0;

  private materialize(mime: MimeFields, thread: string | undefined, labels: string[]) {
    this.nextId += 1;
    const ref = `msg-${this.nextId}`;
    const headers: GmailHeader[] = [
      { name: "To", value: mime.to },
      { name: "Subject", value: mime.subject },
    ];
    if (mime.cc) headers.push({ name: "Cc", value: mime.cc });
    if (mime.bcc) headers.push({ name: "Bcc", value: mime.bcc });
    const message: MailboxMessage = {
      ref,
      threadRef: thread ?? `thread-${ref}`,
      labelIds: labels,
      headers,
      snippet: mime.bodyText.slice(0, 80),
      bodyText: mime.bodyText,
      bodyHtml: mime.bodyHtml ?? "",
      attachments: (mime.attachments ?? []).map((a, index) => ({
        partId: String(index + 1),
        attachmentId: `att-${ref}-${index + 1}`,
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.content.length,
      })),
      sentAt: new Date("2026-01-01T00:00:00Z"),
      sizeEstimate: mime.bodyText.length,
      hasBodies: true,
      location: "",
    };
    for (const [index, attachment] of (mime.attachments ?? []).entries()) {
      this.attachments.set(`att-${ref}-${index + 1}`, attachment.content);
    }
    this.messages.set(ref, message);
    return message;
  }
}
