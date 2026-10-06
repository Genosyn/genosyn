import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";

import type { MailAccount } from "../../../db/entities/MailAccount.js";
import { headerValue, parseAddress } from "../gmailClient.js";
import type { ImapConnectionConfig } from "../imapClient.js";
import { encodeLocation } from "../imapModel.js";
import { ImapMailbox, type ImapMailboxDependencies } from "./imap.js";

/**
 * The name on mail an IMAP mailbox sends, end to end through the adapter.
 *
 * An IMAP/SMTP account has no identity on the server, so the `From` header is
 * whatever the client writes — and for a long time Genosyn wrote the bare
 * address, so every recipient saw `avery@example.com` and never a name. These
 * cases drive the real adapter against an in-memory IMAP server and keep the
 * exact bytes handed to SMTP, then read them the way a recipient's mail client
 * would. They pin four things: fresh mail carries the mailbox's sender name;
 * the SMTP envelope still carries only the address; the copy filed in Sent says
 * the same and reads back into the mirror as the same name; and a draft written
 * before the name was set, changed, or cleared goes out under the name the
 * mailbox has at the moment it is sent.
 */

type Submission = Parameters<NonNullable<ImapMailboxDependencies["smtpSend"]>>[0];
type Stored = { uid: number; flags: Set<string>; internalDate: Date; source: Buffer };
type Folder = {
  specialUse: string;
  uidValidity: string;
  uidNext: number;
  messages: Map<number, Stored>;
};

const CONFIG: ImapConnectionConfig = {
  address: "avery@example.com",
  password: "app-password",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.example.com",
  smtpPort: 465,
  smtpSecure: true,
};

/** Just enough of an IMAP server for the write paths: three special folders and UIDPLUS. */
class FakeImapServer {
  readonly folders = new Map<string, Folder>([
    ["INBOX", { specialUse: "\\Inbox", uidValidity: "7", uidNext: 1, messages: new Map() }],
    ["Sent", { specialUse: "\\Sent", uidValidity: "7", uidNext: 1, messages: new Map() }],
    ["Drafts", { specialUse: "\\Drafts", uidValidity: "7", uidNext: 1, messages: new Map() }],
  ]);
  /** Every message handed to SMTP, as the bytes and envelope that went out. */
  readonly submissions: Submission[] = [];
  selected: string | null = null;

  folder(path: string): Folder {
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`No folder named ${path}`);
    return folder;
  }

  /** Put a message straight into a folder, as another mail client would. Returns its UID. */
  store(path: string, raw: Buffer | string, flags: string[] = ["\\Draft", "\\Seen"]): number {
    const folder = this.folder(path);
    const uid = folder.uidNext++;
    folder.messages.set(uid, {
      uid,
      flags: new Set(flags),
      internalDate: new Date(),
      // A copy, so the server keeps exactly the bytes it was handed.
      source: typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw),
    });
    return uid;
  }

  /** The one message in a folder, as text. */
  only(path: string): string {
    const messages = [...this.folder(path).messages.values()];
    assert.equal(messages.length, 1, `${path} should hold exactly one message`);
    return messages[0].source.toString("utf8");
  }
}

/** The `ImapFlow` surface the adapter's write paths use, and nothing more. */
function imapClientFor(server: FakeImapServer): ImapFlow {
  const client = {
    get mailbox() {
      if (!server.selected) return false;
      return {
        path: server.selected,
        uidValidity: BigInt(server.folder(server.selected).uidValidity),
      };
    },
    async list() {
      return [...server.folders].map(([path, folder]) => ({
        path,
        name: path,
        specialUse: folder.specialUse,
        subscribed: true,
        flags: new Set<string>(),
      }));
    },
    async getMailboxLock(path: string) {
      server.folder(path);
      server.selected = path;
      return { release: () => undefined };
    },
    async append(path: string, raw: Buffer, flags: string[]) {
      const uid = server.store(path, raw, flags);
      return { destination: path, uid, uidValidity: BigInt(server.folder(path).uidValidity) };
    },
    async fetchOne(range: string) {
      const stored = server.folder(server.selected ?? "").messages.get(Number(range));
      if (!stored) return false;
      return {
        uid: stored.uid,
        flags: stored.flags,
        internalDate: stored.internalDate,
        size: stored.source.length,
        source: stored.source,
      };
    },
    async messageDelete(uids: number[]) {
      const folder = server.folder(server.selected ?? "");
      for (const uid of uids) folder.messages.delete(uid);
      return true;
    },
  };
  return client as unknown as ImapFlow;
}

/** The adapter for one mailbox, as the rest of the app would build it, on the fake server. */
function mailbox(server: FakeImapServer, senderName: string): ImapMailbox {
  const account = {
    id: "mail-account-1",
    companyId: "company-1",
    provider: "imap",
    address: CONFIG.address,
    senderName,
  } as MailAccount;
  return new ImapMailbox(account, CONFIG, {
    withImap: async (_accountId, _config, work) => work(imapClientFor(server)),
    smtpSend: async (args) => {
      server.submissions.push(args);
    },
  });
}

const MESSAGE = { to: "ada@northwind.example", subject: "Two banners", bodyText: "On their way." };

function headerBlock(raw: string): string {
  const end = raw.indexOf("\r\n\r\n");
  return end >= 0 ? raw.slice(0, end) : raw;
}

/** Who a recipient's mail client says the message is from. */
async function fromAsRead(raw: Buffer | string): Promise<{ name: string; address: string }> {
  const from = (await simpleParser(raw)).from as AddressObject | undefined;
  return { name: from?.value[0]?.name ?? "", address: from?.value[0]?.address ?? "" };
}

/** Who the mirror says sent it — the path every IMAP message takes into the app. */
function fromAsMirrored(headers: Array<{ name: string; value: string }>) {
  return parseAddress(headerValue(headers, "From"));
}

describe("a message sent from an IMAP mailbox", () => {
  test("shows the mailbox's sender name beside the address", async () => {
    const server = new FakeImapServer();
    await mailbox(server, "Avery Monroe").sendMessage({ mime: MESSAGE });
    const wire = server.submissions[0].raw.toString("utf8");
    assert.match(headerBlock(wire), /^From: Avery Monroe <avery@example\.com>$/m);
    assert.deepEqual(await fromAsRead(wire), {
      name: "Avery Monroe",
      address: "avery@example.com",
    });
  });

  test("keeps the bare address on the SMTP envelope, where a name means nothing", async () => {
    // The envelope sender is what bounces return to and what SPF checks.
    const server = new FakeImapServer();
    await mailbox(server, "Avery Monroe").sendMessage({ mime: MESSAGE });
    assert.deepEqual(server.submissions[0].envelope, {
      from: "avery@example.com",
      to: ["ada@northwind.example"],
    });
  });

  test("files the same From in Sent, and the mirror reads the name back", async () => {
    const server = new FakeImapServer();
    const sent = await mailbox(server, "Avery Monroe").sendMessage({ mime: MESSAGE });
    assert.match(headerBlock(server.only("Sent")), /^From: Avery Monroe <avery@example\.com>$/m);
    assert.deepEqual(fromAsMirrored(sent.headers), {
      name: "Avery Monroe",
      email: "avery@example.com",
    });
  });

  test("still sends the bare address when no sender name is set", async () => {
    const server = new FakeImapServer();
    await mailbox(server, "").sendMessage({ mime: MESSAGE });
    assert.match(
      headerBlock(server.submissions[0].raw.toString("utf8")),
      /^From: avery@example\.com$/m,
    );
  });

  for (const name of [
    "Monroe, Avery",
    'Avery "AJ" Monroe',
    "A. Monroe (Ops)",
    "Zoë Ödegaard",
    "李雷 · 运营",
  ]) {
    test(`delivers "${name}" intact, to the recipient and to the mirror`, async () => {
      const server = new FakeImapServer();
      const sent = await mailbox(server, name).sendMessage({ mime: MESSAGE });
      assert.deepEqual(await fromAsRead(server.submissions[0].raw), {
        name,
        address: "avery@example.com",
      });
      assert.deepEqual(fromAsMirrored(sent.headers), { name, email: "avery@example.com" });
    });
  }

  test("keeps a blind copy blind with a name in From", async () => {
    const server = new FakeImapServer();
    await mailbox(server, "Avery Monroe").sendMessage({
      mime: { ...MESSAGE, bcc: "audit@example.com" },
    });
    const submission = server.submissions[0];
    assert.doesNotMatch(headerBlock(submission.raw.toString("utf8")), /^Bcc:/im);
    assert.ok(submission.envelope.to.includes("audit@example.com"));
    assert.match(headerBlock(server.only("Sent")), /^Bcc: audit@example\.com$/m);
  });
});

describe("a draft on an IMAP mailbox", () => {
  test("is written under the mailbox's sender name", async () => {
    const server = new FakeImapServer();
    await mailbox(server, "Avery Monroe").createDraft({ mime: MESSAGE });
    assert.match(headerBlock(server.only("Drafts")), /^From: Avery Monroe <avery@example\.com>$/m);
  });

  test("written before the name was set goes out with it", async () => {
    // The case that matters most in practice: an AI Employee's drafts wait
    // for review, and the name is set while they wait. Approving them must
    // not send fifty messages without it.
    const server = new FakeImapServer();
    const { draftRef } = await mailbox(server, "").createDraft({ mime: MESSAGE });
    assert.match(headerBlock(server.only("Drafts")), /^From: avery@example\.com$/m);

    const sent = await mailbox(server, "Avery Monroe").sendDraft(draftRef);
    assert.deepEqual(await fromAsRead(server.submissions[0].raw), {
      name: "Avery Monroe",
      address: "avery@example.com",
    });
    assert.match(headerBlock(server.only("Sent")), /^From: Avery Monroe <avery@example\.com>$/m);
    assert.deepEqual(fromAsMirrored(sent.headers), {
      name: "Avery Monroe",
      email: "avery@example.com",
    });
    assert.equal(server.folder("Drafts").messages.size, 0, "the sent draft leaves Drafts");
  });

  test("written under an old name goes out under the new one", async () => {
    const server = new FakeImapServer();
    const { draftRef } = await mailbox(server, "Old Name").createDraft({ mime: MESSAGE });
    await mailbox(server, "Avery Monroe").sendDraft(draftRef);
    const wire = server.submissions[0].raw.toString("utf8");
    assert.match(headerBlock(wire), /^From: Avery Monroe <avery@example\.com>$/m);
    assert.doesNotMatch(wire, /Old Name/);
  });

  test("goes out from the bare address once the name is cleared", async () => {
    const server = new FakeImapServer();
    const { draftRef } = await mailbox(server, "Avery Monroe").createDraft({ mime: MESSAGE });
    await mailbox(server, "").sendDraft(draftRef);
    assert.match(
      headerBlock(server.submissions[0].raw.toString("utf8")),
      /^From: avery@example\.com$/m,
    );
  });

  test("keeps its Message-ID, so the sent copy stays in the same conversation", async () => {
    const server = new FakeImapServer();
    const { draftRef } = await mailbox(server, "").createDraft({ mime: MESSAGE });
    const draftId = /^Message-ID: (.*)$/m.exec(server.only("Drafts"))?.[1];
    assert.ok(draftId);
    await mailbox(server, "Avery Monroe").sendDraft(draftRef);
    assert.equal(
      /^Message-ID: (.*)$/m.exec(server.submissions[0].raw.toString("utf8"))?.[1],
      draftId,
    );
    assert.equal(/^Message-ID: (.*)$/m.exec(server.only("Sent"))?.[1], draftId);
  });

  test("another client wrote from an alias keeps that From", async () => {
    // Somebody chose that identity on purpose; it is not a stale copy of ours.
    const server = new FakeImapServer();
    const uid = server.store(
      "Drafts",
      [
        "From: Avery <avery+news@example.com>",
        "To: ada@northwind.example",
        "Subject: Newsletter",
        "Message-ID: <foreign@example.com>",
        "",
        "Hello.",
        "",
      ].join("\r\n"),
    );
    await mailbox(server, "Avery Monroe").sendDraft(
      encodeLocation({ folder: "Drafts", uidValidity: "7", uid }),
    );
    const submission = server.submissions[0];
    assert.match(
      headerBlock(submission.raw.toString("utf8")),
      /^From: Avery <avery\+news@example\.com>$/m,
    );
    assert.equal(submission.envelope.from, "avery@example.com");
  });

  test("is rewritten under the current name when it is edited", async () => {
    const server = new FakeImapServer();
    const { draftRef } = await mailbox(server, "").createDraft({ mime: MESSAGE });
    await mailbox(server, "Avery Monroe").updateDraft({
      draftRef,
      mime: { ...MESSAGE, bodyText: "Edited." },
    });
    assert.match(headerBlock(server.only("Drafts")), /^From: Avery Monroe <avery@example\.com>$/m);
  });
});
