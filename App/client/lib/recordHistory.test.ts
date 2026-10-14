import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  describeHistoryAction,
  formatHistoryValue,
  historyDayLabel,
  humanizeKey,
} from "./recordHistory.js";

describe("describeHistoryAction", () => {
  test("words a record's own actions without the namespace or its type", () => {
    assert.equal(describeHistoryAction("finance.invoice.create", "invoice", "this invoice"), "created this invoice");
    assert.equal(describeHistoryAction("invoice.email.resend", "invoice", "this invoice"), "resent the email");
    assert.equal(describeHistoryAction("finance.invoice.payment", "invoice", "this invoice"), "recorded a payment");
    assert.equal(
      describeHistoryAction("finance.invoice.write_off_reversed", "invoice", "this invoice"),
      "reversed a write-off",
    );
    assert.equal(describeHistoryAction("routine.update", "routine", "this routine"), "updated this routine");
  });

  test("reads a signature request's rows the same in either spelling", () => {
    const say = (action: string) =>
      describeHistoryAction(action, "signature_envelope", "this request");
    assert.equal(say("signature_envelope.create"), "created this request");
    assert.equal(say("signature_envelope.send"), "sent this request");
    assert.equal(say("signature_envelope.void"), "voided this request");
    assert.equal(say("signature_envelope.reminder.send"), "sent a reminder");
    // The AI Employee signing tools' own rows, written before the service
    // recorded every envelope action.
    assert.equal(say("signature.envelope.create"), "created this request");
    assert.equal(say("signature.envelope.send"), "sent this request");
    assert.equal(say("signature.envelope.void"), "voided this request");
  });

  test("falls back to readable words, never the dotted name", () => {
    assert.equal(describeHistoryAction("deal.contact.link", "deal", "this deal"), "linked contact");
    assert.equal(describeHistoryAction("deal.something_new", "deal", "this deal"), "something new");
  });
});

describe("history values", () => {
  test("humanizes keys and formats cents as money", () => {
    assert.equal(humanizeKey("amountCents"), "amount");
    assert.equal(humanizeKey("toAddress"), "to address");
    assert.equal(formatHistoryValue("amountCents", 5000), "50.00");
    assert.equal(formatHistoryValue("pdfAttached", true), "yes");
  });

  test("groups under Today and Yesterday", () => {
    const now = new Date("2026-10-13T15:00:00").getTime();
    assert.equal(historyDayLabel(new Date("2026-10-13T09:00:00").toISOString(), now), "Today");
    assert.equal(historyDayLabel(new Date("2026-10-12T22:00:00").toISOString(), now), "Yesterday");
  });
});
