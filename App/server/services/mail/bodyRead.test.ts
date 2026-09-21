import assert from "node:assert/strict";
import { test } from "node:test";
import { readMailBody } from "./bodyRead.js";

test("reply excerpts report omitted history and allow exact original recovery", () => {
  const body = `Please proceed.\n\nOn Monday, Pat wrote:\n${"old history\n".repeat(2_000)}`;
  const reply = readMailBody(body);
  assert.equal(reply.bodyText, "Please proceed.");
  assert.equal(reply.bodyCoverage.quotedHistoryOmitted, true);
  assert.equal(reply.bodyCoverage.complete, false);
  let recovered = "";
  let offset: number | null = 0;
  while (offset !== null) {
    const page = readMailBody(body, {
      includeQuoted: true,
      bodyOffset: offset,
      maxBodyChars: 1_000,
    });
    recovered += page.bodyText;
    offset = page.bodyCoverage.nextOffset;
  }
  assert.equal(recovered, body);
});

test("default and maximum body budgets bound long unquoted messages", () => {
  const body = "x".repeat(30_000);
  assert.equal(readMailBody(body).bodyText.length, 4_000);
  assert.equal(readMailBody(body).bodyCoverage.nextOffset, 4_000);
  assert.equal(readMailBody(body, { maxBodyChars: 30_000 }).bodyText.length, 20_000);
  assert.equal(readMailBody(body, { bodyOffset: 40_000 }).bodyCoverage.nextOffset, null);
});

test("keeps inline answers and ordinary From prose while removing quote-prefixed lines", () => {
  const body =
    "From: our planning notes\n> Old question?\nOur answer.\n> Another question\nSecond answer.";
  assert.equal(
    readMailBody(body).bodyText,
    "From: our planning notes\nOur answer.\nSecond answer.",
  );
});

test("recognizes Outlook and forwarded separators", () => {
  for (const boundary of [
    "-----Original Message-----",
    "---------- Forwarded message ---------",
    "Begin forwarded message:",
    "From: Pat\nSent: Monday\nTo: Alex",
  ]) {
    const result = readMailBody(`New reply\n${boundary}\nEarlier mail`);
    assert.equal(result.bodyText, "New reply");
    assert.equal(result.bodyCoverage.quotedHistoryOmitted, true);
  }
});

test("a snippet never claims complete body coverage", () => {
  const result = readMailBody("Only a preview", { sourceComplete: false });
  assert.equal(result.bodyCoverage.hasMore, false);
  assert.equal(result.bodyCoverage.complete, false);
  assert.equal(result.bodyCoverage.sourceComplete, false);
  assert.match(result.bodyCoverage.note ?? "", /not full message coverage/);
});
