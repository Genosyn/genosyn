import type { ImapFlow } from "imapflow";

import { AppDataSource } from "../../../db/datasource.js";
import type { MailAccount } from "../../../db/entities/MailAccount.js";
import { MailMessage } from "../../../db/entities/MailMessage.js";
import { parseAddressList } from "../../../lib/emailAddress.js";
import type { GmailHeader, ParsedAttachment } from "../gmailClient.js";
import {
  attachmentBytes,
  findSpecialFolder,
  inboxFolder,
  listFolders,
  parseSource,
  smtpSend,
  toFetched,
  withImap,
  type ImapConnectionConfig,
} from "../imapClient.js";
import {
  decodeLocation,
  decodePath,
  encodeLocation,
  encodePath,
  labelCatalog,
  labelRefForFolder,
  mailboxMessageFrom,
  messageRefFor,
  type ImapFolder,
  type ImapLocation,
} from "../imapModel.js";
import {
  buildMimeBuffer,
  generateMessageId,
  stripBccHeader,
  type MimeFields,
} from "../mime.js";
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
 * Any IMAP/SMTP mailbox, behind the neutral {@link Mailbox} interface.
 *
 * This is what lets the Email section work for a company that is not on
 * Gmail — Fastmail, iCloud, Zoho, a corporate Exchange server, a mail server
 * somebody runs themselves — with nothing to register in anyone's developer
 * console. An address and an app password is the whole setup.
 *
 * ## Two translations, and they are the whole file
 *
 * **Labels are folders.** Gmail lets a conversation carry several labels at
 * once; IMAP puts a message in exactly one folder. So applying a label here
 * *moves* the conversation, removing one moves it back to the Inbox, and
 * `createLabel` creates a folder. That is what every IMAP mail client on earth
 * does with "move to folder", it is what the person filing the mail expects,
 * and it keeps a single mental model instead of inventing a second one out of
 * IMAP keywords that half the servers in the world do not support.
 *
 * **Locations move; identities do not.** A message's UID changes every time it
 * changes folder, so this adapter keeps `MailMessage.providerLocation` current
 * as it moves things and reads it back to find them again. It is the only
 * writer of that column outside the ingest path, which is also why it is the
 * only mailbox adapter that reads the mirror at all: the mirror is the index
 * IMAP does not give us.
 */
export class ImapMailbox implements Mailbox {
  readonly kind = "imap" as const;

  /** Folder list, cached for the duration of a burst of operations. */
  private folders: { at: number; value: ImapFolder[] } | null = null;

  constructor(
    private readonly account: MailAccount,
    private readonly config: ImapConnectionConfig,
  ) {}

  get displayName(): string {
    return this.config.imapHost || "your mail server";
  }

  // ───────────────────────────── plumbing ─────────────────────────────

  private run<T>(work: (client: ImapFlow) => Promise<T>): Promise<T> {
    return withImap(this.account.id, this.config, work);
  }

  /**
   * The folder list, re-read at most every 30 seconds.
   *
   * Almost every operation needs it (to find Trash, to name a label) and it
   * changes only when somebody creates a folder, so re-listing per call would
   * be a round trip per click for information that is essentially static.
   */
  private async folderList(client: ImapFlow): Promise<ImapFolder[]> {
    if (this.folders && Date.now() - this.folders.at < 30_000) return this.folders.value;
    const value = await listFolders(client);
    this.folders = { at: Date.now(), value };
    return value;
  }

  /** Forget the cached folder list — after creating one, or on a resync. */
  invalidateFolders(): void {
    this.folders = null;
  }

  /**
   * Open the folder a stored location names, refusing it if the server has
   * renumbered since.
   *
   * `UIDVALIDITY` changing means "forget every UID I gave you for this
   * folder". A UID from before the change still *addresses* something
   * afterwards — it just addresses a different message. Acting on it would
   * star, move or delete somebody else's mail, silently and with no way to
   * tell afterwards, so a mismatch is a refusal rather than a best effort.
   * The next sync pass re-imports the folder and the operation works again.
   */
  /**
   * Keep only the items whose stored UIDVALIDITY still matches the open
   * folder. Same reason as {@link lockAt}: a stale UID addresses the wrong
   * message, and acting on the wrong message is worse than not acting.
   */
  private static live<T extends { at: ImapLocation }>(client: ImapFlow, items: T[]): T[] {
    const current = client.mailbox ? String(client.mailbox.uidValidity) : "";
    if (!current) return items;
    return items.filter((item) => item.at.uidValidity === current);
  }

  private async lockAt(
    client: ImapFlow,
    at: ImapLocation,
  ): Promise<{ release: () => void }> {
    const lock = await client.getMailboxLock(at.folder);
    const current = client.mailbox ? String(client.mailbox.uidValidity) : "";
    if (current && current !== at.uidValidity) {
      lock.release();
      throw new StaleLocationError(at.folder);
    }
    return lock;
  }

  /**
   * Where this conversation's messages currently live, grouped by folder.
   *
   * Read from the mirror, which is the only place that knows: IMAP can find a
   * message by `Message-ID` only with a `SEARCH` per folder, and doing that on
   * every star click would be several round trips to answer a question we
   * already wrote down at ingest.
   */
  private async locationsFor(
    thread: ThreadRef,
    options: { required?: boolean } = {},
  ): Promise<Array<{ row: MailMessage; at: ImapLocation }>> {
    const rows = await AppDataSource.getRepository(MailMessage).find({
      where: { accountId: this.account.id, gmailThreadId: thread },
    });
    const out: Array<{ row: MailMessage; at: ImapLocation }> = [];
    for (const row of rows) {
      const at = decodeLocation(row.providerLocation);
      if (at) out.push({ row, at });
    }
    // A conversation whose rows carry no usable address cannot be acted on —
    // it is mid-import, or a move on a server without UIDPLUS blanked the
    // locations for the next pass to re-find. Doing nothing and reporting
    // success is the worst of the three options: the person sees the thread
    // marked read in the list, reloads, and finds it unread again with no
    // explanation. Callers that are merely refreshing pass `required: false`.
    if (options.required !== false && rows.length > 0 && out.length === 0) {
      throw new Error(
        "Genosyn has not finished locating this conversation on the mail server. Try again in a minute.",
      );
    }
    return out;
  }

  private async locationForMessage(ref: MessageRef): Promise<{ row: MailMessage; at: ImapLocation }> {
    const row = await AppDataSource.getRepository(MailMessage).findOneBy({
      accountId: this.account.id,
      gmailMessageId: ref,
    });
    if (!row) throw new Error("That message is not in this mailbox any more.");
    const at = decodeLocation(row.providerLocation);
    if (!at) {
      throw new Error("Genosyn has not finished importing that message yet — try again shortly.");
    }
    return { row, at };
  }

  /** Group locations by folder so each folder is opened once. */
  private static byFolder(
    items: Array<{ row: MailMessage; at: ImapLocation }>,
  ): Map<string, Array<{ row: MailMessage; at: ImapLocation }>> {
    const map = new Map<string, Array<{ row: MailMessage; at: ImapLocation }>>();
    for (const item of items) {
      const list = map.get(item.at.folder);
      if (list) list.push(item);
      else map.set(item.at.folder, [item]);
    }
    return map;
  }

  private async persistLocations(
    updates: Array<{ id: string; location: string }>,
  ): Promise<void> {
    const repo = AppDataSource.getRepository(MailMessage);
    for (const update of updates) {
      await repo.update({ id: update.id }, { providerLocation: update.location });
    }
  }

  // ───────────────────────────── labels ─────────────────────────────

  async listLabels(): Promise<MailboxLabel[]> {
    return this.run(async (client) => labelCatalog(await this.folderList(client)));
  }

  async createLabel(name: string): Promise<MailboxLabel> {
    const path = name.trim();
    if (!path) throw new Error("A label needs a name");
    return this.run(async (client) => {
      // `mailboxCreate` reports `created: false` for a folder that was already
      // there, which is the outcome we want either way — the caller asked for
      // a label with this name to exist.
      const created = await client.mailboxCreate(path);
      this.invalidateFolders();
      return {
        ref: `f:${encodePath(created.path)}`,
        name: created.path,
        labelType: "user" as const,
        color: "",
      };
    });
  }

  // ───────────────────────────── flags ─────────────────────────────

  private async setFlag(thread: ThreadRef, flag: string, on: boolean): Promise<void> {
    const items = await this.locationsFor(thread);
    if (items.length === 0) return;
    await this.run(async (client) => {
      for (const [folder, group] of ImapMailbox.byFolder(items)) {
        const lock = await client.getMailboxLock(folder);
        try {
          const uids = ImapMailbox.live(client, group).map((g) => g.at.uid);
          if (uids.length === 0) continue;
          if (on) await client.messageFlagsAdd(uids, [flag], { uid: true });
          else await client.messageFlagsRemove(uids, [flag], { uid: true });
        } finally {
          lock.release();
        }
      }
    });
  }

  async setRead(thread: ThreadRef, read: boolean): Promise<void> {
    await this.setFlag(thread, "\\Seen", read);
  }

  async setFlagged(thread: ThreadRef, flagged: boolean): Promise<void> {
    await this.setFlag(thread, "\\Flagged", flagged);
  }

  // ───────────────────────────── moving ─────────────────────────────

  /**
   * Move a conversation's messages into `destination`.
   *
   * `only` narrows the move to messages currently in one folder, which is how
   * Archive means "take it out of the Inbox" without also dragging the copy
   * that is sitting in Sent.
   *
   * The `uidMap` a server returns for a `UID MOVE` is the whole reason this
   * bothers to write back: without it the mirror would still be pointing at
   * UIDs in the folder the messages just left.
   */
  private async moveThread(
    thread: ThreadRef,
    destination: string,
    only?: (folder: string) => boolean,
  ): Promise<void> {
    const all = await this.locationsFor(thread);
    const items = only ? all.filter((i) => only(i.at.folder)) : all;
    const movable = items.filter((i) => i.at.folder !== destination);
    if (movable.length === 0) return;
    const updates: Array<{ id: string; location: string }> = [];
    await this.run(async (client) => {
      for (const [folder, group] of ImapMailbox.byFolder(movable)) {
        const lock = await client.getMailboxLock(folder);
        try {
          const movable = ImapMailbox.live(client, group);
          if (movable.length === 0) continue;
          const uids = movable.map((g) => g.at.uid);
          const result = await client.messageMove(uids, destination, { uid: true });
          const uidMap = (result as { uidMap?: Map<number, number> }).uidMap;
          const uidValidity = (result as { uidValidity?: bigint }).uidValidity;
          for (const item of movable) {
            const newUid = uidMap?.get(item.at.uid);
            updates.push({
              id: item.row.id,
              location: newUid
                ? encodeLocation({
                    folder: destination,
                    uidValidity: String(uidValidity ?? item.at.uidValidity),
                    uid: newUid,
                  })
                : // No UIDPLUS: we know the folder changed but not the new UID.
                  // Blanking the location marks the row as "find me again",
                  // which the next sync pass does, rather than leaving a
                  // pointer that now addresses somebody else's message.
                  "",
            });
          }
        } finally {
          lock.release();
        }
      }
    });
    await this.persistLocations(updates);
  }

  /** The folder a special use resolves to, creating it when it is missing. */
  private async requireFolder(client: ImapFlow, use: "\\Trash" | "\\Archive"): Promise<string> {
    const folders = await this.folderList(client);
    const found = findSpecialFolder(folders, use);
    if (found) return found.path;
    const fallback = use === "\\Trash" ? "Trash" : "Archive";
    const created = await client.mailboxCreate(fallback);
    this.invalidateFolders();
    return created.path;
  }

  async archive(thread: ThreadRef): Promise<void> {
    const destination = await this.run((client) => this.requireFolder(client, "\\Archive"));
    const inbox = await this.run(async (client) => inboxFolder(await this.folderList(client)).path);
    await this.moveThread(thread, destination, (folder) => folder === inbox);
  }

  async moveToInbox(thread: ThreadRef): Promise<void> {
    const inbox = await this.run(async (client) => inboxFolder(await this.folderList(client)).path);
    await this.moveThread(thread, inbox);
  }

  async trash(thread: ThreadRef): Promise<void> {
    const destination = await this.run((client) => this.requireFolder(client, "\\Trash"));
    await this.moveThread(thread, destination);
  }

  /**
   * Put a trashed conversation back in the Inbox.
   *
   * Gmail remembers which labels a message had before it was trashed and
   * restores them; IMAP remembers nothing, so "untrash" can only mean "move it
   * somewhere sensible". The Inbox is that somewhere, and it is what every
   * other IMAP client does with Undelete.
   */
  async untrash(thread: ThreadRef): Promise<void> {
    const { inbox, trash } = await this.run(async (client) => {
      const folders = await this.folderList(client);
      return {
        inbox: inboxFolder(folders).path,
        trash: findSpecialFolder(folders, "\\Trash")?.path ?? null,
      };
    });
    await this.moveThread(thread, inbox, (folder) => folder === trash);
  }

  async applyLabel(thread: ThreadRef, label: LabelRef): Promise<void> {
    await this.moveThread(thread, folderPathForLabel(label));
  }

  async removeLabel(thread: ThreadRef, label: LabelRef): Promise<void> {
    const source = folderPathForLabel(label);
    const inbox = await this.run(async (client) => inboxFolder(await this.folderList(client)).path);
    await this.moveThread(thread, inbox, (folder) => folder === source);
  }

  // ───────────────────────────── reading ─────────────────────────────

  async readThreadState(thread: ThreadRef): Promise<MailboxThreadState> {
    // A refresh, not an action: nothing to report if the conversation cannot
    // be addressed yet, and the next sync pass will square the labels.
    const items = await this.locationsFor(thread, { required: false });
    if (items.length === 0) return [];
    return this.run(async (client) => {
      const folders = await this.folderList(client);
      const state: MailboxThreadState = [];
      for (const [folderPath, group] of ImapMailbox.byFolder(items)) {
        const folder = folders.find((f) => f.path === folderPath) ?? {
          path: folderPath,
          name: folderPath,
        };
        const lock = await client.getMailboxLock(folderPath);
        try {
          const live = ImapMailbox.live(client, group);
          if (live.length === 0) continue;
          const byUid = new Map(live.map((g) => [g.at.uid, g]));
          for await (const message of client.fetch(
            live.map((g) => g.at.uid),
            { uid: true, flags: true },
            { uid: true },
          )) {
            const item = byUid.get(message.uid);
            if (!item) continue;
            state.push({
              ref: item.row.gmailMessageId,
              labelIds: labelsFor(folder, message.flags ?? new Set<string>()),
            });
          }
        } finally {
          lock.release();
        }
      }
      return state;
    });
  }

  async getMessage(ref: MessageRef): Promise<MailboxMessage> {
    const { at } = await this.locationForMessage(ref);
    return this.run((client) => this.fetchAt(client, at));
  }

  /** Read one message from a known location and normalize it. */
  private async fetchAt(client: ImapFlow, at: ImapLocation): Promise<MailboxMessage> {
    const folders = await this.folderList(client);
    const folder = folders.find((f) => f.path === at.folder) ?? { path: at.folder, name: at.folder };
    const lock = await this.lockAt(client, at);
    try {
      const message = await client.fetchOne(
        String(at.uid),
        { uid: true, flags: true, internalDate: true, size: true, source: true },
        { uid: true },
      );
      if (!message) throw new Error("That message is no longer on the server.");
      const fetched = toFetched({ message, folder: at.folder, uidValidity: at.uidValidity });
      if (!fetched.source) throw new Error("The mail server returned no message body.");
      return mailboxMessageFrom({
        parsed: await parseSource(fetched.source),
        folder,
        flags: fetched.flags,
        location: fetched.location,
        internalDate: fetched.internalDate,
        size: fetched.size,
        hasBodies: true,
      });
    } finally {
      lock.release();
    }
  }

  async getMessageHeaders(ref: MessageRef): Promise<GmailHeader[]> {
    return (await this.getMessage(ref)).headers;
  }

  async getAttachmentBytes(ref: MessageRef, part: ParsedAttachment): Promise<Buffer> {
    const { at } = await this.locationForMessage(ref);
    const source = await this.run(async (client) => {
      const lock = await this.lockAt(client, at);
      try {
        const message = await client.fetchOne(String(at.uid), { uid: true, source: true }, {
          uid: true,
        });
        if (!message || !message.source) {
          throw new Error("That message is no longer on the server.");
        }
        return message.source;
      } finally {
        lock.release();
      }
    });
    return attachmentBytes(source, { partId: part.attachmentId, filename: part.filename });
  }

  // ───────────────────────────── writing ─────────────────────────────

  /**
   * Fill in the headers an SMTP submission needs and Gmail supplies for free.
   *
   * `From`, `Date` and `Message-ID` are all mandatory for a message nobody
   * else is going to stamp. The `Message-ID` in particular has to be minted
   * here rather than left to the SMTP server, because the copy appended to
   * Sent has to carry the same one — a mismatch is how a sent message and the
   * reply to it end up in two different conversations. `Bcc` is the one header
   * that differs between the two copies; see `stripBccHeader`.
   */
  private envelopeFor(mime: MimeFields): MimeFields {
    return {
      ...mime,
      from: mime.from ?? this.config.address,
      date: mime.date ?? new Date(),
      messageId: mime.messageId ?? generateMessageId(this.config.address),
    };
  }

  private recipientsOf(mime: MimeFields): string[] {
    const all = [mime.to, mime.cc ?? "", mime.bcc ?? ""]
      .flatMap((value) => parseAddressList(value).addresses)
      .map((address) => address.toLowerCase());
    return Array.from(new Set(all));
  }

  /**
   * Append bytes to a folder and read the copy back as a mirror row.
   *
   * The location comes back with it because a draft's handle *is* its
   * location — see the class doc — and the caller has no other way to learn
   * where the server put the copy.
   */
  private async appendAndRead(args: {
    client: ImapFlow;
    folder: string;
    raw: Buffer;
    flags: string[];
  }): Promise<{ message: MailboxMessage; location: ImapLocation }> {
    const appended = await args.client.append(args.folder, args.raw, args.flags, new Date());
    if (!appended || !appended.uid) {
      // No UIDPLUS. The message is safely stored; we just cannot address it
      // yet, so leave it for the next sync pass to import and say so.
      throw new UnaddressableAppendError(args.folder);
    }
    const location: ImapLocation = {
      folder: appended.destination,
      uidValidity: String(appended.uidValidity ?? "0"),
      uid: appended.uid,
    };
    return { message: await this.fetchAt(args.client, location), location };
  }

  async sendMessage(args: { mime: MimeFields; thread?: ThreadRef }): Promise<MailboxMessage> {
    const mime = this.envelopeFor(args.mime);
    const raw = buildMimeBuffer(mime);
    await smtpSend({
      config: this.config,
      // The copy on the wire carries no `Bcc` header; the copy filed in Sent
      // below keeps it. See `stripBccHeader`.
      raw: stripBccHeader(raw),
      envelope: { from: this.config.address, to: this.recipientsOf(mime) },
    });
    return this.run(async (client) => {
      const folders = await this.folderList(client);
      const sent = findSpecialFolder(folders, "\\Sent");
      if (!sent) {
        // The mail is gone and cannot be un-sent; a missing Sent folder is a
        // mirroring problem, not a delivery one. Say so plainly rather than
        // reporting a send failure for a message that did go out.
        throw new Error(
          "The message was sent, but this server has no Sent folder to file the copy in. Create one and sync again.",
        );
      }
      return (await this.appendAndRead({ client, folder: sent.path, raw, flags: ["\\Seen"] }))
        .message;
    });
  }

  async createDraft(args: {
    mime: MimeFields;
    thread?: ThreadRef;
  }): Promise<{ draftRef: DraftRef; message: MailboxMessage }> {
    const raw = buildMimeBuffer(this.envelopeFor(args.mime));
    return this.run(async (client) => {
      const folder = await this.draftsFolder(client);
      const { message, location } = await this.appendAndRead({
        client,
        folder,
        raw,
        flags: ["\\Draft", "\\Seen"],
      });
      return { draftRef: encodeLocation(location), message };
    });
  }

  /**
   * Replace a draft's contents.
   *
   * IMAP has no edit — a stored message is immutable — so this appends the new
   * version and then deletes the old one. Append-then-delete rather than the
   * reverse, because a crash between the two leaves the person with two drafts
   * (annoying) instead of none (their writing, gone).
   */
  async updateDraft(args: {
    draftRef: DraftRef;
    mime: MimeFields;
    thread?: ThreadRef;
  }): Promise<{ draftRef: DraftRef; message: MailboxMessage }> {
    const previous = decodeLocation(args.draftRef);
    const raw = buildMimeBuffer(this.envelopeFor(args.mime));
    return this.run(async (client) => {
      const folder = await this.draftsFolder(client);
      const { message, location } = await this.appendAndRead({
        client,
        folder,
        raw,
        flags: ["\\Draft", "\\Seen"],
      });
      if (previous) await this.deleteAt(client, previous);
      return { draftRef: encodeLocation(location), message };
    });
  }

  async sendDraft(draftRef: DraftRef): Promise<MailboxMessage> {
    const at = decodeLocation(draftRef);
    if (!at) throw new Error("That draft can no longer be found on the server.");
    const raw = await this.run(async (client) => {
      const lock = await this.lockAt(client, at);
      try {
        const message = await client.fetchOne(String(at.uid), { uid: true, source: true }, {
          uid: true,
        });
        if (!message || !message.source) {
          throw new Error("That draft is no longer on the server.");
        }
        return message.source;
      } finally {
        lock.release();
      }
    });
    // The stored draft carries its `Bcc` header — that is how the person sees
    // who they blind-copied — so the recipients come off it before it is
    // stripped for the wire.
    const recipients = recipientsFromRaw(raw);
    await smtpSend({
      config: this.config,
      raw: stripBccHeader(raw),
      envelope: { from: this.config.address, to: recipients },
    });
    return this.run(async (client) => {
      const folders = await this.folderList(client);
      const sent = findSpecialFolder(folders, "\\Sent");
      // Delete the draft first here, unlike the update path: the message has
      // already left, and a draft still sitting in the folder reads as "this
      // never sent".
      await this.deleteAt(client, at);
      if (!sent) {
        throw new Error(
          "The message was sent, but this server has no Sent folder to file the copy in. Create one and sync again.",
        );
      }
      return (await this.appendAndRead({ client, folder: sent.path, raw, flags: ["\\Seen"] }))
        .message;
    });
  }

  async deleteDraft(draftRef: DraftRef): Promise<void> {
    const at = decodeLocation(draftRef);
    if (!at) return;
    await this.run((client) => this.deleteAt(client, at));
  }

  async listDraftRefs(): Promise<Array<{ draftRef: DraftRef; messageRef: MessageRef }>> {
    return this.run(async (client) => {
      const folders = await this.folderList(client);
      const drafts = findSpecialFolder(folders, "\\Drafts");
      if (!drafts) return [];
      const lock = await client.getMailboxLock(drafts.path);
      const out: Array<{ draftRef: DraftRef; messageRef: MessageRef }> = [];
      try {
        const status = client.mailbox;
        const uidValidity = status ? String(status.uidValidity) : "0";
        for await (const message of client.fetch(
          "1:*",
          { uid: true, headers: ["message-id"] },
          { uid: true },
        )) {
          const location: ImapLocation = { folder: drafts.path, uidValidity, uid: message.uid };
          out.push({
            draftRef: encodeLocation(location),
            messageRef: messageRefFor({
              messageId: messageIdFromHeaderBlock(message.headers),
              location,
            }),
          });
        }
      } finally {
        lock.release();
      }
      return out;
    });
  }

  private async draftsFolder(client: ImapFlow): Promise<string> {
    const folders = await this.folderList(client);
    const drafts = findSpecialFolder(folders, "\\Drafts");
    if (drafts) return drafts.path;
    const created = await client.mailboxCreate("Drafts");
    this.invalidateFolders();
    return created.path;
  }

  private async deleteAt(client: ImapFlow, at: ImapLocation): Promise<void> {
    const lock = await this.lockAt(client, at);
    try {
      await client.messageDelete([at.uid], { uid: true });
    } catch {
      // A draft that is already gone is the state we wanted; a server that
      // refuses the expunge is not worth failing the send over.
    } finally {
      lock.release();
    }
  }
}

/**
 * Thrown when a stored location predates the folder's current UIDVALIDITY.
 *
 * Recoverable by waiting: the next sync pass re-imports the folder and writes
 * fresh locations. Saying so is the difference between a person retrying in a
 * minute and a person filing a bug.
 */
export class StaleLocationError extends Error {
  constructor(folder: string) {
    super(
      `The mail server renumbered ${folder}; Genosyn is re-reading it. Try again in a minute.`,
    );
    this.name = "StaleLocationError";
  }
}

/** Thrown when a server without UIDPLUS stores a message we cannot address. */
export class UnaddressableAppendError extends Error {
  constructor(folder: string) {
    super(
      `Saved to ${folder}, but this mail server does not report where — it will appear after the next sync.`,
    );
    this.name = "UnaddressableAppendError";
  }
}

/** The folder path a user label refers to. */
export function folderPathForLabel(label: LabelRef): string {
  if (label.startsWith("f:")) return decodePath(label.slice(2));
  switch (label) {
    case CANONICAL_LABELS.inbox:
      return "INBOX";
    default:
      throw new Error(
        `"${label}" is a state, not a folder — an IMAP mailbox can only file a conversation into a folder.`,
      );
  }
}

function labelsFor(folder: { path: string; name: string; specialUse?: string }, flags: Set<string>) {
  const labels = new Set<string>();
  const folderLabel = labelRefForFolder(folder);
  if (folderLabel) labels.add(folderLabel);
  const lowered = new Set(Array.from(flags, (f) => f.toLowerCase()));
  if (!lowered.has("\\seen")) labels.add(CANONICAL_LABELS.unread);
  if (lowered.has("\\flagged")) labels.add(CANONICAL_LABELS.starred);
  if (lowered.has("\\draft")) labels.add(CANONICAL_LABELS.draft);
  return Array.from(labels);
}

/** The `Message-ID` out of a raw header block, or "". */
export function messageIdFromHeaderBlock(headers: Buffer | undefined): string {
  if (!headers) return "";
  const text = headers.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const match = /^message-id:\s*(.+)$/im.exec(text);
  return match ? match[1].trim() : "";
}

/**
 * Envelope recipients for a message we are about to relay verbatim.
 *
 * `Bcc` is read here and then never sent as a header — SMTP takes recipients
 * from the envelope, which is exactly what makes a blind copy blind.
 */
export function recipientsFromRaw(raw: Buffer): string[] {
  const headerEnd = raw.indexOf("\r\n\r\n");
  const block = (headerEnd >= 0 ? raw.subarray(0, headerEnd) : raw)
    .toString("utf8")
    .replace(/\r?\n[ \t]+/g, " ");
  const out = new Set<string>();
  for (const line of block.split(/\r?\n/)) {
    const match = /^(to|cc|bcc):\s*(.*)$/i.exec(line);
    if (!match) continue;
    for (const address of parseAddressList(match[2]).addresses) out.add(address.toLowerCase());
  }
  return Array.from(out);
}
