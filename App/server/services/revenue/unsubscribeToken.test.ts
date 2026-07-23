import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, test } from "node:test";

import {
  deriveUnsubscribeSecret,
  listUnsubscribeHeaders,
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
} from "./unsubscribeToken.js";

const SECRET = "test-secret-not-a-real-one";
const OTHER_SECRET = "a-different-secret";

const PAYLOAD = {
  companyId: "co_123",
  contactId: "ct_456",
  email: "recipient@example.com",
};

describe("signUnsubscribeToken / verifyUnsubscribeToken", () => {
  test("round-trips a payload", () => {
    const token = signUnsubscribeToken(PAYLOAD, SECRET);
    assert.deepEqual(verifyUnsubscribeToken(token, SECRET), PAYLOAD);
  });

  test("normalizes the address at sign time", () => {
    const token = signUnsubscribeToken(
      { ...PAYLOAD, email: "  Recipient@Example.COM " },
      SECRET,
    );
    assert.equal(verifyUnsubscribeToken(token, SECRET)?.email, "recipient@example.com");
  });

  test("carries a null contactId through", () => {
    const token = signUnsubscribeToken({ ...PAYLOAD, contactId: null }, SECRET);
    assert.equal(verifyUnsubscribeToken(token, SECRET)?.contactId, null);
  });

  test("treats an empty contactId as null rather than the empty string", () => {
    const token = signUnsubscribeToken({ ...PAYLOAD, contactId: "" }, SECRET);
    assert.equal(verifyUnsubscribeToken(token, SECRET)?.contactId, null);
  });

  test("is deterministic — the same input yields the same token", () => {
    assert.equal(
      signUnsubscribeToken(PAYLOAD, SECRET),
      signUnsubscribeToken(PAYLOAD, SECRET),
    );
  });

  test("produces a URL-safe token (no +, /, = or padding)", () => {
    const token = signUnsubscribeToken(PAYLOAD, SECRET);
    assert.match(token, /^u1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.equal(encodeURIComponent(token), token);
  });

  test("refuses to sign an unusable address — a dead link is worse than none", () => {
    assert.throws(() => signUnsubscribeToken({ ...PAYLOAD, email: "junk" }, SECRET));
    assert.throws(() => signUnsubscribeToken({ ...PAYLOAD, email: "" }, SECRET));
  });

  test("refuses to sign without a companyId or a secret", () => {
    assert.throws(() => signUnsubscribeToken({ ...PAYLOAD, companyId: "" }, SECRET));
    assert.throws(() => signUnsubscribeToken(PAYLOAD, ""));
  });
});

describe("verifyUnsubscribeToken rejects tampering", () => {
  const token = signUnsubscribeToken(PAYLOAD, SECRET);

  test("a different secret does not verify", () => {
    assert.equal(verifyUnsubscribeToken(token, OTHER_SECRET), null);
  });

  test("a tampered payload does not verify", () => {
    const [v, , sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ c: "co_123", k: "ct_456", e: "victim@example.com" }),
    ).toString("base64url");
    assert.equal(verifyUnsubscribeToken(`${v}.${forged}.${sig}`, SECRET), null);
  });

  test("a tampered signature does not verify", () => {
    const [v, payload, sig] = token.split(".");
    const flipped = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
    assert.equal(verifyUnsubscribeToken(`${v}.${payload}.${flipped}`, SECRET), null);
  });

  test("changing ANY payload field invalidates the signature", () => {
    // Guards against a future refactor that signs only part of the payload.
    for (const mutated of [
      { ...PAYLOAD, companyId: "co_999" },
      { ...PAYLOAD, contactId: "ct_999" },
      { ...PAYLOAD, email: "someone-else@example.com" },
    ]) {
      const other = signUnsubscribeToken(mutated, SECRET);
      assert.notEqual(other, token, `token unchanged for ${JSON.stringify(mutated)}`);
      // And the original signature must not verify the mutated payload.
      const forgedPayload = other.split(".")[1];
      assert.equal(
        verifyUnsubscribeToken(`u1.${forgedPayload}.${token.split(".")[2]}`, SECRET),
        null,
      );
    }
  });

  test("a wrong version prefix does not verify", () => {
    const [, payload, sig] = token.split(".");
    assert.equal(verifyUnsubscribeToken(`u2.${payload}.${sig}`, SECRET), null);
    assert.equal(verifyUnsubscribeToken(`${payload}.${sig}`, SECRET), null);
  });

  test("malformed tokens return null instead of throwing", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "garbage",
      "u1.only-two-parts",
      "u1..sig",
      "u1.payload.",
      "u1.!!!not-base64!!!.sig",
      "a.b.c.d",
      token.toUpperCase(),
    ]) {
      assert.equal(
        verifyUnsubscribeToken(bad as string, SECRET),
        null,
        `expected null for ${String(bad)}`,
      );
    }
  });

  test("a payload that decodes to valid base64 but not JSON returns null", () => {
    const notJson = Buffer.from("plain text").toString("base64url");
    const sig = signUnsubscribeToken(PAYLOAD, SECRET); // any signature; must fail on MAC first
    assert.equal(verifyUnsubscribeToken(`u1.${notJson}.${sig.split(".")[2]}`, SECRET), null);
  });

  test("a correctly-signed payload missing required fields returns null", () => {
    // Simulates a downgrade attack from a future token shape.
    for (const wire of [{ k: "x", e: "a@b.com" }, { c: "co", e: "" }, { c: "", e: "a@b.com" }]) {
      const part = Buffer.from(JSON.stringify(wire)).toString("base64url");
      const sig = crypto.createHmac("sha256", SECRET).update(part).digest("base64url");
      assert.equal(
        verifyUnsubscribeToken(`u1.${part}.${sig}`, SECRET),
        null,
        `expected null for ${JSON.stringify(wire)}`,
      );
    }
  });

  test("an empty secret never verifies, even against an empty signature", () => {
    assert.equal(verifyUnsubscribeToken(token, ""), null);
  });
});

describe("deriveUnsubscribeSecret", () => {
  test("is deterministic and does not return the input secret", () => {
    const derived = deriveUnsubscribeSecret("instance-secret");
    assert.equal(derived, deriveUnsubscribeSecret("instance-secret"));
    assert.notEqual(derived, "instance-secret");
    assert.match(derived, /^[0-9a-f]{64}$/);
  });

  test("different instance secrets derive different keys", () => {
    assert.notEqual(deriveUnsubscribeSecret("a"), deriveUnsubscribeSecret("b"));
  });

  test("tokens signed under one instance secret do not verify under another", () => {
    const t = signUnsubscribeToken(PAYLOAD, deriveUnsubscribeSecret("a"));
    assert.equal(verifyUnsubscribeToken(t, deriveUnsubscribeSecret("b")), null);
    assert.deepEqual(verifyUnsubscribeToken(t, deriveUnsubscribeSecret("a")), PAYLOAD);
  });
});

describe("listUnsubscribeHeaders", () => {
  test("emits the RFC 8058 one-click pair", () => {
    const h = listUnsubscribeHeaders("https://app.example.com/u/tok");
    assert.equal(h["List-Unsubscribe"], "<https://app.example.com/u/tok>");
    assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  });

  test("appends a mailto fallback when one is configured", () => {
    const h = listUnsubscribeHeaders("https://a.com/u/t", "Unsub <UNSUB@Example.com>");
    assert.equal(
      h["List-Unsubscribe"],
      "<https://a.com/u/t>, <mailto:unsub@example.com?subject=unsubscribe>",
    );
  });

  test("skips an unusable mailto rather than emitting a broken header", () => {
    for (const bad of [null, undefined, "", "not-an-address"]) {
      const h = listUnsubscribeHeaders("https://a.com/u/t", bad);
      assert.equal(h["List-Unsubscribe"], "<https://a.com/u/t>");
    }
  });

  test("always sets the Post header, since that is what makes it one-click", () => {
    assert.equal(
      listUnsubscribeHeaders("https://a.com/u/t", "u@e.com")["List-Unsubscribe-Post"],
      "List-Unsubscribe=One-Click",
    );
  });
});

describe("unsubscribeUrl", () => {
  test("joins the public URL and the token", () => {
    assert.equal(unsubscribeUrl("https://app.example.com", "tok"), "https://app.example.com/u/tok");
  });

  test("tolerates a trailing slash on the configured public URL", () => {
    assert.equal(unsubscribeUrl("https://app.example.com/", "tok"), "https://app.example.com/u/tok");
    assert.equal(unsubscribeUrl("https://app.example.com///", "tok"), "https://app.example.com/u/tok");
  });
});
