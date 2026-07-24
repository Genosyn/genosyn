import assert from "node:assert/strict";
import test from "node:test";
import {
  disallowedRecipients,
  emailDomain,
  trustedRecipientDomains,
} from "./recipientAllowlist.js";

test("emailDomain extracts and lowercases the domain", () => {
  assert.equal(emailDomain("Billing@Acme.COM"), "acme.com");
  assert.equal(emailDomain("  ap@customer.com  ".trim()), "customer.com");
});

test("emailDomain rejects malformed or single-label domains", () => {
  for (const bad of ["", "no-at", "@nolocal.com", "trailing@", "  ", "a@b@c", "user@localhost"]) {
    assert.equal(emailDomain(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("trustedRecipientDomains unions customer and cc domains, skipping junk", () => {
  const t = trustedRecipientDomains({
    customerEmail: "ap@customer.com",
    ccEmails: ["finance@acme.com", "second@acme.com", "garbage", ""],
  });
  assert.deepEqual([...t].sort(), ["acme.com", "customer.com"]);
});

test("trustedRecipientDomains tolerates a null customer email", () => {
  const t = trustedRecipientDomains({ customerEmail: null, ccEmails: ["finance@acme.com"] });
  assert.deepEqual([...t], ["acme.com"]);
});

test("disallowedRecipients passes on-domain addresses", () => {
  const trusted = new Set(["acme.com", "customer.com"]);
  assert.deepEqual(disallowedRecipients(["ap@customer.com", "cfo@acme.com"], trusted), []);
});

test("disallowedRecipients flags off-domain and malformed addresses (fail closed)", () => {
  const trusted = new Set(["acme.com", "customer.com"]);
  assert.deepEqual(disallowedRecipients(["attacker@evil.com"], trusted), ["attacker@evil.com"]);
  assert.deepEqual(disallowedRecipients(["garbage"], trusted), ["garbage"]);
  assert.deepEqual(disallowedRecipients([" spoof@sub.evil.com "], trusted), ["spoof@sub.evil.com"]);
});

test("disallowedRecipients matches case-insensitively", () => {
  const trusted = trustedRecipientDomains({ customerEmail: "ap@Customer.com" });
  assert.deepEqual(disallowedRecipients(["Someone@CUSTOMER.COM"], trusted), []);
});

test("a subdomain of a trusted domain is NOT trusted", () => {
  // Blocks the classic bypass where an attacker registers acme.com.evil.io
  // or relies on a lax suffix match.
  const trusted = new Set(["acme.com"]);
  assert.deepEqual(disallowedRecipients(["x@mail.acme.com"], trusted), ["x@mail.acme.com"]);
  assert.deepEqual(disallowedRecipients(["x@acme.com.evil.io"], trusted), ["x@acme.com.evil.io"]);
});
