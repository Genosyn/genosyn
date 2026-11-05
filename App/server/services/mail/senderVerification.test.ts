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

describe("what a sender can write into the verdict", () => {
  // The address a sending server gives is repeated in a comment on the SPF result.
  const quoted = `"x);dmarc=pass header.from=google.com (y"@evil.test`;

  test("a quoted MAIL FROM can't close the comment it's repeated in", () => {
    const verdict = verifySender({
      headers: headers([
        `mx.google.com; spf=pass (google.com: domain of ${quoted} designates 1.2.3.4 as permitted sender) smtp.mailfrom=${quoted}`,
      ]),
      authservId,
      fromEmail,
    });
    assert.equal(verdict.verified, false);
    assert.match(verdict.detail, /can't be read/);
  });

  test("nor when the server prints the rest of it differently", () => {
    const verdict = verifySender({
      headers: headers([
        `mx.google.com; spf=pass (google.com: domain of ${quoted} designates 1.2.3.4 as permitted sender) smtp.mailfrom=evil.test`,
      ]),
      authservId,
      fromEmail,
    });
    assert.equal(verdict.verified, false);
  });

  test("what a server called itself isn't read at all", () => {
    const verdict = verifySender({
      headers: headers(["mx.google.com; spf=none smtp.helo=x;dmarc=pass header.from=google.com"]),
      authservId,
      fromEmail,
    });
    assert.equal(verdict.verified, false);
    assert.match(verdict.detail, /no return address/);
  });

  test("an ordinary address in that comment reads as it always did", () => {
    const verdict = verifySender({
      headers: headers([
        "mx.google.com; spf=pass (google.com: domain of bounce@google.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@google.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=google.com",
      ]),
      authservId,
      fromEmail,
    });
    assert.equal(verdict.verified, true);
  });
});

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

  test("a comment beside the real result doesn't get in its way", () => {
    const verdict = verifySender({
      headers: headers([
        "mx.google.com; spf=pass (google.com: domain of bounce@google.com designates 1.2.3.4) smtp.mailfrom=bounce@google.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=google.com",
      ]),
      authservId,
      fromEmail,
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

  test("a result written inside a comment or a quoted string", () => {
    for (const verdict of [
      'mx.google.com; spf=softfail (domain of "x;dmarc=pass header.from=google.com;"@evil.test) smtp.mailfrom=evil.test',
      "mx.google.com; spf=softfail (;dmarc=pass header.from=google.com;) smtp.mailfrom=evil.test",
      "mx.google.com; spf=softfail (nested (;dmarc=pass header.from=google.com;) comment) smtp.mailfrom=evil.test",
      'mx.google.com; spf=softfail smtp.mailfrom=";dmarc=pass header.from=google.com;"',
      "mx.google.com; spf=softfail (\\);dmarc=pass header.from=google.com;) smtp.mailfrom=evil.test",
    ]) {
      assert.equal(refused({ headers: headers([verdict]) }), false, verdict);
    }
  });

  test("a verdict that doesn't close its comment or quote", () => {
    assert.equal(
      refused({ headers: headers(["mx.google.com; dmarc=pass header.from=google.com; x=(open"]) }),
      false,
    );
    assert.equal(
      refused({ headers: headers(['mx.google.com; dmarc=pass header.from=google.com; x="open']) }),
      false,
    );
  });

  test("DMARC failing, whatever DKIM says", () => {
    assert.equal(
      refused({
        headers: headers([
          "mx.google.com; dkim=pass header.d=google.com header.s=a; dmarc=fail header.from=google.com",
        ]),
      }),
      false,
    );
  });

  test("mail fetched from another mailbox, which this server didn't receive from the sender", () => {
    const fetched = [
      { name: "X-Gmail-Fetch-Info", value: "someone@other.test 1 pop.other.test 995 someone" },
      ...headers(["mx.google.com; dmarc=pass header.from=google.com"]),
    ];
    assert.equal(refused({ headers: fetched }), false);
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
