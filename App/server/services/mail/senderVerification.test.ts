import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { verifySender } from "./senderVerification.js";

/**
 * This decides whether an email-started session may use an AI Employee's full
 * tools, so each way a stranger could fake it is pinned as a no.
 */

const authservId = "mx.google.com";
const fromEmail = "no-reply@google.com";

function headers(results: string[], from = `Google Play <${fromEmail}>`) {
  return [
    ...results.map((value) => ({ name: "Authentication-Results", value })),
    { name: "From", value: from },
  ];
}

describe("a sender that verifies", () => {
  test("DMARC passing for the From domain, from the mailbox's own server", () => {
    const verdict = verifySender({
      headers: headers([
        "mx.google.com; dkim=pass header.i=@google.com header.s=20230601 header.b=abcdef; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=google.com",
      ]),
      authservId,
      fromEmail,
    });
    assert.deepEqual(verdict, { verified: true, how: "dmarc", detail: fromEmail });
  });

  test("a passing DKIM signature from that domain", () => {
    const verdict = verifySender({
      headers: headers(["mx.google.com; dkim=pass header.i=@google.com header.s=a header.b=abcdef"]),
      authservId,
      fromEmail,
    });
    assert.equal(verdict.verified, true);
    assert.equal(verdict.how, "dkim");
  });

  test("a passing DKIM signature from a parent of the From domain", () => {
    const verdict = verifySender({
      headers: headers(
        ["mx.google.com; dkim=pass header.d=example.com header.s=a header.b=abcdef"],
        "billing@mail.example.com",
      ),
      authservId,
      fromEmail: "billing@mail.example.com",
    });
    assert.equal(verdict.verified, true);
  });

  test("a display name holding an address doesn't confuse it", () => {
    const verdict = verifySender({
      headers: headers(
        ["mx.google.com; dmarc=pass header.from=google.com"],
        `"attacker@evil.test, friend" <${fromEmail}>`,
      ),
      authservId,
      fromEmail,
    });
    assert.equal(verdict.verified, true);
  });
});

describe("a sender that doesn't verify", () => {
  const refused = (args: Partial<Parameters<typeof verifySender>[0]>) =>
    verifySender({
      headers: headers(["mx.google.com; dmarc=pass header.from=google.com"]),
      authservId,
      fromEmail,
      ...args,
    }).verified;

  test("no receiving server to believe, as on an IMAP mailbox", () => {
    assert.equal(refused({ authservId: "" }), false);
  });

  test("a forged verdict below the real one", () => {
    const verdict = verifySender({
      headers: headers([
        "mx.google.com; spf=fail smtp.mailfrom=evil.test; dmarc=fail header.from=google.com",
        "mx.google.com; dmarc=pass header.from=google.com",
      ]),
      authservId,
      fromEmail,
    });
    assert.equal(verdict.verified, false);
  });

  test("a verdict written by some other server", () => {
    assert.equal(
      refused({ headers: headers(["mail.evil.test; dmarc=pass header.from=google.com"]) }),
      false,
    );
  });

  test("a forged verdict naming the right server, when the real one is first and silent", () => {
    assert.equal(
      refused({
        headers: headers(["mx.google.com; none", "mx.google.com; dmarc=pass header.from=google.com"]),
      }),
      false,
    );
  });

  test("DMARC passing for some other domain", () => {
    assert.equal(
      refused({ headers: headers(["mx.google.com; dmarc=pass header.from=evil.test"]) }),
      false,
    );
  });

  test("DKIM from an unrelated domain, or a mere suffix of the From domain", () => {
    assert.equal(
      refused({
        headers: headers(["mx.google.com; dkim=pass header.d=evil.test header.s=a header.b=abcdef"]),
      }),
      false,
    );
    assert.equal(
      refused({
        headers: headers(["mx.google.com; dkim=pass header.d=gle.com header.s=a header.b=abcdef"]),
      }),
      false,
    );
    assert.equal(
      refused({
        headers: headers(["mx.google.com; dkim=pass header.d=com header.s=a header.b=abcdef"]),
      }),
      false,
    );
  });

  test("a failed check", () => {
    assert.equal(
      refused({ headers: headers(["mx.google.com; dmarc=fail header.from=google.com"]) }),
      false,
    );
    assert.equal(
      refused({
        headers: headers(["mx.google.com; dkim=fail header.i=@google.com header.s=a header.b=abcdef"]),
      }),
      false,
    );
  });

  test("no verdict at all", () => {
    assert.equal(refused({ headers: [{ name: "From", value: fromEmail }] }), false);
  });

  test("two From headers, or a From line that isn't the address we recorded", () => {
    assert.equal(
      refused({
        headers: [
          { name: "Authentication-Results", value: "mx.google.com; dmarc=pass header.from=google.com" },
          { name: "From", value: fromEmail },
          { name: "From", value: "someone@evil.test" },
        ],
      }),
      false,
    );
    assert.equal(
      refused({
        headers: headers(["mx.google.com; dmarc=pass header.from=google.com"], "other@google.com"),
      }),
      false,
    );
    assert.equal(
      refused({
        headers: headers(
          ["mx.google.com; dmarc=pass header.from=google.com"],
          `${fromEmail}, someone@evil.test`,
        ),
      }),
      false,
    );
  });
});
