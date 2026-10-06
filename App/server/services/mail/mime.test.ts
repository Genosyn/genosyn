import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { simpleParser, type AddressObject } from "mailparser";

import { parseAddressList } from "../../lib/emailAddress.js";
import {
  buildMimeBuffer,
  buildMimeString,
  decodeMimeWords,
  displayNameText,
  formatMailbox,
  formatRfc2822Date,
  generateMessageId,
  refreshFromHeader,
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
        from: { name: "Ops", address: "ops@acme.example" },
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
    const raw = buildMimeString(fields({ from: { address: "ops@acme.example" } }));
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
      fields({ from: { address: "ops@acme.example\r\nBcc: attacker@evil.example" } }),
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
    const f = fields({ from: { address: "ops@x.com" }, messageId: "<a@x.com>" });
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

// ───────────────────────────── the sender's name ─────────────────────────────

/**
 * Names a person can type into the Sender name field, chosen for the ways the
 * header grammar breaks: a comma (a second recipient), a dot and parentheses
 * (specials), quotes and backslashes (escapes), characters outside ASCII
 * (encoded words), and a name that is mostly punctuation.
 */
const AWKWARD_NAMES = [
  "Avery Monroe",
  "Monroe, Avery",
  "A. Monroe (Ops)",
  'Avery "AJ" Monroe',
  "Back\\slash Ops",
  "Ops @ Acme; Inc. <billing>",
  "Zoë Ödegaard",
  "李雷 · 运营",
  "Avery 🚀 Monroe",
  "O'Brien & Partners",
];

/** The `From` a recipient's mail client parses out of the composed bytes. */
async function recipientReadsFrom(raw: string): Promise<{ name: string; address: string }> {
  const parsed = await simpleParser(raw);
  const from = parsed.from as AddressObject | undefined;
  const first = from?.value[0];
  return { name: first?.name ?? "", address: first?.address ?? "" };
}

describe("formatMailbox — the From a recipient sees", () => {
  test("writes the bare address when there is no name, exactly as before", () => {
    // An unset sender name must not change a single byte of what IMAP
    // mailboxes have always sent.
    assert.equal(formatMailbox({ address: "avery@example.com" }), "avery@example.com");
    assert.equal(formatMailbox({ address: "avery@example.com", name: "" }), "avery@example.com");
    assert.equal(
      formatMailbox({ address: "avery@example.com", name: "  \t " }),
      "avery@example.com",
    );
  });

  test("leaves an ordinary name unquoted, the way every mail client writes one", () => {
    assert.equal(
      formatMailbox({ address: "avery@example.com", name: "Avery Monroe" }),
      "Avery Monroe <avery@example.com>",
    );
    assert.equal(
      formatMailbox({ address: "avery@example.com", name: "O'Brien & Partners" }),
      "O'Brien & Partners <avery@example.com>",
    );
  });

  test("quotes a name with a comma, which would otherwise be a second recipient", () => {
    assert.equal(
      formatMailbox({ address: "avery@example.com", name: "Monroe, Avery" }),
      '"Monroe, Avery" <avery@example.com>',
    );
  });

  test("quotes a name holding any other special", () => {
    for (const name of ["A. Monroe", "Ops (EU)", "Ops @ Acme", "Ops: Billing", "a;b", "[Ops]"]) {
      assert.equal(
        formatMailbox({ address: "ops@example.com", name }),
        `"${name}" <ops@example.com>`,
        name,
      );
    }
  });

  test("escapes quotes and backslashes inside the quoted name", () => {
    assert.equal(
      formatMailbox({ address: "avery@example.com", name: 'Avery "AJ" Monroe' }),
      '"Avery \\"AJ\\" Monroe" <avery@example.com>',
    );
    assert.equal(
      formatMailbox({ address: "ops@example.com", name: "Back\\slash" }),
      '"Back\\\\slash" <ops@example.com>',
    );
  });

  test("RFC 2047-encodes a name outside ASCII instead of quoting it", () => {
    // A quoted string may only hold ASCII, and an encoded word inside quotes
    // is not decoded — so quoting a non-ASCII name would show its bytes.
    const header = formatMailbox({ address: "zoe@example.com", name: "Zoë Ödegaard" });
    assert.match(header, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <zoe@example\.com>$/);
    assert.doesNotMatch(header, /"/);
    assert.equal(decodeMimeWords(header.replace(/ <.*$/, "")), "Zoë Ödegaard");
  });

  test("folds a long non-ASCII name into encoded words a strict server accepts", () => {
    const name = "Ödegaard ".repeat(12).trim();
    const header = formatMailbox({ address: "zoe@example.com", name });
    for (const word of header.replace(/ <.*$/, "").split("\r\n ")) {
      assert.match(word, /^=\?UTF-8\?B\?[^?]+\?=$/);
      assert.ok(word.length <= 75, `a ${word.length}-character encoded word breaks RFC 2047`);
    }
    assert.equal(decodeMimeWords(header.replace(/ <.*$/, "").replace(/\r\n /g, " ")), name);
  });

  test("collapses whitespace and trims, so the name is one tidy line", () => {
    assert.equal(
      formatMailbox({ address: "avery@example.com", name: "  Avery \t  Monroe  " }),
      "Avery Monroe <avery@example.com>",
    );
  });

  test("a line break in the name cannot inject a header", () => {
    const raw = buildMimeString(
      fields({
        from: { address: "avery@example.com", name: "Avery\r\nBcc: attacker@evil.example" },
      }),
    );
    assert.doesNotMatch(headerBlock(raw), /^Bcc:/im);
    assert.match(
      headerBlock(raw),
      /^From: "Avery Bcc: attacker@evil\.example" <avery@example\.com>$/m,
    );
  });

  test("writes From first, with the name, on a composed message", () => {
    const raw = buildMimeString(
      fields({ from: { address: "avery@example.com", name: "Avery Monroe" } }),
    );
    assert.ok(headerBlock(raw).startsWith("From: Avery Monroe <avery@example.com>\r\nTo: "));
  });
});

describe("what a recipient's mail client reads back", () => {
  for (const name of AWKWARD_NAMES) {
    test(`"${name}" arrives as exactly that name, beside the right address`, async () => {
      const raw = buildMimeString(
        fields({
          from: { address: "avery@example.com", name },
          date: new Date("2026-02-03T10:00:00Z"),
          messageId: "<id@example.com>",
        }),
      );
      assert.deepEqual(await recipientReadsFrom(raw), { name, address: "avery@example.com" });
    });
  }
});

describe("recipient lists", () => {
  test("keep a quoted name with a comma as one recipient", () => {
    // This used to split on every comma, writing `To: "Doe, John <john@x.com>`
    // — an unterminated quote — for a name the composer let anyone type.
    const raw = buildMimeString(fields({ to: '"Doe, John" <john@x.com>, ada@example.com' }));
    assert.match(headerBlock(raw), /^To: "Doe, John" <john@x\.com>, ada@example\.com$/m);
  });

  test("say the same recipients the SMTP envelope does", () => {
    const typed = '"Doe, John" <john@x.com>, "Avery \\"AJ\\" Monroe" <aj@x.com>, Ada <ada@x.com>';
    const header = /^To: (.*)$/m.exec(headerBlock(buildMimeString(fields({ to: typed }))))?.[1];
    assert.deepEqual(parseAddressList(header).addresses, parseAddressList(typed).addresses);
    assert.deepEqual(parseAddressList(header).invalid, []);
  });

  test("survive a recipient's parser with every name intact", async () => {
    const typed = '"Doe, John" <john@x.com>, "Avery \\"AJ\\" Monroe" <aj@x.com>, Zoë <zoe@x.com>';
    const parsed = await simpleParser(buildMimeString(fields({ to: typed })));
    const to = parsed.to as AddressObject;
    assert.deepEqual(
      to.value.map((entry) => [entry.name, entry.address]),
      [
        ["Doe, John", "john@x.com"],
        ['Avery "AJ" Monroe', "aj@x.com"],
        ["Zoë", "zoe@x.com"],
      ],
    );
  });

  test("still drop needless quotes from a plain name", () => {
    assert.match(
      headerBlock(buildMimeString(fields({ to: '"Ada" <ada@example.com>' }))),
      /^To: Ada <ada@example\.com>$/m,
    );
  });
});

describe("displayNameText", () => {
  test("reads a quoted name back as the text it shows", () => {
    assert.equal(displayNameText('"Doe, John"'), "Doe, John");
    assert.equal(displayNameText('"Avery \\"AJ\\" Monroe"'), 'Avery "AJ" Monroe');
    assert.equal(displayNameText('"Back\\\\slash"'), "Back\\slash");
  });

  test("reads a name that is only partly quoted", () => {
    assert.equal(displayNameText('"Ada" Lovelace'), "Ada Lovelace");
  });

  test("leaves an unquoted name alone, whitespace tidied", () => {
    assert.equal(displayNameText("  Avery   Monroe "), "Avery Monroe");
  });
});

describe("decodeMimeWords", () => {
  test("passes text with no encoded words through untouched", () => {
    assert.equal(decodeMimeWords("Avery Monroe"), "Avery Monroe");
    assert.equal(decodeMimeWords(""), "");
  });

  test("decodes both encodings, in either case", () => {
    assert.equal(decodeMimeWords("=?UTF-8?Q?Jos=C3=A9_Garc=C3=ADa?="), "José García");
    assert.equal(decodeMimeWords("=?utf-8?b?WsO2w6s=?="), "Zöë");
  });

  test("drops the folding between adjacent words but keeps the text around them", () => {
    assert.equal(decodeMimeWords("=?UTF-8?Q?Ave?= \r\n =?UTF-8?Q?ry?="), "Avery");
    assert.equal(
      decodeMimeWords("=?UTF-8?Q?Caf=C3=A9?= and =?UTF-8?Q?cr=C3=A8me?="),
      "Café and crème",
    );
    assert.equal(decodeMimeWords("Re: =?UTF-8?Q?Caf=C3=A9?= order"), "Re: Café order");
  });

  test("joins a character some sender split across two words", () => {
    // "é" is C3 A9 in UTF-8; decoded one word at a time it would be two
    // replacement characters.
    assert.equal(decodeMimeWords("=?UTF-8?B?Y2Fmww==?= =?UTF-8?B?qQ==?="), "café");
  });

  test("decodes the legacy charsets real mail still arrives in", () => {
    assert.equal(decodeMimeWords("=?ISO-8859-1?Q?Andr=E9?="), "André");
    assert.equal(decodeMimeWords("=?windows-1252?Q?=93quoted=94?="), "“quoted”");
  });

  test("reads a charset carrying an RFC 2231 language", () => {
    assert.equal(decodeMimeWords("=?UTF-8*en?Q?Hello?="), "Hello");
  });

  test("leaves a word in a charset it cannot decode exactly as written", () => {
    assert.equal(decodeMimeWords("=?x-no-such-charset?Q?abc?="), "=?x-no-such-charset?Q?abc?=");
  });

  test("undoes what the composer encodes", () => {
    const subject = "Résumé — 履歴書 ".repeat(6).trim();
    const raw = buildMimeString(fields({ subject }));
    const header = /^Subject: (.*(?:\r\n .*)*)$/m.exec(headerBlock(raw))?.[1] ?? "";
    assert.equal(decodeMimeWords(header.replace(/\r\n /g, " ")), subject);
  });
});

describe("refreshFromHeader", () => {
  const AVERY = { address: "avery@example.com", name: "Avery Monroe" };
  const message = (headers: string[], body = "Body text.\r\n") =>
    Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}`, "utf8");

  test("gives a draft written without a name the mailbox's name", () => {
    const out = refreshFromHeader(
      message(["From: avery@example.com", "To: ada@example.com", "Subject: Hi"]),
      AVERY,
    ).toString("utf8");
    assert.equal(
      out,
      "From: Avery Monroe <avery@example.com>\r\nTo: ada@example.com\r\nSubject: Hi\r\n\r\nBody text.\r\n",
    );
  });

  test("replaces a stale name with the current one", () => {
    const out = refreshFromHeader(
      message(['From: "Old, Name" <avery@example.com>', "To: ada@example.com"]),
      AVERY,
    ).toString("utf8");
    assert.match(out, /^From: Avery Monroe <avery@example\.com>\r\n/);
    assert.doesNotMatch(out, /Old/);
  });

  test("drops the name when the mailbox no longer has one", () => {
    const out = refreshFromHeader(
      message(["From: Avery Monroe <avery@example.com>", "To: ada@example.com"]),
      { address: "avery@example.com", name: "" },
    ).toString("utf8");
    assert.match(out, /^From: avery@example\.com\r\nTo: /);
  });

  test("matches the address whatever case the draft wrote it in", () => {
    const out = refreshFromHeader(message(["From: AVERY@Example.COM", "To: a@x.com"]), AVERY);
    assert.match(out.toString("utf8"), /^From: Avery Monroe <avery@example\.com>\r\n/);
  });

  test("replaces a folded From whole, continuation lines included", () => {
    const out = refreshFromHeader(
      message([
        "From: =?UTF-8?B?w5Zk?=",
        " =?UTF-8?B?ZWdhYXJk?= <avery@example.com>",
        "To: ada@example.com",
      ]),
      AVERY,
    ).toString("utf8");
    assert.match(out, /^From: Avery Monroe <avery@example\.com>\r\nTo: ada@example\.com\r\n\r\n/);
  });

  test("writes a name that needs encoding in its encoded form", async () => {
    const out = refreshFromHeader(message(["From: zoe@example.com", "To: a@x.com"]), {
      address: "zoe@example.com",
      name: "Zoë, Ödegaard",
    });
    assert.deepEqual(await recipientReadsFrom(out.toString("utf8")), {
      name: "Zoë, Ödegaard",
      address: "zoe@example.com",
    });
  });

  test("leaves a From another client wrote from an alias untouched", () => {
    // That is somebody's deliberate choice of identity, not a stale copy of ours.
    const raw = message(["From: Avery <avery+news@example.com>", "To: ada@example.com"]);
    assert.equal(refreshFromHeader(raw, AVERY), raw);
  });

  test("leaves a message with no From untouched", () => {
    const raw = message(["To: ada@example.com", "Subject: Hi"]);
    assert.equal(refreshFromHeader(raw, AVERY), raw);
  });

  test("touches only From — never Sender, Reply-To, or the body", () => {
    const out = refreshFromHeader(
      message(
        ["From: avery@example.com", "Sender: avery@example.com", "Reply-To: avery@example.com"],
        "From: avery@example.com\r\nquoted in the body\r\n",
      ),
      AVERY,
    ).toString("utf8");
    assert.match(out, /^Sender: avery@example\.com$/m);
    assert.match(out, /^Reply-To: avery@example\.com$/m);
    assert.ok(out.endsWith("\r\n\r\nFrom: avery@example.com\r\nquoted in the body\r\n"));
  });

  test("carries a legacy 8-bit header through byte for byte", () => {
    const raw = Buffer.concat([
      Buffer.from("From: avery@example.com\r\nX-Legacy: caf", "latin1"),
      Buffer.from([0xe9]),
      Buffer.from("\r\nTo: a@x.com\r\n\r\nBody\r\n", "latin1"),
    ]);
    const out = refreshFromHeader(raw, AVERY);
    const legacy = Buffer.concat([Buffer.from("X-Legacy: caf", "latin1"), Buffer.from([0xe9])]);
    assert.ok(out.includes(legacy), "the 0xE9 byte must survive the rewrite unchanged");
    assert.ok(out.subarray(0, 40).toString("latin1").startsWith("From: Avery Monroe <"));
  });

  test("a name cannot inject a header through the restamp", () => {
    const out = refreshFromHeader(message(["From: avery@example.com", "To: a@x.com"]), {
      address: "avery@example.com",
      name: "Avery\r\nBcc: attacker@evil.example",
    }).toString("utf8");
    assert.doesNotMatch(headerBlock(out), /^Bcc:/im);
  });

  test("returns a message with no header block as it was", () => {
    const raw = Buffer.from("not a message", "utf8");
    assert.equal(refreshFromHeader(raw, AVERY), raw);
  });
});
