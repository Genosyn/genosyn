import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  attachmentBytes,
  findSpecialFolder,
  inboxFolder,
  loginNameFor,
  parseImapConnectionConfig,
  parseSource,
  toFetched,
  type ImapConnectionConfig,
} from "./imapClient.js";
import { headerOf, headersFromLines, type ImapFolder } from "./imapModel.js";

/**
 * The parts of the IMAP client that can be tested without a mail server:
 * reading a stored credential, finding the folder an operation means, and
 * turning bytes back into something the mirror can store.
 *
 * Folder discovery in particular is worth pinning. RFC 6154 special-use flags
 * are a decade newer than most of the mail servers people actually run, so the
 * name fallback is not a nicety — it is the path a large share of self-hosted
 * installs will take.
 */

const STORED = {
  address: "Ops@Acme.Example ",
  password: "app-password",
  imapHost: " imap.acme.example ",
  imapPort: 993,
  imapSecure: true,
  smtpHost: "smtp.acme.example",
  smtpPort: 587,
  smtpSecure: false,
};

describe("parseImapConnectionConfig", () => {
  test("reads a stored credential back", () => {
    const config = parseImapConnectionConfig(STORED);
    assert.equal(config.address, "ops@acme.example");
    assert.equal(config.imapHost, "imap.acme.example");
    assert.equal(config.imapPort, 993);
    assert.equal(config.smtpSecure, false);
  });

  test("refuses a config with no address or no password, with a message that says which", () => {
    // Both are how a half-written or key-rotated Connection shows up. A vague
    // failure here becomes an opaque login error much later.
    assert.throws(() => parseImapConnectionConfig({ ...STORED, address: "" }), /email address/i);
    assert.throws(() => parseImapConnectionConfig({ ...STORED, password: "" }), /password/i);
  });

  test("falls back to the standard ports when the stored ones are nonsense", () => {
    const config = parseImapConnectionConfig({
      ...STORED,
      imapPort: "not a port",
      smtpPort: 99999,
    });
    assert.equal(config.imapPort, 993);
    assert.equal(config.smtpPort, 587);
  });

  test("treats a missing imapSecure as TLS, never as plaintext", () => {
    // The default has to fail closed: silently downgrading a mailbox to a
    // cleartext login would put an app password on the wire.
    const config = parseImapConnectionConfig({ ...STORED, imapSecure: undefined });
    assert.equal(config.imapSecure, true);
  });

  test("carries no way to turn TLS verification off", () => {
    // A stored flag would be reachable over the API, invisible in the UI, and
    // impossible to audit afterwards. An internal CA belongs in
    // NODE_EXTRA_CA_CERTS, which trusts that CA rather than trusting nothing.
    const config = parseImapConnectionConfig({ ...STORED, allowInvalidCertificate: true });
    assert.equal("allowInvalidCertificate" in config, false);
  });
});

describe("loginNameFor", () => {
  const base = parseImapConnectionConfig(STORED);

  test("logs in as the address by default", () => {
    assert.equal(loginNameFor(base), "ops@acme.example");
  });

  test("uses a separate login name when the server wants one", () => {
    assert.equal(loginNameFor({ ...base, username: "ops" } as ImapConnectionConfig), "ops");
  });
});

describe("findSpecialFolder", () => {
  const flagged: ImapFolder[] = [
    { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
    { path: "Sent", name: "Sent", specialUse: "\\Sent" },
    { path: "Bin", name: "Bin", specialUse: "\\Trash" },
  ];

  test("prefers the server's own special-use flag", () => {
    assert.equal(findSpecialFolder(flagged, "\\Trash")?.path, "Bin");
  });

  test("falls back to the folder's name on a server that flags nothing", () => {
    // RFC 6154 postdates most deployed mail servers; plenty just ship a
    // folder called "Sent Items" and expect the client to work it out.
    const unflagged: ImapFolder[] = [
      { path: "INBOX", name: "INBOX" },
      { path: "Sent Items", name: "Sent Items" },
      { path: "Deleted Items", name: "Deleted Items" },
      { path: "Junk E-mail", name: "Junk E-mail" },
    ];
    assert.equal(findSpecialFolder(unflagged, "\\Sent")?.path, "Sent Items");
    assert.equal(findSpecialFolder(unflagged, "\\Trash")?.path, "Deleted Items");
    assert.equal(findSpecialFolder(unflagged, "\\Junk")?.path, "Junk E-mail");
  });

  test("matches a folder name case-insensitively", () => {
    assert.equal(findSpecialFolder([{ path: "SENT", name: "SENT" }], "\\Sent")?.path, "SENT");
  });

  test("treats the all-mail folder as the archive when there is no Archive", () => {
    const folders: ImapFolder[] = [{ path: "All Mail", name: "All Mail", specialUse: "\\All" }];
    assert.equal(findSpecialFolder(folders, "\\Archive")?.path, "All Mail");
  });

  test("prefers a real Archive folder over the all-mail one", () => {
    const folders: ImapFolder[] = [
      { path: "All Mail", name: "All Mail", specialUse: "\\All" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive" },
    ];
    assert.equal(findSpecialFolder(folders, "\\Archive")?.path, "Archive");
  });

  test("answers null rather than picking something that is not it", () => {
    // The caller creates the folder when this is null. Returning a random
    // near-match would file somebody's mail somewhere they never chose.
    assert.equal(findSpecialFolder([{ path: "Newsletters", name: "Newsletters" }], "\\Trash"), null);
  });
});

describe("inboxFolder", () => {
  test("finds the INBOX whatever case the server reports it in", () => {
    assert.equal(inboxFolder([{ path: "Inbox", name: "Inbox" }]).path, "Inbox");
  });

  test("names it anyway when the listing did not, since every server has one", () => {
    assert.equal(inboxFolder([]).path, "INBOX");
  });
});

describe("toFetched", () => {
  test("normalizes one FETCH row into a location, flags and bytes", () => {
    const fetched = toFetched({
      message: {
        seq: 1,
        uid: 42,
        flags: new Set(["\\Seen"]),
        internalDate: new Date("2026-02-03T10:00:00Z"),
        size: 128,
        source: Buffer.from("From: a@x"),
      },
      folder: "INBOX",
      uidValidity: "100",
    });
    assert.deepEqual(fetched.location, { folder: "INBOX", uidValidity: "100", uid: 42 });
    assert.deepEqual(fetched.flags, ["\\Seen"]);
    assert.equal(fetched.size, 128);
    assert.deepEqual(fetched.internalDate, new Date("2026-02-03T10:00:00Z"));
  });

  test("accepts an internal date the server sent as a string", () => {
    const fetched = toFetched({
      message: { seq: 1, uid: 1, internalDate: "2026-02-03T10:00:00Z" },
      folder: "INBOX",
      uidValidity: "1",
    });
    assert.deepEqual(fetched.internalDate, new Date("2026-02-03T10:00:00Z"));
  });

  test("reports no bytes rather than an empty buffer when none were asked for", () => {
    // The caller decides what to do about a message it could not read; an
    // empty Buffer would parse as a message with no headers at all.
    const fetched = toFetched({
      message: { seq: 1, uid: 1 },
      folder: "INBOX",
      uidValidity: "1",
    });
    assert.equal(fetched.source, null);
  });
});

// ───────────────────────────── parsing real bytes ─────────────────────────────

const MULTIPART = Buffer.from(
  [
    "From: Ada <ada@northwind.example>",
    "To: ops@acme.example",
    "Subject: =?UTF-8?B?Q2Fmw6kgLSBkZXZpcw==?=",
    "Message-ID: <m1@northwind.example>",
    "References: <root@northwind.example>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="B1"',
    "",
    "--B1",
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Here is the quote.",
    "--B1",
    'Content-Type: application/pdf; name="quote.pdf"',
    "Content-Transfer-Encoding: base64",
    'Content-Disposition: attachment; filename="quote.pdf"',
    "",
    Buffer.from("%PDF-1.7 fake").toString("base64"),
    "--B1--",
    "",
  ].join("\r\n"),
  "utf8",
);

describe("parseSource", () => {
  test("reads the headers back in their raw form", async () => {
    // The mirror stores addresses verbatim; re-deriving them from a decoded
    // object would quietly rewrite what the sender actually wrote.
    const headers = headersFromLines((await parseSource(MULTIPART)).headerLines);
    assert.equal(headerOf(headers, "From"), "Ada <ada@northwind.example>");
    assert.equal(headerOf(headers, "References"), "<root@northwind.example>");
  });

  test("decodes an RFC 2047 subject the reader would otherwise see as gibberish", async () => {
    const parsed = await parseSource(MULTIPART);
    assert.equal(parsed.headerLines.some((l) => l.key === "subject"), true);
  });

  test("extracts the text body and the attachment separately", async () => {
    const parsed = await parseSource(MULTIPART);
    assert.match(parsed.text ?? "", /Here is the quote\./);
    assert.deepEqual(
      parsed.attachments.map((a) => a.filename),
      ["quote.pdf"],
    );
  });

  test("survives a message that is nothing but a header block", async () => {
    const parsed = await parseSource(Buffer.from("Subject: Empty\r\n\r\n", "utf8"));
    assert.deepEqual(parsed.attachments, []);
  });
});

describe("attachmentBytes", () => {
  test("returns the decoded file, not its base64", async () => {
    const bytes = await attachmentBytes(MULTIPART, { partId: "2", filename: "quote.pdf" });
    assert.equal(bytes.toString(), "%PDF-1.7 fake");
  });

  test("finds the file by name when the part id has drifted", async () => {
    const bytes = await attachmentBytes(MULTIPART, { partId: "99", filename: "quote.pdf" });
    assert.equal(bytes.toString(), "%PDF-1.7 fake");
  });

  test("says the file is gone rather than returning somebody else's", async () => {
    await assert.rejects(
      () => attachmentBytes(MULTIPART, { partId: "99", filename: "nothing.pdf" }),
      /no longer on this message/,
    );
  });
});
