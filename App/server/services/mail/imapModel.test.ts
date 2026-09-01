import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  attachmentsFrom,
  canonicalLabelForFolder,
  decodeLocation,
  decodePath,
  encodeLocation,
  encodePath,
  headerOf,
  headersFromLines,
  labelCatalog,
  labelRefForFolder,
  labelsForMessage,
  mailboxMessageFrom,
  messageRefFor,
  normalizeMessageId,
  parseReferences,
  snippetFrom,
  threadRefFor,
  type ImapFolder,
  type ParsedSource,
} from "./imapModel.js";
import { CANONICAL_LABELS } from "./mailbox/types.js";

/**
 * The decisions that make an IMAP mailbox behave like the rest of the Email
 * section: what counts as one conversation, what a folder means, and what
 * survives a message being moved.
 *
 * All of it is pure, so it is tested against fixtures rather than against
 * somebody's mail server — which is the only way the awkward cases (a message
 * with no `Message-ID`, a folder called "Sent Items", a `References` chain
 * folded across three lines) get covered at all.
 */

const INBOX: ImapFolder = { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" };
const SENT: ImapFolder = { path: "Sent", name: "Sent", specialUse: "\\Sent" };
const JUNK: ImapFolder = { path: "Junk", name: "Junk", specialUse: "\\Junk" };
const ARCHIVE: ImapFolder = { path: "Archive", name: "Archive", specialUse: "\\Archive" };
const PROJECTS: ImapFolder = { path: "Work/Big Deal", name: "Big Deal" };

// ───────────────────────────── paths ─────────────────────────────

describe("folder paths inside identifiers", () => {
  test("round-trips a path with spaces, slashes and unicode", () => {
    for (const path of ["INBOX", "Sent Items", "Work/Big Deal", "Boîte de réception", "a.b.c"]) {
      assert.equal(decodePath(encodePath(path)), path);
    }
  });

  test("never emits a space", () => {
    // Label ids live space-delimited in `MailMessage.labelIds` so `LIKE
    // '% X %'` can answer membership. A raw "Sent Items" would break that
    // query for every mailbox on earth that ships a two-word folder.
    assert.doesNotMatch(encodePath("Sent Items"), /\s/);
    assert.doesNotMatch(labelRefForFolder(PROJECTS) ?? "", /\s/);
  });
});

// ───────────────────────────── locations ─────────────────────────────

describe("message locations", () => {
  test("round-trips folder, UIDVALIDITY and UID", () => {
    const at = { folder: "Sent Items", uidValidity: "1699999999", uid: 4211 };
    assert.deepEqual(decodeLocation(encodeLocation(at)), at);
  });

  test("refuses anything it cannot address, rather than guessing", () => {
    // A half-parsed location would point at *some* message in *some* folder,
    // which is worse than admitting we do not know where the message is.
    for (const bad of [
      "",
      "not-a-location",
      "abc:1:2:3",
      `${encodePath("INBOX")}:notanumber:5`,
      `${encodePath("INBOX")}:1:0`,
      `${encodePath("INBOX")}:1:-4`,
      `${encodePath("INBOX")}:1:notanumber`,
      ":1:5",
    ]) {
      assert.equal(decodeLocation(bad), null, `expected "${bad}" to be rejected`);
    }
  });
});

// ───────────────────────────── identity ─────────────────────────────

describe("normalizeMessageId", () => {
  test("strips the angle brackets and surrounding whitespace", () => {
    assert.equal(normalizeMessageId("  <abc@example.com>  "), "abc@example.com");
    assert.equal(normalizeMessageId("abc@example.com"), "abc@example.com");
  });
});

describe("parseReferences", () => {
  test("reads every id in a chain, oldest first", () => {
    assert.deepEqual(parseReferences("<a@x> <b@x>\r\n <c@x>"), ["a@x", "b@x", "c@x"]);
  });

  test("tolerates a bare id with no brackets", () => {
    assert.deepEqual(parseReferences("a@x"), ["a@x"]);
  });

  test("reads nothing out of an empty or whitespace-only header", () => {
    assert.deepEqual(parseReferences(""), []);
    assert.deepEqual(parseReferences("   "), []);
  });
});

describe("messageRefFor", () => {
  const location = { folder: "INBOX", uidValidity: "1", uid: 7 };

  test("survives the message being moved to another folder", () => {
    // This is the whole reason the mirror does not key on UID: archiving a
    // message gives it a new one, and a UID-keyed row would lose the message
    // the first time anybody touched it.
    const inInbox = messageRefFor({ messageId: "<a@x>", location });
    const inArchive = messageRefFor({
      messageId: "<a@x>",
      location: { folder: "Archive", uidValidity: "9", uid: 1201 },
    });
    assert.equal(inInbox, inArchive);
  });

  test("gives two different messages two different ids", () => {
    assert.notEqual(
      messageRefFor({ messageId: "<a@x>", location }),
      messageRefFor({ messageId: "<b@x>", location }),
    );
  });

  test("falls back to the location when a message has no Message-ID at all", () => {
    // Rare but real — broken senders, and some servers' own drafts. Such a
    // message re-imports if it moves, which is what every other client does.
    const ref = messageRefFor({ messageId: "", location });
    assert.match(ref, /^u:/);
    assert.deepEqual(decodeLocation(ref.slice(2)), location);
  });

  test("ignores the brackets, so the same id in either form is one message", () => {
    assert.equal(
      messageRefFor({ messageId: "<a@x>", location }),
      messageRefFor({ messageId: "a@x", location }),
    );
  });
});

describe("threadRefFor", () => {
  test("groups a reply with the message it answers", () => {
    const root = threadRefFor({ messageId: "<root@x>", references: "", inReplyTo: "" });
    const reply = threadRefFor({
      messageId: "<reply@x>",
      references: "<root@x>",
      inReplyTo: "<root@x>",
    });
    assert.equal(reply, root);
  });

  test("groups a deep reply with the root, not with its immediate parent", () => {
    // Taking In-Reply-To would split a long conversation into a chain of
    // two-message threads. The first entry of References is the root.
    const root = threadRefFor({ messageId: "<root@x>", references: "", inReplyTo: "" });
    const deep = threadRefFor({
      messageId: "<third@x>",
      references: "<root@x> <second@x>",
      inReplyTo: "<second@x>",
    });
    assert.equal(deep, root);
  });

  test("uses In-Reply-To when the sender wrote no References chain", () => {
    const root = threadRefFor({ messageId: "<root@x>", references: "", inReplyTo: "" });
    const reply = threadRefFor({ messageId: "<r@x>", references: "", inReplyTo: "<root@x>" });
    assert.equal(reply, root);
  });

  test("is stateless — the same message lands in the same thread whatever order the mailbox is imported in", () => {
    // The backfill walks folders in whatever order the server lists them and
    // resumes mid-walk after a crash. A threading rule that depended on what
    // had already been imported would put the same message in different
    // conversations on different runs.
    const args = { messageId: "<c@x>", references: "<a@x> <b@x>", inReplyTo: "<b@x>" };
    assert.equal(threadRefFor(args), threadRefFor(args));
  });

  test("gives an unrelated message its own conversation", () => {
    assert.notEqual(
      threadRefFor({ messageId: "<a@x>", references: "", inReplyTo: "" }),
      threadRefFor({ messageId: "<b@x>", references: "", inReplyTo: "" }),
    );
  });

  test("gives each header-less message its own conversation, not one shared heap", () => {
    // Without the fallback every message with no Message-ID, References or
    // In-Reply-To hashes the same empty string, and a mailbox full of
    // machine-generated mail collapses into one enormous thread.
    const first = threadRefFor({ messageId: "", references: "", inReplyTo: "", fallback: "u:a" });
    const second = threadRefFor({ messageId: "", references: "", inReplyTo: "", fallback: "u:b" });
    assert.match(first, /^t:/);
    assert.notEqual(first, second);
    assert.equal(
      first,
      threadRefFor({ messageId: "", references: "", inReplyTo: "", fallback: "u:a" }),
    );
  });
});

// ───────────────────────────── folders and flags ─────────────────────────────

describe("canonicalLabelForFolder", () => {
  test("maps the special-use folders onto the labels the rest of the app already reads", () => {
    assert.equal(canonicalLabelForFolder(INBOX), CANONICAL_LABELS.inbox);
    assert.equal(canonicalLabelForFolder(SENT), CANONICAL_LABELS.sent);
    assert.equal(canonicalLabelForFolder(JUNK), CANONICAL_LABELS.spam);
    assert.equal(
      canonicalLabelForFolder({ path: "Drafts", name: "Drafts", specialUse: "\\Drafts" }),
      CANONICAL_LABELS.draft,
    );
    assert.equal(
      canonicalLabelForFolder({ path: "Trash", name: "Trash", specialUse: "\\Trash" }),
      CANONICAL_LABELS.trash,
    );
  });

  test("recognises the INBOX by name even when the server flags nothing", () => {
    assert.equal(
      canonicalLabelForFolder({ path: "inbox", name: "inbox" }),
      CANONICAL_LABELS.inbox,
    );
  });

  test("gives Archive no label at all", () => {
    // On Gmail, archived mail is exactly "mail with no INBOX label" — there is
    // no ARCHIVE label to hold. Mapping the IMAP Archive folder to nothing is
    // what makes the Archive button mean the same thing on both providers.
    assert.equal(canonicalLabelForFolder(ARCHIVE), null);
    assert.equal(canonicalLabelForFolder({ path: "All Mail", name: "All Mail", specialUse: "\\All" }), null);
  });

  test("gives an ordinary folder no canonical label", () => {
    assert.equal(canonicalLabelForFolder(PROJECTS), null);
  });
});

describe("labelRefForFolder", () => {
  test("an ordinary folder becomes a user label keyed on its path", () => {
    assert.equal(labelRefForFolder(PROJECTS), `f:${encodePath("Work/Big Deal")}`);
  });

  test("Archive contributes nothing, so archived mail carries no folder label", () => {
    assert.equal(labelRefForFolder(ARCHIVE), null);
  });

  test("a folder that cannot be selected is skipped", () => {
    assert.equal(labelRefForFolder({ path: "Shared", name: "Shared", specialUse: "\\Noselect" }), null);
  });
});

describe("labelsForMessage", () => {
  test("an unread inbox message reads as INBOX + UNREAD", () => {
    assert.deepEqual(labelsForMessage({ folder: INBOX, flags: [] }).sort(), ["INBOX", "UNREAD"]);
  });

  test("the \\Seen flag is the absence of UNREAD, not a label of its own", () => {
    assert.deepEqual(labelsForMessage({ folder: INBOX, flags: ["\\Seen"] }), ["INBOX"]);
  });

  test("\\Flagged is STARRED and \\Draft is DRAFT", () => {
    assert.deepEqual(
      labelsForMessage({ folder: INBOX, flags: ["\\Seen", "\\Flagged", "\\Draft"] }).sort(),
      ["DRAFT", "INBOX", "STARRED"],
    );
  });

  test("flag comparison is case-insensitive, because servers disagree about it", () => {
    assert.deepEqual(labelsForMessage({ folder: INBOX, flags: ["\\seen"] }), ["INBOX"]);
  });

  test("mail in Junk reads as SPAM, which is what the unsubscribe gate checks", () => {
    assert.ok(labelsForMessage({ folder: JUNK, flags: ["\\Seen"] }).includes("SPAM"));
  });

  test("archived mail carries no INBOX label, so it leaves the inbox list", () => {
    assert.deepEqual(labelsForMessage({ folder: ARCHIVE, flags: ["\\Seen"] }), []);
  });

  test("ignores an unknown keyword rather than inventing a label for it", () => {
    assert.deepEqual(labelsForMessage({ folder: INBOX, flags: ["\\Seen", "$Phishing"] }), ["INBOX"]);
  });
});

describe("labelCatalog", () => {
  const catalog = labelCatalog([INBOX, SENT, ARCHIVE, PROJECTS, JUNK]);

  test("always lists the canonical system labels, folder or no folder", () => {
    // The sidebar counts and the `is:unread` search term resolve against this
    // catalog, and no folder ever produces UNREAD or STARRED.
    const refs = catalog.map((l) => l.ref);
    for (const ref of ["INBOX", "UNREAD", "STARRED", "SENT", "DRAFT", "TRASH", "SPAM"]) {
      assert.ok(refs.includes(ref), `catalog is missing ${ref}`);
    }
  });

  test("lists an ordinary folder as a user label under its full path", () => {
    const entry = catalog.find((l) => l.name === "Work/Big Deal");
    assert.ok(entry);
    assert.equal(entry.labelType, "user");
  });

  test("does not list Archive, which has no label", () => {
    assert.equal(
      catalog.some((l) => l.name === "Archive"),
      false,
    );
  });

  test("never repeats a ref", () => {
    const refs = catalog.map((l) => l.ref);
    assert.equal(new Set(refs).size, refs.length);
  });
});

// ───────────────────────────── parsing ─────────────────────────────

describe("headersFromLines", () => {
  test("unfolds a continuation line", () => {
    // A folded References chain that kept its newline would break threading
    // and the reply builder at the same time.
    const headers = headersFromLines([
      { key: "references", line: "References: <a@x>\r\n <b@x>\r\n\t<c@x>" },
    ]);
    assert.deepEqual(headers, [{ name: "References", value: "<a@x> <b@x> <c@x>" }]);
  });

  test("keeps the raw value rather than a decoded one", () => {
    const headers = headersFromLines([{ key: "to", line: 'To: "Ada, L" <ada@x.com>' }]);
    assert.equal(headerOf(headers, "To"), '"Ada, L" <ada@x.com>');
  });

  test("skips a line with no colon instead of storing a nameless header", () => {
    assert.deepEqual(headersFromLines([{ key: "", line: "garbage" }]), []);
  });
});

describe("headerOf", () => {
  const headers = [{ name: "Message-ID", value: "<a@x>" }];
  test("matches case-insensitively, because senders disagree about capitals", () => {
    assert.equal(headerOf(headers, "message-id"), "<a@x>");
  });
  test("answers an absent header with an empty string", () => {
    assert.equal(headerOf(headers, "Subject"), "");
  });
});

describe("snippetFrom", () => {
  test("collapses whitespace so the list row reads as one line", () => {
    assert.equal(snippetFrom("Hi   there\n\nAda", ""), "Hi there Ada");
  });

  test("falls back to the HTML body when there is no text part", () => {
    assert.equal(snippetFrom("", "<p>Hello <b>there</b></p>"), "Hello there");
  });

  test("drops script and style content rather than showing CSS to the reader", () => {
    assert.equal(snippetFrom("", "<style>p{color:red}</style><p>Hi</p>"), "Hi");
  });

  test("truncates with an ellipsis", () => {
    const snippet = snippetFrom("x".repeat(500), "");
    assert.equal(snippet.length, 221);
    assert.ok(snippet.endsWith("…"));
  });
});

describe("attachmentsFrom", () => {
  test("numbers parts from one when the parser reports no part id", () => {
    const parsed: ParsedSource = {
      headerLines: [],
      attachments: [
        { filename: "a.pdf", contentType: "application/pdf", size: 10 },
        { filename: "b.png", contentType: "image/png", size: 20 },
      ],
    };
    assert.deepEqual(
      attachmentsFrom(parsed).map((a) => a.attachmentId),
      ["1", "2"],
    );
  });

  test("drops an inline image nobody named, and keeps a named one", () => {
    // A `related` part with no filename is a tracking pixel or a signature
    // logo; listing it as an attachment makes every newsletter look like it
    // shipped a file.
    const parsed: ParsedSource = {
      headerLines: [],
      attachments: [
        { contentType: "image/gif", size: 43, related: true },
        { filename: "logo.png", contentType: "image/png", size: 900, related: true },
      ],
    };
    assert.deepEqual(
      attachmentsFrom(parsed).map((a) => a.filename),
      ["logo.png"],
    );
  });

  test("names an unnamed attachment rather than showing an empty row", () => {
    const parsed: ParsedSource = {
      headerLines: [],
      attachments: [{ contentType: "application/octet-stream", size: 4 }],
    };
    assert.equal(attachmentsFrom(parsed)[0].filename, "attachment-1");
  });
});

// ───────────────────────────── the whole row ─────────────────────────────

describe("mailboxMessageFrom", () => {
  const parsed: ParsedSource = {
    headerLines: [
      { key: "from", line: "From: Ada <ada@x.com>" },
      { key: "to", line: "To: team@y.com" },
      { key: "subject", line: "Subject: Two banners" },
      { key: "message-id", line: "Message-ID: <m1@x.com>" },
      { key: "references", line: "References: <root@x.com>" },
    ],
    text: "Body text here",
    html: "<p>Body text here</p>",
    date: new Date("2026-02-03T10:00:00Z"),
    attachments: [{ filename: "quote.pdf", contentType: "application/pdf", size: 12 }],
  };
  const location = { folder: "INBOX", uidValidity: "42", uid: 9 };

  test("builds the row the mirror stores", () => {
    const message = mailboxMessageFrom({
      parsed,
      folder: INBOX,
      flags: [],
      location,
      internalDate: new Date("2026-02-03T10:05:00Z"),
      size: 4096,
      hasBodies: true,
    });
    assert.equal(message.ref, messageRefFor({ messageId: "<m1@x.com>", location }));
    assert.equal(
      message.threadRef,
      threadRefFor({ messageId: "<m1@x.com>", references: "<root@x.com>", inReplyTo: "" }),
    );
    assert.deepEqual(message.labelIds.sort(), ["INBOX", "UNREAD"]);
    assert.equal(headerOf(message.headers, "Subject"), "Two banners");
    assert.equal(message.bodyText, "Body text here");
    assert.equal(message.bodyHtml, "<p>Body text here</p>");
    assert.equal(message.sizeEstimate, 4096);
    assert.equal(message.location, encodeLocation(location));
    assert.deepEqual(message.sentAt, new Date("2026-02-03T10:00:00Z"));
  });

  test("prefers the sender's Date header over the server's arrival time", () => {
    // The list is sorted by when a message was written, not by when this
    // particular server happened to receive it — otherwise re-importing a
    // mailbox would reshuffle every conversation.
    const message = mailboxMessageFrom({
      parsed,
      folder: INBOX,
      flags: [],
      location,
      internalDate: new Date("2026-06-01T00:00:00Z"),
      hasBodies: true,
    });
    assert.deepEqual(message.sentAt, new Date("2026-02-03T10:00:00Z"));
  });

  test("falls back to the arrival time when the sender wrote no Date", () => {
    const message = mailboxMessageFrom({
      parsed: { ...parsed, date: undefined },
      folder: INBOX,
      flags: [],
      location,
      internalDate: new Date("2026-06-01T00:00:00Z"),
      hasBodies: true,
    });
    assert.deepEqual(message.sentAt, new Date("2026-06-01T00:00:00Z"));
  });

  test("reports no attachments on a header-only read, so the mirror keeps the ones it has", () => {
    const message = mailboxMessageFrom({
      parsed,
      folder: INBOX,
      flags: [],
      location,
      hasBodies: false,
    });
    assert.equal(message.hasBodies, false);
    assert.deepEqual(message.attachments, []);
  });

  test("treats a missing HTML body as an empty string, not the parser's `false`", () => {
    const message = mailboxMessageFrom({
      parsed: { ...parsed, html: false },
      folder: INBOX,
      flags: [],
      location,
      hasBodies: true,
    });
    assert.equal(message.bodyHtml, "");
  });
});
