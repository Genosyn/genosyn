import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { GmailMessage } from "../gmailClient.js";
import { encodePath } from "../imapModel.js";
import { toMailboxMessage } from "./gmail.js";
import { folderPathForLabel, messageIdFromHeaderBlock, recipientsFromRaw } from "./imap.js";
import { CANONICAL_LABELS } from "./types.js";

/**
 * The two adapters' translation layers.
 *
 * Gmail's is nearly a pass-through — its label vocabulary *is* the canonical
 * one — so the interesting case is the partial fetch that must not be mistaken
 * for a message with no body. The IMAP side's translations are where the two
 * models genuinely disagree: a label is a folder, and a blind copy has to
 * reach its recipient without appearing in anyone's headers.
 */

// ───────────────────────────── Gmail ─────────────────────────────

function gmailMessage(over: Partial<GmailMessage> = {}): GmailMessage {
  return {
    id: "gm1",
    threadId: "gt1",
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Thanks &amp; regards &#8212; Ada",
    internalDate: "1770112800000",
    sizeEstimate: 4096,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Ada <ada@northwind.example>" },
        { name: "Subject", value: "Two banners" },
      ],
      body: { data: Buffer.from("Body text.", "utf8").toString("base64url"), size: 10 },
    },
    ...over,
  } as GmailMessage;
}

describe("toMailboxMessage", () => {
  test("carries Gmail's labels through unchanged", () => {
    // Gmail's system-label ids are the canonical set, which is exactly why
    // they were chosen as the canonical set: no live data had to migrate.
    const message = toMailboxMessage(gmailMessage());
    assert.deepEqual(message.labelIds, [CANONICAL_LABELS.inbox, CANONICAL_LABELS.unread]);
  });

  test("decodes the HTML entities Gmail puts in a snippet", () => {
    // The snippet is rendered as text in the thread list; "&amp;" there is a
    // visible bug on every marketing email in the mailbox.
    assert.equal(toMailboxMessage(gmailMessage()).snippet, "Thanks & regards — Ada");
  });

  test("reads internalDate as the sent time", () => {
    assert.deepEqual(toMailboxMessage(gmailMessage()).sentAt, new Date(1770112800000));
  });

  test("treats a zero internalDate as no date at all, rather than 1970", () => {
    assert.equal(toMailboxMessage(gmailMessage({ internalDate: "0" })).sentAt, null);
  });

  test("takes hasBodies from the caller rather than guessing at the payload", () => {
    // A `metadata` fetch and a message whose only content is one attachment
    // look identical from the outside — headers, no inline data, no parts. A
    // guess that called the second one body-less would quietly stop listing
    // that message's attachment; the caller asked for a format and knows.
    const attachmentOnly = gmailMessage({
      payload: {
        mimeType: "application/pdf",
        filename: "quote.pdf",
        headers: [{ name: "Subject", value: "Quote" }],
        body: { attachmentId: "att-1", size: 900 },
      },
    });
    assert.equal(toMailboxMessage(attachmentOnly).hasBodies, true);
    assert.equal(toMailboxMessage(attachmentOnly, false).hasBodies, false);
    assert.equal(toMailboxMessage(gmailMessage()).hasBodies, true);
  });

  test("leaves the location empty, because a Gmail id never moves", () => {
    assert.equal(toMailboxMessage(gmailMessage()).location, "");
  });

  test("survives a message with no payload at all", () => {
    const message = toMailboxMessage(gmailMessage({ payload: undefined }));
    assert.deepEqual(message.headers, []);
    assert.equal(message.bodyText, "");
    assert.deepEqual(message.attachments, []);
  });
});

// ───────────────────────────── IMAP ─────────────────────────────

describe("folderPathForLabel", () => {
  test("resolves a user label back to the folder it names", () => {
    assert.equal(folderPathForLabel(`f:${encodePath("Work/Big Deal")}`), "Work/Big Deal");
  });

  test("resolves INBOX, which is the one system label that is also a folder", () => {
    assert.equal(folderPathForLabel(CANONICAL_LABELS.inbox), "INBOX");
  });

  test("refuses a label that describes a state rather than a place", () => {
    // "Apply UNREAD to this conversation" has no folder to move it to, and
    // silently doing nothing would look like the label had been applied.
    for (const label of [
      CANONICAL_LABELS.unread,
      CANONICAL_LABELS.starred,
      CANONICAL_LABELS.important,
    ]) {
      assert.throws(() => folderPathForLabel(label), /state, not a folder/);
    }
  });
});

describe("recipientsFromRaw", () => {
  const raw = (lines: string[]) => Buffer.from(`${lines.join("\r\n")}\r\n\r\nBody`, "utf8");

  test("collects To, Cc and Bcc into one envelope", () => {
    assert.deepEqual(
      recipientsFromRaw(
        raw([
          "To: Ada <ada@x.com>, bob@y.com",
          "Cc: carol@z.com",
          "Bcc: audit@internal.example",
          "Subject: Hi",
        ]),
      ).sort(),
      ["ada@x.com", "audit@internal.example", "bob@y.com", "carol@z.com"],
    );
  });

  test("reads a recipient list folded across lines", () => {
    assert.deepEqual(
      recipientsFromRaw(raw(["To: ada@x.com,", " bob@y.com", "Subject: Hi"])).sort(),
      ["ada@x.com", "bob@y.com"],
    );
  });

  test("de-duplicates somebody who appears twice", () => {
    // SMTP would otherwise deliver the message to them twice.
    assert.deepEqual(recipientsFromRaw(raw(["To: A@x.com", "Cc: a@x.com"])), ["a@x.com"]);
  });

  test("stops at the header block, so an address in the body is not a recipient", () => {
    const message = Buffer.from(
      "To: ada@x.com\r\n\r\nWrite to bcc: attacker@evil.example instead\r\n",
      "utf8",
    );
    assert.deepEqual(recipientsFromRaw(message), ["ada@x.com"]);
  });

  test("finds nothing in a message addressed to nobody", () => {
    assert.deepEqual(recipientsFromRaw(raw(["Subject: Hi"])), []);
  });
});

describe("messageIdFromHeaderBlock", () => {
  test("reads the Message-ID whatever case the server used", () => {
    assert.equal(
      messageIdFromHeaderBlock(Buffer.from("MESSAGE-ID: <a@x.com>\r\n", "utf8")),
      "<a@x.com>",
    );
  });

  test("unfolds a Message-ID split across lines", () => {
    assert.equal(
      messageIdFromHeaderBlock(Buffer.from("Message-ID:\r\n <a@x.com>\r\n", "utf8")),
      "<a@x.com>",
    );
  });

  test("answers empty for a draft that has no Message-ID yet", () => {
    // Plenty of servers' own drafts do not have one; the caller falls back to
    // addressing the message by where it sits.
    assert.equal(messageIdFromHeaderBlock(Buffer.from("Subject: Draft\r\n", "utf8")), "");
    assert.equal(messageIdFromHeaderBlock(undefined), "");
  });
});
