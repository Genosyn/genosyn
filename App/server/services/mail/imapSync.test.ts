import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import type { ImapFlow } from "imapflow";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import type { ImapConnectionConfig } from "./imapClient.js";
import { decodeLocation, type ImapFolder } from "./imapModel.js";
import {
  emptyImapCursor,
  foldersToSync,
  imapBackfillPass,
  imapIncrementalPass,
  imapSyncErrorMessage,
  parseImapCursor,
  serializeImapCursor,
  type ImapPassContext,
  type ImapSyncCursor,
} from "./imapSync.js";

/**
 * The IMAP sync engine, driven against an in-memory mail server.
 *
 * The interesting behaviour here is all about state the protocol does not
 * hand you: what is new (a UID above a high-water mark), what changed
 * (flags near the top of a folder), what left (a UID that stopped answering),
 * and what to do when the server invalidates every UID it ever gave you. None
 * of that can be covered by pointing the engine at a real mailbox and hoping.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_imap_sync";

const INBOX: ImapFolder = { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" };
const ARCHIVE: ImapFolder = { path: "Archive", name: "Archive", specialUse: "\\Archive" };

const CONFIG: ImapConnectionConfig = {
  address: "ops@acme.example",
  password: "app-password",
  imapHost: "imap.acme.example",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.acme.example",
  smtpPort: 465,
  smtpSecure: true,
};

// ───────────────────────────── an in-memory server ─────────────────────────────

type StoredMessage = { uid: number; flags: string[]; internalDate: Date; source: Buffer };

/**
 * Just enough of an IMAP server to drive the engine: folders that hold
 * messages by UID, a UIDVALIDITY the test can change, and a `fetch` that
 * honours a UID range.
 */
class FakeImapServer {
  readonly folders = new Map<
    string,
    { path: string; uidValidity: string; uidNext: number; messages: StoredMessage[] }
  >();
  /** Every range the engine asked for, so a test can assert it read narrowly. */
  readonly fetches: Array<{ folder: string; range: string }> = [];
  private open: string | null = null;

  constructor(paths: string[]) {
    for (const path of paths) {
      this.folders.set(path, { path, uidValidity: "100", uidNext: 1, messages: [] });
    }
  }

  add(path: string, args: { messageId: string; from?: string; subject?: string; references?: string; flags?: string[] }): number {
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`no folder ${path}`);
    const uid = folder.uidNext;
    folder.uidNext += 1;
    folder.messages.push({
      uid,
      flags: args.flags ?? [],
      internalDate: new Date("2026-02-03T10:00:00Z"),
      source: Buffer.from(
        [
          `From: ${args.from ?? "Ada <ada@northwind.example>"}`,
          "To: ops@acme.example",
          `Subject: ${args.subject ?? "Two banners"}`,
          `Message-ID: <${args.messageId}>`,
          ...(args.references ? [`References: ${args.references}`] : []),
          "MIME-Version: 1.0",
          'Content-Type: text/plain; charset="UTF-8"',
          "",
          "Body text.",
          "",
        ].join("\r\n"),
        "utf8",
      ),
    });
    return uid;
  }

  remove(path: string, uid: number): void {
    const folder = this.folders.get(path);
    if (!folder) return;
    folder.messages = folder.messages.filter((m) => m.uid !== uid);
  }

  flags(path: string, uid: number, flags: string[]): void {
    const message = this.folders.get(path)?.messages.find((m) => m.uid === uid);
    if (message) message.flags = flags;
  }

  /** Simulate the server saying "forget every UID I gave you for this folder". */
  invalidate(path: string): void {
    const folder = this.folders.get(path);
    if (!folder) return;
    folder.uidValidity = String(Number(folder.uidValidity) + 1);
  }

  asClient(): ImapFlow {
    const open = () => (this.open ? this.folders.get(this.open) : null);
    const select = (path: string) => {
      this.open = path;
    };
    const record = (folder: string, range: string) => this.fetches.push({ folder, range });
    const client = {
      async getMailboxLock(path: string) {
        select(path);
        return { path, release: () => undefined };
      },
      get mailbox() {
        const folder = open();
        if (!folder) return null;
        return { uidValidity: BigInt(folder.uidValidity), uidNext: folder.uidNext };
      },
      async search(query: { since?: Date }) {
        const folder = open();
        if (!folder) return [] as number[];
        const since = query.since;
        return folder.messages
          .filter((m) => !since || m.internalDate >= since)
          .map((m) => m.uid);
      },
      async *fetch(range: string) {
        const folder = open();
        if (!folder) return;
        record(folder.path, range);
        for (const message of folder.messages.filter((m) => inRange(m.uid, range, folder.uidNext))) {
          yield {
            seq: message.uid,
            uid: message.uid,
            flags: new Set(message.flags),
            internalDate: message.internalDate,
            size: message.source.length,
            source: message.source,
          };
        }
      },
    };
    return client as unknown as ImapFlow;
  }
}

/** `from:to`, `from:*`, or a single UID. */
function inRange(uid: number, range: string, uidNext: number): boolean {
  const [rawFrom, rawTo] = range.split(":");
  const from = Number(rawFrom);
  if (rawTo === undefined) return uid === from;
  const to = rawTo === "*" ? uidNext : Number(rawTo);
  return uid >= from && uid <= to;
}

async function scene(
  server: FakeImapServer,
  folders: ImapFolder[],
  overrides: Partial<MailAccount> = {},
): Promise<{ account: MailAccount; ctx: ImapPassContext; cursorWrites: string[] }> {
  const account = await insert(MailAccount, {
    companyId: CO,
    connectionId: randomUUID(),
    provider: "imap",
    address: "ops@acme.example",
    status: "active",
    syncState: "running",
    syncAttemptId: randomUUID(),
    ...overrides,
  });
  const cursorWrites: string[] = [];
  const ctx: ImapPassContext = {
    account,
    config: CONFIG,
    assertWritable: async () => undefined,
    run: async (work) => work(server.asClient()),
    folders,
    persistCursor: async (cursor) => {
      cursorWrites.push(cursor);
      account.syncCursor = cursor;
      await AppDataSource.getRepository(MailAccount).update(
        { id: account.id },
        { syncCursor: cursor },
      );
    },
  };
  return { account, ctx, cursorWrites };
}

function messages(): Promise<MailMessage[]> {
  return AppDataSource.getRepository(MailMessage).find({ order: { subject: "ASC" } });
}

// ───────────────────────────── the cursor ─────────────────────────────

describe("the sync cursor", () => {
  test("round-trips a folder's state", () => {
    const cursor: ImapSyncCursor = {
      version: 1,
      folders: {
        INBOX: { uidValidity: "100", highestUid: 42, backfillNextUid: 0, floorUid: 1, done: true },
      },
    };
    assert.deepEqual(parseImapCursor(serializeImapCursor(cursor)), cursor);
  });

  test("reads anything unreadable as 'import this mailbox again'", () => {
    // A cursor that throws means a mailbox that never syncs again, which is
    // how a person loses their mail. Re-importing costs time and duplicates
    // nothing, because rows are keyed on Message-ID.
    for (const raw of ["", "not json", "[]", '"a string"', "null", '{"version":2}']) {
      assert.deepEqual(parseImapCursor(raw), emptyImapCursor(), `for ${JSON.stringify(raw)}`);
    }
  });

  test("drops a folder entry it cannot trust rather than the whole cursor", () => {
    const parsed = parseImapCursor(
      JSON.stringify({
        version: 1,
        folders: {
          INBOX: { uidValidity: "100", highestUid: 5, backfillNextUid: 0, done: true },
          Broken: { highestUid: 3 },
          AlsoBroken: "nope",
        },
      }),
    );
    assert.deepEqual(Object.keys(parsed.folders), ["INBOX"]);
  });

  test("clamps a nonsense UID to zero instead of reading from a negative range", () => {
    const parsed = parseImapCursor(
      JSON.stringify({
        version: 1,
        folders: { INBOX: { uidValidity: "1", highestUid: -9, backfillNextUid: "x", done: 1 } },
      }),
    );
    assert.deepEqual(parsed.folders.INBOX, {
      uidValidity: "1",
      highestUid: 0,
      backfillNextUid: 0,
      floorUid: 1,
      done: false,
    });
  });
});

describe("foldersToSync", () => {
  test("skips the all-mail folder when there is a real INBOX", () => {
    // On the servers that ship one it is a second copy of every message in the
    // mailbox; importing it would double the row count and show every
    // conversation twice.
    const kept = foldersToSync([
      INBOX,
      { path: "All Mail", name: "All Mail", specialUse: "\\All" },
      ARCHIVE,
    ]);
    assert.deepEqual(kept.map((f) => f.path), ["INBOX", "Archive"]);
  });

  test("keeps an all-mail folder when it is the only thing there", () => {
    const kept = foldersToSync([{ path: "All Mail", name: "All Mail", specialUse: "\\All" }]);
    assert.deepEqual(kept.map((f) => f.path), ["All Mail"]);
  });

  test("skips a folder that cannot be selected", () => {
    const kept = foldersToSync([INBOX, { path: "Shared", name: "Shared", specialUse: "\\Noselect" }]);
    assert.deepEqual(kept.map((f) => f.path), ["INBOX"]);
  });
});

// ───────────────────────────── the backfill ─────────────────────────────

describe("the first import", () => {
  test("mirrors every message in every folder and reports completion", async () => {
    const server = new FakeImapServer(["INBOX", "Archive"]);
    server.add("INBOX", { messageId: "a@x", subject: "A" });
    server.add("INBOX", { messageId: "b@x", subject: "B", flags: ["\\Seen"] });
    server.add("Archive", { messageId: "c@x", subject: "C", flags: ["\\Seen"] });
    const { ctx } = await scene(server, [INBOX, ARCHIVE]);

    assert.equal(await imapBackfillPass(ctx), true);

    const rows = await messages();
    assert.deepEqual(rows.map((m) => m.subject), ["A", "B", "C"]);
    assert.equal(rows.find((m) => m.subject === "A")?.labelIds.trim(), "INBOX UNREAD");
    assert.equal(rows.find((m) => m.subject === "B")?.labelIds.trim(), "INBOX");
    // Archived mail carries no folder label, exactly like Gmail's.
    assert.equal(rows.find((m) => m.subject === "C")?.labelIds.trim(), "");
  });

  test("records where each message currently sits, so it can be found again", async () => {
    const server = new FakeImapServer(["INBOX"]);
    const uid = server.add("INBOX", { messageId: "a@x" });
    const { ctx } = await scene(server, [INBOX]);

    await imapBackfillPass(ctx);

    const [row] = await messages();
    assert.deepEqual(decodeLocation(row.providerLocation), {
      folder: "INBOX",
      uidValidity: "100",
      uid,
    });
  });

  test("groups a reply with the message it answers", async () => {
    const server = new FakeImapServer(["INBOX"]);
    server.add("INBOX", { messageId: "root@x", subject: "Quote" });
    server.add("INBOX", { messageId: "reply@x", subject: "Re: Quote", references: "<root@x>" });
    const { ctx } = await scene(server, [INBOX]);

    await imapBackfillPass(ctx);

    const threads = await AppDataSource.getRepository(MailThread).find();
    assert.equal(threads.length, 1, "a reply and its parent are one conversation");
    assert.equal(threads[0].messageCount, 2);
  });

  test("never fires inbound automation, so connecting a mailbox cannot storm an employee", async () => {
    // A ten-year backfill running every rule and every AI triage is the
    // failure mode this rule exists to prevent.
    const server = new FakeImapServer(["INBOX"]);
    for (let i = 0; i < 5; i++) server.add("INBOX", { messageId: `m${i}@x` });
    const { ctx } = await scene(server, [INBOX]);

    await imapBackfillPass(ctx);

    assert.equal(await AppDataSource.getRepository(MailInboundAutomation).count(), 0);
  });

  test("checkpoints its position after every window, newest first", async () => {
    // A hard crash must resume at the exact remaining UID rather than at the
    // top of a folder somebody has been importing for an hour.
    const server = new FakeImapServer(["INBOX"]);
    for (let i = 1; i <= 30; i++) server.add("INBOX", { messageId: `m${i}@x`, subject: `S${i}` });
    const { ctx, cursorWrites } = await scene(server, [INBOX]);

    await imapBackfillPass(ctx);

    const marks = cursorWrites
      .map((raw) => parseImapCursor(raw).folders.INBOX?.backfillNextUid)
      .filter((uid): uid is number => uid !== undefined);
    assert.ok(marks.length >= 2, "the cursor is written as the walk proceeds, not only at the end");
    assert.deepEqual(marks, [...marks].sort((a, b) => b - a), "the walk runs newest first");
    assert.equal(marks[marks.length - 1], 0, "and ends at the bottom of the folder");
  });

  test("picks up from a stored cursor instead of importing the folder again", async () => {
    const server = new FakeImapServer(["INBOX"]);
    for (let i = 1; i <= 30; i++) server.add("INBOX", { messageId: `m${i}@x`, subject: `S${i}` });
    const { ctx } = await scene(server, [INBOX], {
      // As if a previous pass had already imported UIDs 11-30 and stopped.
      syncCursor: serializeImapCursor({
        version: 1,
        folders: {
          INBOX: {
            uidValidity: "100",
            highestUid: 30,
            backfillNextUid: 10,
            floorUid: 1,
            done: false,
          },
        },
      }),
    });

    assert.equal(await imapBackfillPass(ctx), true);

    const imported = (await messages()).map((m) => m.subject).sort();
    assert.equal(imported.length, 10, "only the ten the cursor still had left were read");
    assert.ok(imported.includes("S1") && imported.includes("S10"));
    assert.equal(imported.includes("S11"), false, "the already-imported half was not re-read");
  });

  test("re-importing the same mailbox updates rows rather than duplicating them", async () => {
    // The recovery path for a UIDVALIDITY change is a re-import, so this has
    // to be free of duplicates or the fix would be worse than the fault.
    const server = new FakeImapServer(["INBOX"]);
    server.add("INBOX", { messageId: "a@x" });
    const { account, ctx } = await scene(server, [INBOX]);

    await imapBackfillPass(ctx);
    account.syncCursor = "";
    await imapBackfillPass(ctx);

    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 1);
  });
});

// ───────────────────────────── incremental ─────────────────────────────

describe("keeping up with a mailbox", () => {
  async function imported(server: FakeImapServer, folders: ImapFolder[]) {
    const scenery = await scene(server, folders);
    for (let guard = 0; guard < 20 && !(await imapBackfillPass(scenery.ctx)); guard++);
    scenery.account.backfilledAt = new Date();
    return scenery;
  }

  test("imports mail that arrived since the last pass", async () => {
    const server = new FakeImapServer(["INBOX"]);
    server.add("INBOX", { messageId: "old@x", subject: "Old" });
    const { ctx } = await imported(server, [INBOX]);

    server.add("INBOX", { messageId: "new@x", subject: "New" });
    assert.equal(await imapIncrementalPass(ctx), true);

    assert.deepEqual((await messages()).map((m) => m.subject), ["New", "Old"]);
  });

  test("hands genuinely new inbox mail to the automation queue", async () => {
    const server = new FakeImapServer(["INBOX"]);
    const { ctx } = await imported(server, [INBOX]);

    server.add("INBOX", { messageId: "new@x", subject: "New" });
    await imapIncrementalPass(ctx);

    assert.equal(await AppDataSource.getRepository(MailInboundAutomation).count(), 1);
  });

  test("does not treat the mailbox's own outgoing mail as an arrival", async () => {
    const server = new FakeImapServer(["INBOX"]);
    const { ctx } = await imported(server, [INBOX]);

    server.add("INBOX", { messageId: "mine@x", subject: "Mine", from: "ops@acme.example" });
    await imapIncrementalPass(ctx);

    assert.equal(await AppDataSource.getRepository(MailInboundAutomation).count(), 0);
  });

  test("notices a message read in another mail client", async () => {
    // Flags change without changing a UID, so the only way to see this is to
    // look — which is what the recent-window re-read is for.
    const server = new FakeImapServer(["INBOX"]);
    const uid = server.add("INBOX", { messageId: "a@x" });
    const { ctx } = await imported(server, [INBOX]);
    assert.equal((await messages())[0].labelIds.trim(), "INBOX UNREAD");

    server.flags("INBOX", uid, ["\\Seen", "\\Flagged"]);
    assert.equal(await imapIncrementalPass(ctx), true);

    assert.equal((await messages())[0].labelIds.trim(), "INBOX STARRED");
  });

  test("reports no change when nothing moved, so the mailbox does not look busy", async () => {
    const server = new FakeImapServer(["INBOX"]);
    server.add("INBOX", { messageId: "a@x" });
    const { ctx } = await imported(server, [INBOX]);

    assert.equal(await imapIncrementalPass(ctx), false);
  });

  test("removes a message deleted from the server", async () => {
    const server = new FakeImapServer(["INBOX"]);
    const uid = server.add("INBOX", { messageId: "a@x" });
    const { ctx } = await imported(server, [INBOX]);

    server.remove("INBOX", uid);
    await imapIncrementalPass(ctx);

    assert.equal(await AppDataSource.getRepository(MailMessage).count(), 0);
    assert.equal(
      await AppDataSource.getRepository(MailThread).count(),
      0,
      "a conversation with no messages left is deleted too",
    );
  });

  test("follows a message that moved to another folder instead of deleting it", async () => {
    // A move gives the message a new UID, so the old folder reports it gone.
    // Deleting on that alone would lose every archived message.
    const server = new FakeImapServer(["INBOX", "Archive"]);
    const uid = server.add("INBOX", { messageId: "a@x", subject: "A" });
    const { ctx } = await imported(server, [INBOX, ARCHIVE]);

    server.remove("INBOX", uid);
    server.add("Archive", { messageId: "a@x", subject: "A" });
    await imapIncrementalPass(ctx);

    const rows = await messages();
    assert.equal(rows.length, 1, "the message moved; it was not deleted and re-created");
    assert.equal(decodeLocation(rows[0].providerLocation)?.folder, "Archive");
    assert.equal(rows[0].labelIds.trim(), "UNREAD", "it is no longer in the inbox");
  });

  test("re-imports a folder whose UIDVALIDITY the server changed", async () => {
    const server = new FakeImapServer(["INBOX"]);
    server.add("INBOX", { messageId: "a@x", subject: "A" });
    const { account, ctx } = await imported(server, [INBOX]);

    server.invalidate("INBOX");
    assert.equal(await imapIncrementalPass(ctx), true);

    const cursor = parseImapCursor(account.syncCursor);
    assert.equal(cursor.folders.INBOX.done, false, "the folder is handed back to the backfill");
    assert.equal(cursor.folders.INBOX.uidValidity, "101");
  });

  test("reads a narrow range rather than the whole folder", async () => {
    const server = new FakeImapServer(["INBOX"]);
    server.add("INBOX", { messageId: "a@x" });
    const { ctx } = await imported(server, [INBOX]);
    server.fetches.length = 0;

    await imapIncrementalPass(ctx);

    assert.ok(server.fetches.length > 0);
    for (const fetch of server.fetches) {
      assert.notEqual(fetch.range, "1:*", "a 200k-message folder cannot be re-read every minute");
    }
  });
});

// ───────────────────────────── error copy ─────────────────────────────

describe("imapSyncErrorMessage", () => {
  test("turns an authentication failure into the fix", async () => {
    const message = imapSyncErrorMessage(new Error("AUTHENTICATIONFAILED Invalid credentials"));
    assert.match(message, /app password/i);
  });

  test("names a hostname that does not resolve", () => {
    assert.match(imapSyncErrorMessage(new Error("getaddrinfo ENOTFOUND imap.typo.example")), /hostname/i);
  });

  test("says a certificate was rejected rather than blaming the password", () => {
    assert.match(
      imapSyncErrorMessage(new Error("self-signed certificate in certificate chain")),
      /certificate/i,
    );
  });

  test("passes an unfamiliar failure through rather than swallowing it", () => {
    assert.equal(imapSyncErrorMessage(new Error("Server said no")), "Server said no");
  });
});
