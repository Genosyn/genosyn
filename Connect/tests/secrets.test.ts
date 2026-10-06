import assert from "node:assert/strict";
import { test } from "node:test";
import { createSealer, digest, randomToken, safeEqual } from "../src/secrets.js";

test("digest is the PKCE S256 transform", () => {
  // RFC 7636 appendix B.
  assert.equal(
    digest("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("random tokens are 43 URL-safe characters and do not repeat", () => {
  const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
  assert.equal(tokens.size, 200);
  for (const token of tokens) assert.match(token, /^[A-Za-z0-9_-]{43}$/);
});

test("safeEqual compares exactly, including unequal lengths", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", ""), true);
});

test("sealed values round-trip and are bound to their key and context", () => {
  const sealer = createSealer("k".repeat(40));
  const sealed = sealer.seal('{"refreshToken":"secret"}', "connect-flow:flow:google");
  assert.doesNotMatch(sealed, /secret|refreshToken/);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.equal(sealer.open(sealed, "connect-flow:flow:google"), '{"refreshToken":"secret"}');
  assert.notEqual(sealer.seal("same", "c"), sealer.seal("same", "c"), "every seal has a fresh IV");

  assert.equal(sealer.open(sealed, "connect-flow:callback:google"), null, "another context");
  assert.equal(
    createSealer("j".repeat(40)).open(sealed, "connect-flow:flow:google"),
    null,
    "another key",
  );
  const [version, iv, payload] = sealed.split(".");
  const flipped = payload.slice(0, -2) + (payload.at(-2) === "A" ? "B" : "A") + payload.at(-1);
  for (const tampered of [
    `${version}.${iv}.${flipped}`,
    `v2.${iv}.${payload}`,
    `${version}.${iv}`,
    `${version}.${iv}.${payload}.extra`,
    `${version}.AAAA.${payload}`,
    `${version}.${iv}.AAAA`,
    "",
    "not sealed at all",
  ]) {
    assert.equal(sealer.open(tampered, "connect-flow:flow:google"), null, tampered.slice(0, 20));
  }
});
