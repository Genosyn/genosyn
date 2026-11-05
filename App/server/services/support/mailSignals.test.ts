import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  bareSubject,
  classifyAutomatedMail,
  cleanEmailText,
  deliveryAddresses,
  matchWatchedAddress,
  plainTextToHtml,
  resolveRequester,
} from "./mailSignals.js";

const h = (name: string, value: string) => ({ name, value });

describe("which address a message reached", () => {
  test("reads To, Cc, Bcc and the delivery headers", () => {
    const delivered = deliveryAddresses({
      to: "Team <team@acme.com>",
      cc: "ada@customer.com",
      bcc: "",
      headers: [h("Delivered-To", "support@acme.com"), h("X-Original-To", "help@acme.com")],
    });
    assert.deepEqual(delivered.sort(), [
      "ada@customer.com",
      "help@acme.com",
      "support@acme.com",
      "team@acme.com",
    ]);
  });

  test("matches regardless of case and plus-tags, and finds nothing otherwise", () => {
    assert.equal(
      matchWatchedAddress(["support@acme.com"], ["SUPPORT+vip@ACME.com"]),
      "support@acme.com",
    );
    assert.equal(matchWatchedAddress(["support@acme.com"], ["sales@acme.com"]), null);
  });

  test("a group's List-Post counts as where it was written to", () => {
    const delivered = deliveryAddresses({
      to: "me@acme.com",
      cc: "",
      bcc: "",
      headers: [h("List-Post", "<mailto:support@acme.com>")],
    });
    assert.ok(delivered.includes("support@acme.com"));
  });
});

describe("mail no person wrote", () => {
  const person = { fromEmail: "ada@customer.com", subject: "Can't sign in", headers: [] };

  test("a person's email is left alone", () => {
    assert.equal(classifyAutomatedMail(person), null);
  });

  test("delivery reports are bounces", () => {
    assert.equal(
      classifyAutomatedMail({ ...person, fromEmail: "MAILER-DAEMON@mx.google.com" })?.kind,
      "bounce",
    );
    assert.equal(
      classifyAutomatedMail({ ...person, subject: "Undeliverable: your reply" })?.kind,
      "bounce",
    );
    assert.equal(
      classifyAutomatedMail({
        ...person,
        headers: [h("Content-Type", 'multipart/report; report-type="delivery-status"')],
      })?.kind,
      "bounce",
    );
  });

  test("auto-replies are caught by header and by subject, in several languages", () => {
    assert.equal(
      classifyAutomatedMail({ ...person, headers: [h("Auto-Submitted", "auto-replied")] })?.kind,
      "auto_reply",
    );
    assert.equal(classifyAutomatedMail({ ...person, headers: [h("Auto-Submitted", "no")] }), null);
    for (const subject of [
      "Out of office",
      "Automatic reply: Your ticket",
      "Re: Abwesenheit bis Montag",
      "Réponse automatique : absent",
    ]) {
      assert.equal(classifyAutomatedMail({ ...person, subject })?.kind, "auto_reply", subject);
    }
  });

  test("mailing lists and no-reply senders are bulk", () => {
    assert.equal(
      classifyAutomatedMail({ ...person, headers: [h("List-Unsubscribe", "<https://x>")] })?.kind,
      "bulk",
    );
    assert.equal(
      classifyAutomatedMail({ ...person, fromEmail: "no-reply@stripe.com" })?.kind,
      "bulk",
    );
    assert.equal(
      classifyAutomatedMail({
        ...person,
        fromEmail: "no-reply@forms.io",
        headers: [h("Reply-To", "ada@customer.com")],
      }),
      null,
      "a form relaying a customer gives a way to answer",
    );
  });

  test("the company's own Google Group forwarding a customer is not a mailing list", () => {
    const group = [
      h("List-Id", "<support.acme.com>"),
      h("Precedence", "list"),
      h("List-Unsubscribe", "<mailto:support+unsubscribe@acme.com>"),
    ];
    assert.equal(
      classifyAutomatedMail({ ...person, headers: group, ownAddresses: ["support@acme.com"] }),
      null,
    );
    assert.equal(classifyAutomatedMail({ ...person, headers: group })?.kind, "bulk");
  });

  test("a group on the company's domain counts even when the mailbox watches everything", () => {
    const group = [h("List-Id", "Support <support.acme.com>"), h("Precedence", "list")];
    assert.equal(
      classifyAutomatedMail({ ...person, headers: group, ownAddresses: ["sam@acme.com"] }),
      null,
    );
  });

  test("a newsletter on another domain is bulk whoever is watching", () => {
    const list = [h("List-Id", "<news.vendor.io>"), h("List-Post", "<mailto:news@vendor.io>")];
    assert.equal(
      classifyAutomatedMail({ ...person, headers: list, ownAddresses: ["support@acme.com"] })?.kind,
      "bulk",
    );
  });
});

describe("who gets the answer", () => {
  const own = ["support@acme.com"];

  test("the sender, or their Reply-To", () => {
    assert.deepEqual(
      resolveRequester({
        fromName: "Ada",
        fromEmail: "Ada@Customer.com",
        headers: [],
        ownAddresses: own,
      }),
      { email: "ada@customer.com", name: "Ada" },
    );
    assert.deepEqual(
      resolveRequester({
        fromName: "Web form",
        fromEmail: "forms@tools.io",
        headers: [h("Reply-To", "Grace <grace@customer.com>")],
        ownAddresses: own,
      }),
      { email: "grace@customer.com", name: "Web form" },
    );
  });

  test("a NUL byte in a header's name never reaches the database", () => {
    const requester = resolveRequester({
      fromName: "Support",
      fromEmail: "support@acme.com",
      headers: [h("X-Original-From", "Ada\u0000 Lovelace <ada@customer.com>")],
      ownAddresses: ["support@acme.com"],
    });
    assert.equal(requester?.name, "Ada Lovelace");
  });

  test("a group that rewrote From to itself still leads to the customer", () => {
    assert.deepEqual(
      resolveRequester({
        fromName: "Ada Lovelace via Support",
        fromEmail: "support@acme.com",
        headers: [h("X-Original-From", "Ada Lovelace <ada@customer.com>")],
        ownAddresses: own,
      }),
      { email: "ada@customer.com", name: "Ada Lovelace" },
    );
  });

  test("mail the company sent itself has no requester", () => {
    assert.equal(
      resolveRequester({
        fromName: "",
        fromEmail: "support@acme.com",
        headers: [],
        ownAddresses: own,
      }),
      null,
    );
  });
});

describe("the new words of an email", () => {
  test("cuts Gmail's quoted history, wrapped header included", () => {
    const body = [
      "Thanks, that worked!",
      "",
      "On Mon, 3 Nov 2026 at 10:12, Support Team <support@acme.com>",
      "wrote:",
      "> Please try resetting it.",
      "> Best, Sam",
    ].join("\n");
    assert.equal(cleanEmailText(body), "Thanks, that worked!");
  });

  test("cuts Outlook's reply block and the separator above it", () => {
    const body = [
      "It still fails.",
      "",
      "________________________________",
      "From: Support <support@acme.com>",
      "Sent: Monday, November 3, 2026 10:12 AM",
      "To: Ada",
      "Subject: RE: Sign in",
      "",
      "Please try again.",
    ].join("\n");
    assert.equal(cleanEmailText(body), "It still fails.");
  });

  test("handles other languages and CRLF", () => {
    assert.equal(
      cleanEmailText("Merci !\r\n\r\nLe 3 nov. 2026 à 10:12, Support a écrit :\r\n> Bonjour"),
      "Merci !",
    );
    assert.equal(
      cleanEmailText("Danke\n\nAm 03.11.2026 um 10:12 schrieb Support:\n> Hallo"),
      "Danke",
    );
  });

  test("cuts the sign-off", () => {
    assert.equal(cleanEmailText("It works.\n\n-- \nAda\nAcme"), "It works.");
    assert.equal(cleanEmailText("It works.\n\nSent from my iPhone"), "It works.");
  });

  test("an answer written between quoted lines is kept", () => {
    const body = "> Which browser?\nChrome.\n> Which version?\n132.";
    assert.equal(cleanEmailText(body), body);
  });

  test("a sentence that merely mentions writing is kept", () => {
    const body = "On Monday my colleague wrote: it fails for her too.";
    assert.equal(cleanEmailText(body), body);
  });

  test("never empties a message that is all quote", () => {
    const body = "On Mon, Sam wrote:\n> hello";
    assert.equal(cleanEmailText(body), body);
  });
});

describe("small helpers", () => {
  test("bareSubject takes every reply and forward prefix off", () => {
    assert.equal(bareSubject("Re: FW: AW: Can't sign in"), "Can't sign in");
  });

  test("plainTextToHtml escapes everything and links only real URLs", () => {
    const html = plainTextToHtml("Try <b>this</b>:\nhttps://acme.com/help?a=1&b=2.\n\nThanks");
    assert.ok(html.includes("&lt;b&gt;this&lt;/b&gt;"));
    assert.ok(html.includes('<a href="https://acme.com/help?a=1&amp;b=2">'));
    assert.ok(html.includes("<br>"));
    assert.equal((html.match(/<p /g) ?? []).length, 2);
  });
});
