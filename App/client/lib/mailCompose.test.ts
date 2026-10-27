import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  type ComposeSource,
  forwardBlock,
  forwardSubject,
  MAX_QUOTE_CHARS,
  quotedReply,
  quotedTailStart,
  replyBody,
  replyDraftKey,
  replyRecipientsFor,
  replySubject,
} from "./mailCompose.js";
import { mailHeaders } from "./mailRecipients.js";

const SELF = "me@oneuptime.com";

function message(overrides: Partial<ComposeSource> = {}): ComposeSource {
  return {
    id: "m1",
    fromName: "Felix Menzel",
    fromEmail: "felix.menzel@assense.com",
    toEmails: "Me <me@oneuptime.com>",
    ccEmails: "support@oneuptime.com",
    subject: "Status page not updating",
    sentAt: "2026-10-27T14:04:00.000Z",
    bodyText: "Hi,\nthe status page still shows the old incident.\nThanks",
    snippet: "Hi, the status page…",
    ...overrides,
  };
}

describe("replyRecipientsFor", () => {
  test("Reply goes to the sender alone, with their name", () => {
    const fields = replyRecipientsFor(message(), SELF, false);
    assert.deepEqual(mailHeaders(fields), {
      to: "Felix Menzel <felix.menzel@assense.com>",
      cc: "",
      bcc: "",
    });
  });

  test("Reply all copies everyone else, never the mailbox itself", () => {
    const fields = replyRecipientsFor(
      message({
        toEmails: "Me <ME@oneuptime.com>, Dana <dana@assense.com>",
        ccEmails: "support@oneuptime.com",
      }),
      SELF,
      true,
    );
    assert.deepEqual(mailHeaders(fields), {
      to: "Felix Menzel <felix.menzel@assense.com>",
      cc: "Dana <dana@assense.com>, support@oneuptime.com",
      bcc: "",
    });
  });

  test("answering our own message goes back to the people it was sent to", () => {
    const own = message({
      fromName: "Me",
      fromEmail: "me@oneuptime.com",
      toEmails: "Felix Menzel <felix.menzel@assense.com>",
      ccEmails: "dana@assense.com",
    });
    assert.deepEqual(mailHeaders(replyRecipientsFor(own, SELF, false)), {
      to: "Felix Menzel <felix.menzel@assense.com>",
      cc: "",
      bcc: "",
    });
    assert.deepEqual(mailHeaders(replyRecipientsFor(own, SELF, true)), {
      to: "Felix Menzel <felix.menzel@assense.com>",
      cc: "dana@assense.com",
      bcc: "",
    });
  });

  test("promotes a Cc into To rather than leaving To empty", () => {
    const own = message({
      fromName: "Me",
      fromEmail: "me@oneuptime.com",
      toEmails: "me@oneuptime.com",
      ccEmails: "a@x.test, b@x.test",
    });
    const fields = replyRecipientsFor(own, SELF, true);
    assert.deepEqual(mailHeaders(fields), { to: "a@x.test", cc: "b@x.test", bcc: "" });
  });

  test("the sender is not copied when they were also on the To line", () => {
    const fields = replyRecipientsFor(
      message({ toEmails: "felix.menzel@assense.com, me@oneuptime.com", ccEmails: "" }),
      SELF,
      true,
    );
    assert.deepEqual(mailHeaders(fields), {
      to: "Felix Menzel <felix.menzel@assense.com>",
      cc: "",
      bcc: "",
    });
  });
});

describe("subjects", () => {
  test("Re: and Fwd: are added once", () => {
    assert.equal(replySubject("Pricing"), "Re: Pricing");
    assert.equal(replySubject("RE: Pricing"), "RE: Pricing");
    assert.equal(replySubject(""), "Re: (no subject)");
    assert.equal(forwardSubject("Pricing"), "Fwd: Pricing");
    assert.equal(forwardSubject("Fw: Pricing"), "Fw: Pricing");
    assert.equal(forwardSubject("FWD: Pricing"), "FWD: Pricing");
  });
});

describe("quotedReply", () => {
  test("attributes the quote and puts every line behind >", () => {
    const quote = quotedReply(message(), "en-US");
    const lines = quote.split("\n");
    assert.match(lines[0], /^On .*2026.* Felix Menzel <felix\.menzel@assense\.com> wrote:$/);
    assert.deepEqual(lines.slice(1), [
      "> Hi,",
      "> the status page still shows the old incident.",
      "> Thanks",
    ]);
  });

  test("nests an earlier quote and keeps blank lines tidy", () => {
    const quote = quotedReply(message({ bodyText: "Sure\n\n> earlier line" }), "en-US");
    assert.deepEqual(quote.split("\n").slice(1), ["> Sure", ">", ">> earlier line"]);
  });

  test("falls back to the snippet, and bounds a huge body", () => {
    assert.match(quotedReply(message({ bodyText: "" }), "en-US"), /> Hi, the status page…$/);
    const huge = quotedReply(message({ bodyText: "x".repeat(MAX_QUOTE_CHARS + 500) }), "en-US");
    assert.ok(huge.length < MAX_QUOTE_CHARS + 500);
    assert.match(huge, /\[…\]$/);
  });

  test("without a date it still says who wrote it", () => {
    assert.match(
      quotedReply(message({ sentAt: null }), "en-US"),
      /^Felix Menzel <felix\.menzel@assense\.com> wrote:/,
    );
  });
});

describe("forwardBlock", () => {
  test("carries the original headers and text", () => {
    const block = forwardBlock(message(), "en-US");
    assert.match(
      block,
      /^---------- Forwarded message ----------\nFrom: Felix Menzel <felix\.menzel@assense\.com>\nDate: /,
    );
    assert.match(block, /\nSubject: Status page not updating\n/);
    assert.match(block, /\nTo: Me <me@oneuptime\.com>\nCc: support@oneuptime\.com\n/);
    assert.match(block, /\n\nHi,\nthe status page still shows the old incident\.\nThanks$/);
  });
});

describe("replyBody", () => {
  test("puts the quote under the Member's words", () => {
    assert.equal(replyBody("Thanks!\n\n", "> quoted"), "Thanks!\n\n> quoted");
    assert.equal(replyBody("Thanks!", null), "Thanks!");
    assert.equal(replyBody("   ", "> quoted"), "> quoted");
  });
});

describe("quotedTailStart", () => {
  test("finds an attributed quote at the end", () => {
    const text =
      "Sounds good, see you then.\n\nOn Tue, Oct 27, 2026 at 3:04 PM Felix <f@x.test> wrote:\n> Tuesday 3pm?\n> Felix\n";
    const start = quotedTailStart(text);
    assert.equal(text.slice(0, start).trim(), "Sounds good, see you then.");
    assert.match(text.slice(start), /^On Tue/);
  });

  test("folds an attribution that wrapped onto two lines", () => {
    const text =
      "Yes.\n\nOn Tue, Oct 27, 2026 at 3:04 PM Felix Menzel <\nfelix@x.test> wrote:\n> Tuesday?\n";
    const start = quotedTailStart(text);
    assert.equal(text.slice(0, start).trim(), "Yes.");
  });

  test("finds a bare trailing quote and an Outlook original-message block", () => {
    const bare = "Agreed.\n> earlier\n> more";
    assert.equal(bare.slice(0, quotedTailStart(bare)).trim(), "Agreed.");
    const outlook = "Thanks\n\n-----Original Message-----\nFrom: Felix\nSent: Tuesday";
    assert.equal(outlook.slice(0, quotedTailStart(outlook)).trim(), "Thanks");
  });

  test("leaves alone mail with no tail quote, or nothing but a quote", () => {
    assert.equal(quotedTailStart("Just a note.\nNo quote here."), -1);
    assert.equal(quotedTailStart("> only\n> a quote"), -1);
    assert.equal(quotedTailStart("Inline > is fine\nand then more text"), -1);
    assert.equal(quotedTailStart("> quote first\nthen my answer"), -1);
    assert.equal(quotedTailStart(""), -1);
  });

  test("never folds a forwarded message", () => {
    const forwarded = "FYI\n\n---------- Forwarded message ----------\nFrom: a@x.test\n\nBody";
    assert.equal(quotedTailStart(forwarded), -1);
  });
});

describe("replyDraftKey", () => {
  test("is per company and thread", () => {
    assert.equal(replyDraftKey("c1", "t1"), "genosyn.mail.reply.c1.t1");
    assert.notEqual(replyDraftKey("c1", "t1"), replyDraftKey("c2", "t1"));
  });
});
