import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readAttachments, releaseAttachments, stageAttachment } from "./outbox.js";

/**
 * The staging area a compose flow uploads into before it has a message to
 * attach the files to.
 *
 * The invariant worth guarding is that reading does not consume. Composing can
 * fail after the files are resolved — an expired credential, a mail server
 * that refuses the send — and a person retrying a failed send must not find
 * their attachments gone.
 */

let counter = 0;
function account(): string {
  counter += 1;
  return `acct-${counter}`;
}

function stage(accountId: string, filename: string, body = "bytes"): string {
  return stageAttachment({
    accountId,
    filename,
    mimeType: "application/pdf",
    content: Buffer.from(body),
  }).id;
}

describe("staging a file", () => {
  test("reports what the compose form needs to show", () => {
    const info = stageAttachment({
      accountId: account(),
      filename: "quote.pdf",
      mimeType: "application/pdf",
      content: Buffer.from("%PDF-1.7"),
    });
    assert.equal(info.filename, "quote.pdf");
    assert.equal(info.mimeType, "application/pdf");
    assert.equal(info.size, 8);
    assert.ok(info.id);
  });

  test("names an unnamed file rather than staging a blank row", () => {
    const info = stageAttachment({
      accountId: account(),
      filename: "",
      mimeType: "",
      content: Buffer.from("x"),
    });
    assert.equal(info.filename, "attachment");
    assert.equal(info.mimeType, "application/octet-stream");
  });

  test("refuses once the account's staged bytes pass the cap", () => {
    // A stuck tab uploading in a loop must not be able to grow the heap
    // without limit.
    const id = account();
    stageAttachment({
      accountId: id,
      filename: "big.bin",
      mimeType: "application/octet-stream",
      content: Buffer.alloc(25 * 1024 * 1024),
    });
    assert.throws(
      () =>
        stageAttachment({
          accountId: id,
          filename: "one-more.bin",
          mimeType: "application/octet-stream",
          content: Buffer.alloc(1024),
        }),
      /staging limit/i,
    );
  });
});

describe("reading staged files", () => {
  test("returns the bytes in the order asked for", () => {
    const id = account();
    const a = stage(id, "a.pdf", "AAA");
    const b = stage(id, "b.pdf", "BBB");
    assert.deepEqual(
      readAttachments(id, [b, a]).map((f) => [f.filename, f.content.toString()]),
      [
        ["b.pdf", "BBB"],
        ["a.pdf", "AAA"],
      ],
    );
  });

  test("leaves the files staged, so a failed send can be retried", () => {
    // This is the whole point of separating read from release: a credential
    // that expired between composing and sending must not cost the person
    // their attachments.
    const id = account();
    const token = stage(id, "quote.pdf");
    assert.equal(readAttachments(id, [token]).length, 1);
    assert.equal(readAttachments(id, [token]).length, 1, "still there for the retry");
  });

  test("skips a token from another account rather than serving its bytes", () => {
    const mine = account();
    const theirs = account();
    const token = stage(theirs, "secret.pdf");
    assert.deepEqual(readAttachments(mine, [token]), []);
  });

  test("skips an unknown or expired token instead of throwing", () => {
    // A dropped token means one missing file, which the person can see and
    // fix. A crash means a lost message.
    assert.deepEqual(readAttachments(account(), ["no-such-token"]), []);
  });
});

describe("releasing staged files", () => {
  test("forgets the files once the message has actually left", () => {
    const id = account();
    const token = stage(id, "quote.pdf");
    releaseAttachments(id, [token]);
    assert.deepEqual(readAttachments(id, [token]), []);
  });

  test("cannot be used to clear another account's staging area", () => {
    const mine = account();
    const theirs = account();
    const token = stage(theirs, "quote.pdf");
    releaseAttachments(mine, [token]);
    assert.equal(readAttachments(theirs, [token]).length, 1);
  });

  test("ignores a token it does not know", () => {
    releaseAttachments(account(), ["no-such-token"]);
  });
});
