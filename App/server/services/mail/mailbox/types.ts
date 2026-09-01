import type { MailAccount } from "../../../db/entities/MailAccount.js";
import type { GmailHeader, ParsedAttachment } from "../gmailClient.js";
import type { MimeFields } from "../mime.js";

/**
 * What the Email section needs a mailbox to do, said once, without naming a
 * provider.
 *
 * Before this interface existed, `actions.ts` imported nine functions straight
 * out of `gmailClient.ts` and spoke Gmail's own vocabulary in shared code:
 * `modifyThread(token, id, ["STARRED"], [])` to star a conversation,
 * `modifyThread(token, id, [], ["INBOX"])` to archive one. That reads fine
 * while Gmail is the only mailbox in the product and becomes a wall the moment
 * it is not, because "remove the INBOX label" is not a thing an IMAP server
 * can be asked to do.
 *
 * So the interface is **semantic**: `archive(thread)`, `setFlagged(thread,
 * true)`. Each adapter says what that means upstream — Gmail toggles a label,
 * IMAP moves the message between folders or sets a flag — and shared code
 * never learns which happened.
 *
 * ## The one shared vocabulary: labels
 *
 * Everything downstream of the mirror — the sidebar counts in `routes/mail.ts`,
 * the `from:`/`in:` search grammar in `searchQuery.ts`, the rule engine, the
 * MCP tools — reads `MailMessage.labelIds`. Rather than teach all of them a
 * second dialect, **every adapter normalizes into one canonical label set**
 * ({@link CANONICAL_LABELS}), which happens to be the one Gmail already uses.
 * The Gmail adapter passes labels through unchanged; the IMAP adapter derives
 * them from the message's folder and IMAP flags. A conversation in the
 * `\Junk` folder arrives labelled `SPAM`, a message without `\Seen` arrives
 * labelled `UNREAD`, and every consumer keeps working with no change at all.
 *
 * ## Refs are opaque strings
 *
 * Threads, messages, labels and drafts are addressed by strings the adapter
 * mints and only the adapter interprets. They live in the mirror's existing
 * `gmailThreadId` / `gmailMessageId` / `gmailLabelId` / `gmailDraftId`
 * columns, which now hold "the provider's handle" rather than specifically
 * Gmail's. The columns keep their names on purpose: renaming them would
 * rewrite five tables and ~50 call sites to change nothing a user can see,
 * and this codebase already carries that precedent (`code_repositories` still
 * backs the Repository section). The doc comments on the entities say what
 * they really hold.
 */

/** Which backend a mailbox speaks. Persisted on `MailAccount.provider`. */
export type MailboxKind = "gmail" | "imap";

/** An opaque, adapter-minted handle for one conversation. */
export type ThreadRef = string;
/** An opaque, adapter-minted handle for one message. */
export type MessageRef = string;
/** An opaque, adapter-minted handle for one label (Gmail) or folder (IMAP). */
export type LabelRef = string;
/** An opaque, adapter-minted handle for one draft. */
export type DraftRef = string;

/**
 * The canonical label ids every adapter normalizes into.
 *
 * These are Gmail's own system-label ids, kept as the canonical set because
 * the mirror, the search grammar, the sidebar and every rule already speak
 * them — adopting a new vocabulary would have meant migrating live data and
 * every saved search for no user-visible gain.
 */
export const CANONICAL_LABELS = {
  inbox: "INBOX",
  unread: "UNREAD",
  starred: "STARRED",
  important: "IMPORTANT",
  sent: "SENT",
  draft: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
} as const;

export type MailboxLabel = {
  ref: LabelRef;
  name: string;
  /** `system` labels are the canonical set above; `user` labels are the
   * person's own — a Gmail label, or an IMAP folder they created. */
  labelType: "system" | "user";
  color: string;
};

/**
 * One message, normalized.
 *
 * This is what the mirror's write path consumes, whatever produced it: the
 * Gmail adapter converts a `GmailMessage`, the IMAP adapter parses RFC 822
 * bytes. Bodies arrive already extracted and already decoded, so `store.ts`
 * does no provider-shaped work.
 */
export type MailboxMessage = {
  ref: MessageRef;
  threadRef: ThreadRef;
  labelIds: string[];
  headers: GmailHeader[];
  /** Plain text, entities already decoded. */
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  attachments: ParsedAttachment[];
  sentAt: Date | null;
  sizeEstimate: number;
  /**
   * False when this representation carries headers but no bodies — a Gmail
   * `metadata` fetch, or an IMAP header-only fetch during a slow backfill.
   * The mirror keeps whatever bodies it already had rather than blanking a
   * message that was fully imported an hour ago.
   */
  hasBodies: boolean;
  /**
   * Where the message currently sits upstream, when the provider needs that
   * to find it again. Persisted to `MailMessage.providerLocation`; empty for
   * Gmail, whose message id is address enough.
   */
  location: string;
};

/** One conversation's per-message label state, for the post-mutation re-read. */
export type MailboxThreadState = Array<{ ref: MessageRef; labelIds: string[] }>;

/**
 * A mailbox the Email section can drive.
 *
 * Every method is allowed to throw; callers surface the message. Adapters own
 * their own credentials and connection lifecycle, which is why no method takes
 * a token — an IMAP adapter holds a pooled, serialized connection and a Gmail
 * adapter refreshes an OAuth token, and neither concern reaches shared code.
 */
export interface Mailbox {
  readonly kind: MailboxKind;
  /** What to call the upstream in a message a person will read. */
  readonly displayName: string;

  listLabels(): Promise<MailboxLabel[]>;
  createLabel(name: string): Promise<MailboxLabel>;

  setRead(thread: ThreadRef, read: boolean): Promise<void>;
  setFlagged(thread: ThreadRef, flagged: boolean): Promise<void>;
  archive(thread: ThreadRef): Promise<void>;
  moveToInbox(thread: ThreadRef): Promise<void>;
  trash(thread: ThreadRef): Promise<void>;
  untrash(thread: ThreadRef): Promise<void>;
  applyLabel(thread: ThreadRef, label: LabelRef): Promise<void>;
  removeLabel(thread: ThreadRef, label: LabelRef): Promise<void>;

  /** Re-read a conversation's label state after a mutation, cheaply. */
  readThreadState(thread: ThreadRef): Promise<MailboxThreadState>;

  getMessage(ref: MessageRef): Promise<MailboxMessage>;
  /** Headers only — the unsubscribe path needs live `List-Unsubscribe*`. */
  getMessageHeaders(ref: MessageRef): Promise<GmailHeader[]>;
  /** Decoded bytes of one attachment. `part` is the handle the adapter put in
   * {@link MailboxMessage.attachments}. */
  getAttachmentBytes(ref: MessageRef, part: ParsedAttachment): Promise<Buffer>;

  sendMessage(args: { mime: MimeFields; thread?: ThreadRef }): Promise<MailboxMessage>;
  createDraft(args: {
    mime: MimeFields;
    thread?: ThreadRef;
  }): Promise<{ draftRef: DraftRef; message: MailboxMessage }>;
  updateDraft(args: {
    draftRef: DraftRef;
    mime: MimeFields;
    thread?: ThreadRef;
  }): Promise<{ draftRef: DraftRef; message: MailboxMessage }>;
  sendDraft(draftRef: DraftRef): Promise<MailboxMessage>;
  deleteDraft(draftRef: DraftRef): Promise<void>;

  /** Every draft upstream, so the mirror can reconcile `gmailDraftId`. */
  listDraftRefs(): Promise<Array<{ draftRef: DraftRef; messageRef: MessageRef }>>;
}

/** What an adapter needs to build itself. */
export type MailboxContext = {
  account: MailAccount;
};
