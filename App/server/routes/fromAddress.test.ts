import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { fromAddressSchema } from "./emailProviders.js";

/**
 * The From address a company configures is written into the SMTP dialogue.
 *
 * `z.string().min(3).max(254)` accepted a newline, and a newline here is
 * header injection: the author appends `Bcc:` and gets a silent copy of every
 * transactional email the company sends, or terminates the headers and writes
 * their own body. It also accepted values that are not addresses at all, which
 * previously surfaced only as a provider error at send time.
 *
 * The two refinements are not redundant. `normalizeEmail` validates the
 * *extracted* address, so for `Display Name <a@b.com>` it never inspects the
 * display name — a newline hiding there would survive it. The control
 * character check is what catches that, and the test below pins it.
 */

const ok = (value: string) => fromAddressSchema.safeParse(value).success;
const why = (value: string) =>
  fromAddressSchema
    .safeParse(value)
    .error?.issues.map((i) => i.message)
    .join(" ") ?? "";

describe("accepts the shapes real installs use", () => {
  const accepted = [
    "no-reply@example.com",
    "No Reply <no-reply@example.com>",
    '"Reply, No" <no-reply@example.com>',
    "<no-reply@example.com>",
    "billing+invoices@sub.example.co.uk",
    "  no-reply@example.com  ",
    "NoReply@Example.COM",
  ];
  for (const value of accepted) {
    test(JSON.stringify(value), () => {
      assert.equal(ok(value), true, why(value));
    });
  }
});

describe("refuses header injection", () => {
  const injections: Array<[string, string]> = [
    ["CRLF then a Bcc header", "a@b.com\r\nBcc: victim@example.com"],
    ["bare LF then a Bcc header", "a@b.com\nBcc: victim@example.com"],
    ["a trailing CR", "a@b.com\r"],
    ["a trailing LF", "a@b.com\n"],
    ["a leading CRLF", "\r\na@b.com"],
    ["a NUL byte", `a@b.com${String.fromCharCode(0)}`],
    ["an ANSI escape", `a@b.com${String.fromCharCode(27)}[31m`],
    ["a DEL byte", `a@b.com${String.fromCharCode(127)}`],
    ["a vertical tab", `a@b.com${String.fromCharCode(11)}`],
    ["a tab", "a@b.com\t"],
  ];
  for (const [label, value] of injections) {
    test(label, () => {
      assert.equal(ok(value), false, `${JSON.stringify(value)} should have been refused`);
      assert.match(why(value), /line breaks or control characters/);
    });
  }

  test("a newline inside the display name is refused, not merely ignored", () => {
    // The bracketed address parses fine on its own, so `normalizeEmail` would
    // accept this. Only the control-character check catches it — which is the
    // whole reason both refinements exist.
    const value = "Acme\r\nBcc: victim@example.com <no-reply@acme.com>";
    assert.equal(ok(value), false);
    assert.match(why(value), /line breaks or control characters/);
  });

  test("the address half of that value would otherwise have passed", () => {
    // Pins the premise of the test above: without the display name, it is fine.
    assert.equal(ok("Acme <no-reply@acme.com>"), true);
  });
});

describe("refuses things that are not addresses", () => {
  const rejected = [
    "not-an-address",
    "@example.com",
    "a@",
    "a@b",
    "a b@example.com",
    "a@b.com, c@d.com",
    "a@b.com; c@d.com",
    "Unbalanced <a@b.com",
    "Unbalanced a@b.com>",
    "a..b@example.com",
    "a.@example.com",
    ".a@example.com",
    "a@-example.com",
    "a@example-.com",
  ];
  for (const value of rejected) {
    test(JSON.stringify(value), () => {
      assert.equal(ok(value), false, "should have been refused");
    });
  }
});

describe("length bounds still apply", () => {
  test("too short", () => {
    assert.equal(ok("a"), false);
  });

  test("too long", () => {
    assert.equal(ok(`${"a".repeat(250)}@example.com`), false);
  });

  test("a long but legal address is fine", () => {
    assert.equal(ok(`${"a".repeat(60)}@example.com`), true);
  });
});

describe("the message is actionable", () => {
  test("a non-address says what the shape should be", () => {
    assert.match(why("not-an-address"), /Name <you@example\.com>/);
  });
});
