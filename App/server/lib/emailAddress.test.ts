import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  emailDomain,
  isRoleAddress,
  normalizeEmail,
  parseAddressList,
} from "./emailAddress.js";

// ──────────────────────────── normalizeEmail ────────────────────────────

describe("normalizeEmail", () => {
  test("lowercases and trims a bare address", () => {
    assert.equal(normalizeEmail("  A.User@Example.COM "), "a.user@example.com");
  });

  test("extracts the address from a display-name header", () => {
    assert.equal(normalizeEmail("Foo Bar <Foo@Example.com>"), "foo@example.com");
    assert.equal(normalizeEmail("<foo@example.com>"), "foo@example.com");
  });

  test("takes the LAST bracketed group, so brackets in a display name do not win", () => {
    assert.equal(
      normalizeEmail("Weird <not-an-address> Name <real@example.com>"),
      "real@example.com",
    );
  });

  test("handles a quoted display name containing a comma", () => {
    assert.equal(normalizeEmail('"Bar, Foo" <foo@example.com>'), "foo@example.com");
  });

  test("rejects an unbalanced bracket instead of repairing it", () => {
    // Repairing here would mean guessing which half is the address, and a
    // guessed address bounces.
    assert.equal(normalizeEmail("Foo <foo@example.com"), null);
    assert.equal(normalizeEmail("foo@example.com>"), null);
  });

  test("rejects non-strings, empty, and whitespace", () => {
    assert.equal(normalizeEmail(null), null);
    assert.equal(normalizeEmail(undefined), null);
    assert.equal(normalizeEmail(""), null);
    assert.equal(normalizeEmail("   "), null);
    assert.equal(normalizeEmail(42 as unknown as string), null);
  });

  test("rejects structurally invalid addresses", () => {
    for (const bad of [
      "no-at-sign",
      "@example.com",
      "foo@",
      "foo@bar",           // no dot in the domain
      "foo@bar.",
      "foo@.com",
      "foo bar@example.com", // whitespace in the local part
      "foo@exa mple.com",
      "foo@@example.com",
      "foo@example..com",
      "foo@-example.com",
      "foo@example-.com",
      "foo@example.c",      // one-letter TLD
      ".foo@example.com",   // leading dot in local part
      "foo.@example.com",
      "fo..o@example.com",
      "foo,bar@example.com",
      "foo;bar@example.com",
    ]) {
      assert.equal(normalizeEmail(bad), null, `expected ${bad} to be rejected`);
    }
  });

  test("accepts the shapes real mailboxes use", () => {
    for (const good of [
      "a@b.co",
      "first.last@sub.domain.example.com",
      "foo+sales@gmail.com",
      "foo_bar-baz@example.io",
      "123@example.com",
      "foo'connor@example.com",
    ]) {
      assert.equal(normalizeEmail(good), good, `expected ${good} to be accepted`);
    }
  });

  test("does NOT canonicalize gmail dots or plus tags", () => {
    // The whole point: over-matching a suppression list silently drops mail
    // the user never asked us to drop, and they cannot discover why.
    assert.notEqual(normalizeEmail("f.o.o@gmail.com"), normalizeEmail("foo@gmail.com"));
    assert.notEqual(
      normalizeEmail("foo+sales@gmail.com"),
      normalizeEmail("foo@gmail.com"),
    );
    assert.equal(normalizeEmail("foo+sales@gmail.com"), "foo+sales@gmail.com");
  });

  test("is idempotent", () => {
    for (const input of ["Foo <A@B.COM>", "a@b.com", "  x@y.org  "]) {
      const once = normalizeEmail(input);
      assert.equal(normalizeEmail(once), once, `not idempotent for ${input}`);
    }
  });
});

// ───────────────────────────── emailDomain ─────────────────────────────

describe("emailDomain", () => {
  test("returns the lowercased domain", () => {
    assert.equal(emailDomain("Foo <A@Example.COM>"), "example.com");
    assert.equal(emailDomain("a@sub.example.co.uk"), "sub.example.co.uk");
  });

  test("returns null for anything that does not parse", () => {
    assert.equal(emailDomain("nonsense"), null);
    assert.equal(emailDomain(null), null);
  });
});

// ──────────────────────────── isRoleAddress ────────────────────────────

describe("isRoleAddress", () => {
  test("flags shared-function mailboxes regardless of case or display name", () => {
    assert.equal(isRoleAddress("Support <SUPPORT@example.com>"), true);
    assert.equal(isRoleAddress("no-reply@example.com"), true);
    assert.equal(isRoleAddress("postmaster@example.com"), true);
    assert.equal(isRoleAddress("mailer-daemon@example.com"), true);
  });

  test("does not flag ordinary people", () => {
    assert.equal(isRoleAddress("nawaz@example.com"), false);
    assert.equal(isRoleAddress("supporter@example.com"), false); // not `support`
    assert.equal(isRoleAddress("info.person@example.com"), false);
  });

  test("returns false rather than throwing for junk", () => {
    assert.equal(isRoleAddress("nonsense"), false);
    assert.equal(isRoleAddress(null), false);
  });
});

// ─────────────────────────── parseAddressList ───────────────────────────

describe("parseAddressList", () => {
  test("splits a comma-separated list", () => {
    const r = parseAddressList("a@x.com, b@y.com,c@z.com");
    assert.deepEqual(r.addresses, ["a@x.com", "b@y.com", "c@z.com"]);
    assert.deepEqual(r.invalid, []);
  });

  test("splits on semicolons too, which Outlook users paste", () => {
    const r = parseAddressList("a@x.com; b@y.com");
    assert.deepEqual(r.addresses, ["a@x.com", "b@y.com"]);
  });

  test("a comma inside a quoted display name does not split the recipient", () => {
    const r = parseAddressList('"Bar, Foo" <foo@x.com>, b@y.com');
    assert.deepEqual(r.addresses, ["foo@x.com", "b@y.com"]);
    assert.deepEqual(r.invalid, []);
  });

  test("a comma inside angle brackets does not split either", () => {
    const r = parseAddressList("Foo <foo@x.com>, Bar <bar@y.com>");
    assert.deepEqual(r.addresses, ["foo@x.com", "bar@y.com"]);
  });

  test("de-duplicates, because mailing someone twice in one send is visible to them", () => {
    const r = parseAddressList("A@x.com, a@X.com, Foo <a@x.com>");
    assert.deepEqual(r.addresses, ["a@x.com"]);
  });

  test("reports unparseable entries instead of silently mailing fewer people", () => {
    const r = parseAddressList("good@x.com, garbage, also-bad@, b@y.com");
    assert.deepEqual(r.addresses, ["good@x.com", "b@y.com"]);
    assert.deepEqual(r.invalid, ["garbage", "also-bad@"]);
  });

  test("empty input and stray separators yield nothing, not an error", () => {
    assert.deepEqual(parseAddressList(""), { addresses: [], invalid: [] });
    assert.deepEqual(parseAddressList(null), { addresses: [], invalid: [] });
    assert.deepEqual(parseAddressList("  ,  ; "), { addresses: [], invalid: [] });
  });

  test("preserves input order", () => {
    const r = parseAddressList("z@z.com, a@a.com, m@m.com");
    assert.deepEqual(r.addresses, ["z@z.com", "a@a.com", "m@m.com"]);
  });
});
