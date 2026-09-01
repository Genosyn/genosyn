import type { ImapFlow } from "imapflow";
import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import type { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { getMailSettings } from "../runtimeSettings.js";
import { enqueueInboundAutomation } from "./automationQueue.js";
import { findSpecialFolder, parseSource, toFetched, type ImapConnectionConfig } from "./imapClient.js";
import {
  decodeLocation,
  encodeLocation,
  labelsForMessage,
  mailboxMessageFrom,
  type ImapFolder,
} from "./imapModel.js";
import { columnHasLabel, recomputeThread, upsertMailMessage } from "./store.js";
import { CANONICAL_LABELS } from "./mailbox/types.js";

/**
 * The IMAP mailbox sync engine.
 *
 * A second engine rather than a generalisation of the Gmail one, and that is a
 * deliberate choice. The Gmail engine in `sync.ts` is built around a
 * mailbox-wide history cursor, a resumable page-token worklist and a
 * per-message hydration queue — four years of hard-won behaviour around one
 * API's failure modes. IMAP's shape is different in every one of those places:
 * state is per folder, there is no history log, and the unit of work is a UID
 * range. Bending one engine around both would have meant a parameterised
 * abstraction whose every branch existed for exactly one caller, and the risk
 * of regressing a mailbox sync that already works for real companies.
 *
 * What the two engines *do* share is everything downstream: the account state
 * machine, leases and cancellation fences in `sync.ts`, and the mirror write
 * path in `store.ts`. This module only decides which messages to read.
 *
 * ## Per-folder cursors
 *
 * IMAP addresses messages by `(folder, UIDVALIDITY, UID)`. UIDs rise
 * monotonically within a folder, which gives a cheap "what is new" question —
 * everything above the highest UID we have seen. `UIDVALIDITY` is the server
 * saying "forget every UID I gave you for this folder"; when it changes, that
 * folder's cursor resets and the folder is imported again. Re-import is safe
 * and cheap in rows because the mirror keys messages on `Message-ID`, so the
 * second import updates the same rows rather than duplicating them.
 *
 * ## What a pass does
 *
 * A backfill pass walks each folder downward from its newest UID in windows,
 * honouring the same per-pass thread and time budgets the Gmail engine uses,
 * so a large mailbox imports across many heartbeats without ever holding the
 * account lease for minutes. Once every folder is done, passes switch to
 * incremental: read what is new above each high-water mark, re-read flags for
 * a recent window so a message read on someone's phone shows as read here, and
 * reconcile messages that have left the window entirely.
 */

/** Cursor shape persisted on `MailAccount.syncCursor`. */
export type ImapFolderCursor = {
  uidValidity: string;
  /** Highest UID imported. Everything above this is new mail. */
  highestUid: number;
  /** Backfill walks down from here; 0 once the folder is fully imported. */
  backfillNextUid: number;
  /**
   * Lowest UID the backfill will read, from the operator's "only recent mail"
   * cap. Computed once per folder with a server-side `SEARCH SINCE`, because
   * downloading a decade of mail in order to discard it is not a cap — it is
   * the same import with extra steps.
   */
  floorUid: number;
  done: boolean;
};

export type ImapSyncCursor = {
  version: 1;
  folders: Record<string, ImapFolderCursor>;
};

export function emptyImapCursor(): ImapSyncCursor {
  return { version: 1, folders: {} };
}

/**
 * Parse a stored cursor, tolerating anything.
 *
 * A cursor that cannot be read means "import this mailbox again", which costs
 * time and duplicates nothing. A cursor that throws means a mailbox that never
 * syncs again, which is how a person loses their mail. The asymmetry decides
 * the behaviour.
 */
export function parseImapCursor(raw: string): ImapSyncCursor {
  if (!raw) return emptyImapCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyImapCursor();
  }
  if (!parsed || typeof parsed !== "object") return emptyImapCursor();
  const source = parsed as { version?: unknown; folders?: unknown };
  if (source.version !== 1) return emptyImapCursor();
  const folders: Record<string, ImapFolderCursor> = {};
  if (source.folders && typeof source.folders === "object") {
    for (const [path, value] of Object.entries(source.folders as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as Record<string, unknown>;
      const uidValidity = typeof entry.uidValidity === "string" ? entry.uidValidity : "";
      if (!uidValidity) continue;
      folders[path] = {
        uidValidity,
        highestUid: intOr(entry.highestUid, 0),
        backfillNextUid: intOr(entry.backfillNextUid, 0),
        floorUid: intOr(entry.floorUid, 1),
        done: entry.done === true,
      };
    }
  }
  return { version: 1, folders };
}

function intOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function serializeImapCursor(cursor: ImapSyncCursor): string {
  return JSON.stringify(cursor);
}

/**
 * Folders worth mirroring.
 *
 * The "all mail" folder is skipped whenever there is a real INBOX, because on
 * the servers that have one it is a second copy of every message in the
 * mailbox — importing it would double the row count and make every
 * conversation appear twice.
 */
export function foldersToSync(folders: ImapFolder[]): ImapFolder[] {
  const hasInbox = folders.some((f) => f.path.toUpperCase() === "INBOX");
  return folders.filter((folder) => {
    if (folder.specialUse === "\\All" && hasInbox) return false;
    if (folder.specialUse === "\\Noselect" || folder.specialUse === "\\NonExistent") return false;
    return true;
  });
}

/** How many UIDs a single backfill window reads at once. */
const BACKFILL_WINDOW = 25;
/**
 * How far back an incremental pass re-reads flags.
 *
 * Read/unread and starred state changes leave no trace in a UID, so the only
 * way to notice one is to look. A window rather than the whole folder because
 * a mailbox with 200k messages cannot be re-read every minute, and because
 * mail people are actually touching is mail near the top.
 */
const FLAG_WINDOW = 400;
/**
 * How many new messages one incremental pass reads.
 *
 * A mailbox that has been unreachable for a day comes back with a backlog, and
 * an unbounded `highestUid+1:*` would pull every one of those bodies into
 * memory at once. The heartbeat runs again in a minute; a bounded pass that
 * always finishes beats an unbounded one that sometimes does not.
 */
const INCREMENTAL_WINDOW = 200;
/**
 * How many locations one `IN (…)` may name.
 *
 * SQLite refuses a statement with more than 999 bound parameters by default,
 * and a query that fails at 1000 rather than 999 is a bug that only ever shows
 * up on somebody else's mailbox.
 */
const LOCATION_LOOKUP_CHUNK = 500;

/** Everything a pass needs from the sync engine that owns the account. */
export type ImapPassContext = {
  account: MailAccount;
  config: ImapConnectionConfig;
  /** Re-checks the lease and the account row at every await boundary. */
  assertWritable: () => Promise<void>;
  /** Runs `work` on the account's serialized IMAP connection. */
  run: <T>(work: (client: ImapFlow) => Promise<T>) => Promise<T>;
  /**
   * Make the cursor durable, under the same attempt guard every other
   * checkpoint uses. Supplied by `sync.ts` rather than written here so a
   * superseded worker cannot overwrite a live pass's cursor, and so the
   * cancellation it detects is the same error type the engine already knows.
   */
  persistCursor: (cursor: string) => Promise<void>;
  folders: ImapFolder[];
};

/**
 * Import mail that has not been imported yet, for at most one budget's worth.
 *
 * Returns true when the mailbox is now fully imported, which is what tells the
 * caller to stamp `backfilledAt` and switch to incremental passes.
 */
export async function imapBackfillPass(ctx: ImapPassContext): Promise<boolean> {
  const settings = getMailSettings();
  const deadline = Date.now() + settings.backfillPassSeconds * 1000;
  const budget = settings.backfillThreadsPerPass;
  const since =
    settings.backfillDays > 0
      ? new Date(Date.now() - settings.backfillDays * 24 * 60 * 60 * 1000)
      : null;

  const cursor = parseImapCursor(ctx.account.syncCursor);
  let processed = 0;

  for (const folder of foldersToSync(ctx.folders)) {
    if (processed >= budget || Date.now() >= deadline) break;
    let entry = cursor.folders[folder.path];

    const opened = await ctx.run(async (client) => {
      const lock = await client.getMailboxLock(folder.path);
      try {
        const box = client.mailbox;
        if (!box) throw new Error(`Could not open ${folder.path}`);
        return { uidValidity: String(box.uidValidity), uidNext: box.uidNext };
      } finally {
        lock.release();
      }
    });
    await ctx.assertWritable();

    if (!entry || entry.uidValidity !== opened.uidValidity) {
      // Either the first sight of this folder, or the server invalidating
      // every UID it ever gave us. Both mean "read it from the top".
      //
      // The floor is settled here, once, with a server-side SEARCH: an
      // operator who capped the import to recent mail wants Genosyn not to
      // *download* the rest, and a client-side date filter would download all
      // of it and then throw it away.
      const floorUid = since ? await earliestUidSince(ctx, folder, since) : 1;
      entry = {
        uidValidity: opened.uidValidity,
        highestUid: Math.max(opened.uidNext - 1, 0),
        backfillNextUid: Math.max(opened.uidNext - 1, 0),
        floorUid,
        done: floorUid === 0,
      };
      cursor.folders[folder.path] = entry;
      await persistCursor(ctx, cursor);
    }
    if (entry.done) continue;

    const floor = Math.max(entry.floorUid, 1);
    while (entry.backfillNextUid >= floor && processed < budget && Date.now() < deadline) {
      const from = Math.max(entry.backfillNextUid - BACKFILL_WINDOW + 1, floor);
      const range = `${from}:${entry.backfillNextUid}`;
      const imported = await importRange({
        ctx,
        folder,
        uidValidity: entry.uidValidity,
        range,
        markInbound: false,
      });
      processed += imported.count;
      entry.backfillNextUid = from - 1;
      if (entry.backfillNextUid < floor) entry.done = true;
      await persistCursor(ctx, cursor);
    }
    if (entry.backfillNextUid < floor) {
      entry.done = true;
      await persistCursor(ctx, cursor);
    }
  }

  const remaining = foldersToSync(ctx.folders).filter(
    (folder) => !cursor.folders[folder.path]?.done,
  );
  await persistCursor(ctx, cursor);
  return remaining.length === 0;
}

/**
 * The lowest UID in a folder that is newer than `since`, or 0 when there is
 * none.
 *
 * `SEARCH SINCE` is answered by the server from its own index, so this costs
 * one round trip and saves downloading every message the operator asked us not
 * to import. A server that refuses the search (or an error mid-flight) falls
 * back to 1, which imports everything — the same behaviour as before the cap
 * existed, and better than importing nothing.
 */
async function earliestUidSince(
  ctx: ImapPassContext,
  folder: ImapFolder,
  since: Date,
): Promise<number> {
  try {
    return await ctx.run(async (client) => {
      const lock = await client.getMailboxLock(folder.path);
      try {
        const uids = await client.search({ since }, { uid: true });
        if (uids === false) return 1;
        if (uids.length === 0) return 0;
        return Math.min(...uids);
      } finally {
        lock.release();
      }
    });
  } catch {
    return 1;
  }
}

/**
 * Read what changed since the last pass.
 *
 * Returns true when anything was written, which is what the caller uses to
 * decide whether to re-run revenue enrichment and broadcast to clients.
 */
export async function imapIncrementalPass(ctx: ImapPassContext): Promise<boolean> {
  const cursor = parseImapCursor(ctx.account.syncCursor);
  const inbox = ctx.folders.find((f) => f.path.toUpperCase() === "INBOX") ?? null;
  const folders = foldersToSync(ctx.folders);
  let changed = false;

  // Two separate sweeps, and the order is the point. A message somebody moved
  // from A to B has vanished from A and appeared in B, and the reconciliation
  // in A cannot tell that from a deletion — unless B has already been read, in
  // which case the row's location now points at B and A's window no longer
  // matches it. Interleaving the two per folder would delete and re-create the
  // row instead of moving it, orphaning its analysis, activity and revenue
  // links behind a new id.
  const reconcile: Array<{ folder: ImapFolder; uidValidity: string; newestUid: number }> = [];

  for (const folder of folders) {
    const opened = await ctx.run(async (client) => {
      const lock = await client.getMailboxLock(folder.path);
      try {
        const box = client.mailbox;
        if (!box) throw new Error(`Could not open ${folder.path}`);
        return { uidValidity: String(box.uidValidity), uidNext: box.uidNext };
      } finally {
        lock.release();
      }
    });
    await ctx.assertWritable();

    const entry = cursor.folders[folder.path];
    if (!entry || entry.uidValidity !== opened.uidValidity) {
      // A folder we have never seen, or one whose UIDs the server just
      // invalidated. Hand it back to the backfill rather than reading a UID
      // range that no longer means anything — `imapPass` runs a backfill
      // whenever any folder is unfinished, whether or not the mailbox as a
      // whole has already been imported once.
      cursor.folders[folder.path] = {
        uidValidity: opened.uidValidity,
        highestUid: Math.max(opened.uidNext - 1, 0),
        backfillNextUid: Math.max(opened.uidNext - 1, 0),
        floorUid: 1,
        done: false,
      };
      await persistCursor(ctx, cursor);
      changed = true;
      continue;
    }

    const newestUid = Math.max(opened.uidNext - 1, 0);
    if (newestUid > entry.highestUid) {
      // Bounded like the backfill is. After an outage a folder can hold
      // thousands of new messages, and `highestUid+1:*` would pull every one
      // of their bodies into memory in a single pass.
      const to = Math.min(newestUid, entry.highestUid + INCREMENTAL_WINDOW);
      const imported = await importRange({
        ctx,
        folder,
        uidValidity: entry.uidValidity,
        range: `${entry.highestUid + 1}:${to}`,
        markInbound: inbox !== null && folder.path === inbox.path,
      });
      if (imported.count > 0) changed = true;
      // Advance only over what was actually read, so the rest is picked up on
      // the next pass rather than skipped.
      entry.highestUid = to;
      await persistCursor(ctx, cursor);
    }

    reconcile.push({ folder, uidValidity: entry.uidValidity, newestUid });
  }

  for (const target of reconcile) {
    const refreshed = await refreshFlagWindow({
      ctx,
      folder: target.folder,
      uidValidity: target.uidValidity,
      from: Math.max(target.newestUid - FLAG_WINDOW + 1, 1),
      to: target.newestUid,
    });
    if (refreshed) changed = true;
  }

  return changed;
}

async function persistCursor(ctx: ImapPassContext, cursor: ImapSyncCursor): Promise<void> {
  await ctx.persistCursor(serializeImapCursor(cursor));
}

/**
 * Fetch a UID range, mirror it, and recompute the conversations it touched.
 *
 * `markInbound` is set only for genuinely new arrivals in the Inbox. The
 * backfill never sets it: connecting a mailbox must not fire every rule and
 * every AI triage over ten years of history.
 */
async function importRange(args: {
  ctx: ImapPassContext;
  folder: ImapFolder;
  uidValidity: string;
  range: string;
  markInbound: boolean;
}): Promise<{ count: number }> {
  const { ctx, folder } = args;
  const fetched = await ctx.run(async (client) => {
    const lock = await client.getMailboxLock(folder.path);
    try {
      const rows: Array<ReturnType<typeof toFetched>> = [];
      for await (const message of client.fetch(
        args.range,
        { uid: true, flags: true, internalDate: true, size: true, source: true },
        { uid: true },
      )) {
        rows.push(toFetched({ message, folder: folder.path, uidValidity: args.uidValidity }));
      }
      return rows;
    } finally {
      lock.release();
    }
  });
  await ctx.assertWritable();

  const threads = new Set<string>();
  const inbound: MailMessage[] = [];
  let count = 0;
  for (const item of fetched) {
    if (!item.source) continue;
    const parsed = await parseSource(item.source);
    const message = mailboxMessageFrom({
      parsed,
      folder,
      flags: item.flags,
      location: item.location,
      internalDate: item.internalDate,
      size: item.size,
      hasBodies: true,
    });
    await ctx.assertWritable();
    const { row, created } = await upsertMailMessage(ctx.account, message);
    threads.add(message.threadRef);
    count += 1;
    const isInbound =
      args.markInbound &&
      created &&
      !columnHasLabel(row.labelIds, CANONICAL_LABELS.draft) &&
      !columnHasLabel(row.labelIds, CANONICAL_LABELS.sent) &&
      row.fromEmail.toLowerCase() !== ctx.account.address.toLowerCase();
    if (isInbound) inbound.push(row);
  }

  for (const threadRef of threads) {
    await ctx.assertWritable();
    await recomputeThread(ctx.account, threadRef);
  }
  // Enqueued only after the mirror is consistent, exactly as the Gmail engine
  // does: a rule that reads a half-written thread is worse than one that runs
  // a second later.
  for (const message of inbound) {
    await ctx.assertWritable();
    await enqueueInboundAutomation(message);
  }
  return { count };
}

/**
 * Re-read flags near the top of a folder and reconcile what is missing.
 *
 * Two things happen here that a UID high-water mark cannot see. Someone reads
 * or stars a message in another mail client, which changes flags and no UID;
 * and someone moves or deletes a message, which makes its UID disappear. The
 * first is a label update. The second is only a deletion if the message did
 * not turn up somewhere else — a move rewrites the row's location as part of
 * importing it into its new folder, so a row whose location still points into
 * this window is genuinely gone.
 */
async function refreshFlagWindow(args: {
  ctx: ImapPassContext;
  folder: ImapFolder;
  uidValidity: string;
  from: number;
  to: number;
}): Promise<boolean> {
  const { ctx, folder } = args;
  if (args.to <= 0) return false;
  const live = await ctx.run(async (client) => {
    const lock = await client.getMailboxLock(folder.path);
    try {
      const out = new Map<number, string[]>();
      for await (const message of client.fetch(
        `${args.from}:${args.to}`,
        { uid: true, flags: true },
        { uid: true },
      )) {
        out.set(message.uid, Array.from(message.flags ?? []));
      }
      return out;
    } finally {
      lock.release();
    }
  });
  await ctx.assertWritable();

  // Ask for exactly the rows this window could contain rather than reading the
  // account's whole mirror: a 200k-message mailbox re-reading every row once a
  // minute, per folder, is not a slow sync — it is an outage with a heartbeat.
  // The location column is a deterministic function of (folder, UIDVALIDITY,
  // UID), so the window's rows can be named outright and looked up on the
  // `(accountId, providerLocation)` index.
  const wanted: string[] = [];
  for (let uid = args.from; uid <= args.to; uid++) {
    wanted.push(encodeLocation({ folder: folder.path, uidValidity: args.uidValidity, uid }));
  }
  const repo = AppDataSource.getRepository(MailMessage);
  const rows: MailMessage[] = [];
  for (let i = 0; i < wanted.length; i += LOCATION_LOOKUP_CHUNK) {
    rows.push(
      ...(await repo.find({
        where: {
          accountId: ctx.account.id,
          providerLocation: In(wanted.slice(i, i + LOCATION_LOOKUP_CHUNK)),
        },
      })),
    );
  }
  const threads = new Set<string>();
  let changed = false;

  for (const row of rows) {
    const at = decodeLocation(row.providerLocation);
    if (!at) continue;
    const flags = live.get(at.uid);
    if (flags) {
      const labels = labelsForMessage({ folder, flags }).sort().join(" ");
      const current = row.labelIds.trim().split(/\s+/).filter(Boolean).sort().join(" ");
      if (labels !== current) {
        row.labelIds = labels ? ` ${labels} ` : "";
        await repo.save(row);
        threads.add(row.gmailThreadId);
        changed = true;
      }
      continue;
    }
    // Gone from this folder and nothing re-homed it this pass.
    await repo.delete({ id: row.id });
    threads.add(row.gmailThreadId);
    changed = true;
  }

  for (const threadRef of threads) {
    await ctx.assertWritable();
    await recomputeThread(ctx.account, threadRef);
  }
  return changed;
}

/** A message a person would understand, for an IMAP failure. */
export function imapSyncErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/authenticationfailed|invalid credentials|login failed|auth/i.test(raw)) {
    return "The mail server rejected the password. If your provider needs an app password, create a new one and reconnect this mailbox.";
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) {
    return "The mail server's hostname could not be resolved. Check the IMAP server address on this mailbox.";
  }
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket|timeout/i.test(raw)) {
    return `Could not reach the mail server: ${raw}`;
  }
  if (/certificate|self.signed|SSL|TLS/i.test(raw)) {
    return `The mail server's TLS certificate was rejected: ${raw}`;
  }
  return raw;
}

/** The Drafts folder path, when the server has one. */
export function draftsFolderPath(folders: ImapFolder[]): string | null {
  return findSpecialFolder(folders, "\\Drafts")?.path ?? null;
}
