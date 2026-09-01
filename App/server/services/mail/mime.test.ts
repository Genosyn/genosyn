import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildMimeBuffer,
  buildMimeString,
  formatRfc2822Date,
  generateMessageId,
  stripBccHeader,
  toBase64Url,
  type MimeFields,
} from "./mime.js";

/**
 * Composing the bytes that leave the building.
 *
 * These used to be Gmail's problem: `messages.send` took a base64url blob and
 * the server stamped `From`, `Date` and `Message-ID` on the way past — and
 * dropped `Bcc`. An SMTP submission has no such server, so the same builder
 * now has to produce a message that is valid on its own, carry a `Message-ID`
 * the Sent copy can share, and be strippable of the one header that must never
 * reach a recipient.
 */

function fields(over: Partial<MimeFields> = {}): MimeFields {
  return {
    to: "ada@example.com",
    subject: "Two banners",
    bodyText: "Thanks — invoice on the way.",
    ...over,
  };
}

function headerBlock(raw: string): string {
  const end = raw.indexOf("\r\n\r\n");
  return end >= 0 ? raw.slice(0, end) : raw;
}

describe("the header block", () => {
  test("omits From, Date and Message-ID unless asked", () => {
    // The Gmail path relies on this: the server synthesises all three and
    // would ignore ours, so sending them would only risk a mismatch.
    const raw = buildMimeString(fields());
    assert.doesNotMatch(headerBlock(raw), /^From:/im);
    assert.doesNotMatch(headerBlock(raw), /^Date:/im);
    assert.doesNotMatch(headerBlock(raw), /^Message-ID:/im);
  });

  test("writes all three when the SMTP path supplies them", () => {
    const raw = buildMimeString(
      fields({
        from: "Ops <ops@acme.example>",
        date: new Date("2026-02-03T10:00:00Z"),
        messageId: "<abc@acme.example>",
      }),
    );
    const block = headerBlock(raw);
    assert.match(block, /^From: Ops <ops@acme\.example>$/m);
    assert.match(block, /^Date: Tue, 03 Feb 2026 10:00:00 \+0000$/m);
    assert.match(block, /^Message-ID: <abc@acme\.example>$/m);
  });

  test("puts From first, where every mail client and spam filter expects it", () => {
    const raw = buildMimeString(fields({ from: "ops@acme.example" }));
    assert.ok(headerBlock(raw).startsWith("From: ops@acme.example\r\nTo: "));
  });

  test("carries the threading headers a reply needs", () => {
    const raw = buildMimeString(
      fields({ inReplyTo: "<parent@x>", references: "<root@x> <parent@x>" }),
    );
    assert.match(headerBlock(raw), /^In-Reply-To: <parent@x>$/m);
    assert.match(headerBlock(raw), /^References: <root@x> <parent@x>$/m);
  });

  test("includes Bcc in the message it composes", () => {
    // The header is written here and stripped by the transport, which passes
    // envelope recipients separately — that is what makes a blind copy blind.
    assert.match(headerBlock(buildMimeString(fields({ bcc: "audit@x.com" }))), /^Bcc: /m);
  });
});

describe("header injection", () => {
  test("a newline in the subject cannot smuggle a second header", () => {
    const raw = buildMimeString(fields({ subject: "Hi\r\nBcc: attacker@evil.example" }));
    assert.doesNotMatch(headerBlock(raw), /^Bcc:/im);
    assert.match(headerBlock(raw), /^Subject: Hi Bcc: attacker@evil\.example$/m);
  });

  test("a newline in a display name cannot either", () => {
    const raw = buildMimeString(
      fields({ to: "Ada\r\nBcc: attacker@evil.example <ada@example.com>" }),
    );
    assert.doesNotMatch(headerBlock(raw), /^Bcc:/im);
  });

  test("a newline in the From address is stripped too", () => {
    const raw = buildMimeString(
      fields({ from: "ops@acme.example\r\nBcc: attacker@evil.example" }),
    );
    assert.doesNotMatch(headerBlock(raw), /^Bcc:/im);
  });

  test("a control character in a Message-ID is stripped", () => {
    const raw = buildMimeString(fields({ messageId: "<a@x>\r\nX-Evil: 1" }));
    assert.doesNotMatch(headerBlock(raw), /^X-Evil:/im);
  });
});

describe("unicode", () => {
  test("RFC 2047-encodes a non-ASCII subject", () => {
    const raw = buildMimeString(fields({ subject: "Café — devis" }));
    assert.match(headerBlock(raw), /^Subject: =\?UTF-8\?B\?/m);
  });

  test("leaves a plain ASCII subject alone, so it stays readable in the raw source", () => {
    assert.match(headerBlock(buildMimeString(fields())), /^Subject: Two banners$/m);
  });

  test("encodes a non-ASCII display name but not the address beside it", () => {
    const raw = buildMimeString(fields({ to: "Ada Løvelace <ada@example.com>" }));
    assert.match(headerBlock(raw), /^To: =\?UTF-8\?B\?[^?]+\?= <ada@example\.com>$/m);
  });

  test("survives a body in a script with no ASCII in it at all", () => {
    const raw = buildMimeString(fields({ bodyText: "こんにちは、世界" }));
    const body = raw.slice(raw.indexOf("\r\n\r\n") + 4).replace(/\r\n/g, "");
    assert.equal(Buffer.from(body, "base64").toString("utf8"), "こんにちは、世界");
  });
});

describe("body structure", () => {
  test("a text-only message is one base64 text/plain part", () => {
    const raw = buildMimeString(fields());
    assert.match(raw, /Content-Type: text\/plain; charset="UTF-8"/);
    assert.doesNotMatch(raw, /multipart/);
  });

  test("adding HTML makes it multipart/alternative with both parts", () => {
    const raw = buildMimeString(fields({ bodyHtml: "<p>Hi</p>" }));
    assert.match(raw, /Content-Type: multipart\/alternative; boundary="/);
    assert.match(raw, /Content-Type: text\/plain/);
    assert.match(raw, /Content-Type: text\/html/);
  });

  test("an attachment makes it multipart/mixed with the file as its own part", () => {
    const raw = buildMimeString(
      fields({
        attachments: [
          { filename: "quote.pdf", mimeType: "application/pdf", content: Buffer.from("%PDF-1.7") },
        ],
      }),
    );
    assert.match(raw, /Content-Type: multipart\/mixed; boundary="/);
    assert.match(raw, /Content-Disposition: attachment; filename="quote\.pdf"/);
    assert.match(raw, /Content-Type: application\/pdf; name="quote\.pdf"/);
  });

  test("a quote or newline in a filename cannot break out of the header", () => {
    const raw = buildMimeString(
      fields({
        attachments: [
          { filename: 'ev"il\r\n.pdf', mimeType: "application/pdf", content: Buffer.from("x") },
        ],
      }),
    );
    assert.match(raw, /filename="evil\.pdf"/);
  });

  test("two messages get different boundaries, so one body cannot end another", () => {
    const a = /boundary="([^"]+)"/.exec(buildMimeString(fields({ bodyHtml: "<p>a</p>" })))?.[1];
    const b = /boundary="([^"]+)"/.exec(buildMimeString(fields({ bodyHtml: "<p>b</p>" })))?.[1];
    assert.ok(a && b);
    assert.notEqual(a, b);
  });

  test("every line stays inside the RFC 2045 76-character limit", () => {
    const raw = buildMimeString(fields({ bodyText: "x".repeat(5000) }));
    const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
    for (const line of body.split("\r\n")) {
      assert.ok(line.length <= 76, `a ${line.length}-char line would be refused by strict servers`);
    }
  });
});

describe("buildMimeBuffer", () => {
  test("is the same bytes as the string form", () => {
    const f = fields({ from: "ops@x.com", messageId: "<a@x.com>" });
    assert.equal(buildMimeBuffer(f).toString("utf8"), buildMimeString(f));
  });
});

describe("stripBccHeader", () => {
  const withBcc = (lines: string[]) =>
    Buffer.from(`${lines.join("\r\n")}\r\n\r\nBody text.\r\n`, "utf8");

  test("removes the Bcc header and leaves everything else alone", () => {
    // Gmail strips Bcc on ingest; an SMTP relay sends the bytes verbatim, so
    // leaving it in delivers the blind-copy list to every To and Cc recipient.
    const out = stripBccHeader(
      withBcc(["From: a@x.com", "To: b@y.com", "Bcc: audit@z.com", "Subject: Hi"]),
    ).toString("utf8");
    assert.doesNotMatch(out, /^Bcc:/im);
    assert.doesNotMatch(out, /audit@z\.com/);
    assert.match(out, /^From: a@x\.com$/m);
    assert.match(out, /^To: b@y\.com$/m);
    assert.match(out, /^Subject: Hi$/m);
    assert.match(out, /Body text\./);
  });

  test("removes a Bcc list folded across several lines, all of it", () => {
    const out = stripBccHeader(
      withBcc(["To: b@y.com", "Bcc: one@z.com,", " two@z.com,", "\tthree@z.com", "Subject: Hi"]),
    ).toString("utf8");
    for (const address of ["one@z.com", "two@z.com", "three@z.com"]) {
      assert.doesNotMatch(out, new RegExp(address.replace(".", "\\.")));
    }
    assert.match(out, /^Subject: Hi$/m);
  });

  test("keeps a folded continuation of a header it is not removing", () => {
    const out = stripBccHeader(
      withBcc(["To: b@y.com,", " c@y.com", "Bcc: audit@z.com", "Subject: Hi"]),
    ).toString("utf8");
    assert.match(out, /c@y\.com/);
    assert.doesNotMatch(out, /audit@z\.com/);
  });

  test("matches the header case-insensitively, as senders write it either way", () => {
    const out = stripBccHeader(withBcc(["To: b@y.com", "BCC: audit@z.com"])).toString("utf8");
    assert.doesNotMatch(out, /audit@z\.com/);
  });

  test("does not touch a message that has no Bcc", () => {
    const raw = withBcc(["From: a@x.com", "To: b@y.com", "Subject: Hi"]);
    assert.equal(stripBccHeader(raw).toString("utf8"), raw.toString("utf8"));
  });

  test("leaves a body mentioning bcc alone — only headers are headers", () => {
    const raw = Buffer.from("To: b@y.com\r\n\r\nbcc: not-a-header@z.com\r\n", "utf8");
    assert.match(stripBccHeader(raw).toString("utf8"), /not-a-header@z\.com/);
  });
});

describe("toBase64Url", () => {
  test("emits Gmail's URL-safe alphabet with no padding", () => {
    const encoded = toBase64Url("From: ??>>\r\n\r\nhello~~~");
    assert.doesNotMatch(encoded, /[+/=]/);
    assert.equal(
      Buffer.from(encoded, "base64url").toString("utf8"),
      "From: ??>>\r\n\r\nhello~~~",
    );
  });
});

describe("generateMessageId", () => {
  test("uses the sender's domain, which is what DMARC reporters read", () => {
    assert.match(generateMessageId("ops@acme.example"), /@acme\.example>$/);
  });

  test("is unguessable, so an outsider cannot thread a forgery into a conversation", () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateMessageId("ops@acme.example")));
    assert.equal(seen.size, 50);
  });

  test("falls back to a placeholder domain rather than emitting a malformed header", () => {
    for (const address of ["", "not-an-address", "ops@bad domain"]) {
      assert.match(generateMessageId(address), /^<[^<>]+@[A-Za-z0-9.-]+>$/);
    }
  });
});

describe("formatRfc2822Date", () => {
  test("ends in a numeric offset, not the obsolete GMT", () => {
    // A few strict parsers reject "GMT", which `toUTCString()` emits.
    assert.equal(
      formatRfc2822Date(new Date("2026-02-03T10:00:00Z")),
      "Tue, 03 Feb 2026 10:00:00 +0000",
    );
  });
});
