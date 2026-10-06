import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { createSealer } from "../src/secrets.js";
import {
  createTokens,
  decryptResult,
  encryptResult,
  isResultKey,
  SEALED_TOKEN_PATTERN,
  type CallbackContext,
  type RequestContext,
} from "../src/tokens.js";

const NOW = 1_800_000_000_000;
const key = () => crypto.randomBytes(32).toString("base64url");
const sealer = createSealer("s".repeat(48));

const request: Omit<RequestContext, "version"> = {
  expiresAt: NOW + 60_000,
  browserChallenge: key(),
  installationOrigin: "http://nas.local:3000",
  returnUrl: "http://nas.local:3000/api/integrations/oauth/hosted/return",
  state: key(),
  resultKey: key(),
  scopes: ["https://www.googleapis.com/auth/userinfo.email", "openid"],
  clientId: "client.apps.googleusercontent.com",
};
const callback: Omit<CallbackContext, "version"> = {
  expiresAt: NOW + 60_000,
  nonceHash: key(),
  codeVerifier: key(),
  clientId: "client.apps.googleusercontent.com",
  returnUrl: request.returnUrl,
  state: request.state,
  resultKey: request.resultKey,
};

/** Flip one character in the middle of a token part, keeping the encoding valid. */
function flip(token: string, part: number): string {
  const parts = token.split(".");
  const middle = Math.floor(parts[part].length / 2);
  const char = parts[part][middle];
  parts[part] =
    `${parts[part].slice(0, middle)}${char === "A" ? "B" : "A"}${parts[part].slice(middle + 1)}`;
  return parts.join(".");
}

test("each kind of token opens only as itself, for its provider, under its secret", () => {
  const google = createTokens(sealer, "google", () => NOW);
  const sealedRequest = google.sealRequest(request);
  const sealedCallback = google.sealCallback(callback);
  assert.match(sealedRequest, SEALED_TOKEN_PATTERN);
  assert.match(sealedCallback, SEALED_TOKEN_PATTERN);
  assert.deepEqual(google.openRequest(sealedRequest), { version: 2, ...request });
  assert.deepEqual(google.openCallback(sealedCallback), { version: 2, ...callback });

  assert.equal(google.openCallback(sealedRequest), null, "a request is not a callback");
  assert.equal(google.openRequest(sealedCallback), null, "a callback is not a request");
  // Even a payload of the right shape, sealed for the other step, stays shut.
  const callbackAsRequest = sealer.seal(
    JSON.stringify({ version: 2, ...callback }),
    "connect-request:v2:google",
  );
  assert.equal(google.openCallback(callbackAsRequest), null);
  const requestAsCallback = sealer.seal(
    JSON.stringify({ version: 2, ...request }),
    "connect-callback:v2:google",
  );
  assert.equal(google.openRequest(requestAsCallback), null);
  const github = createTokens(sealer, "github", () => NOW);
  assert.equal(github.openRequest(sealedRequest), null);
  assert.equal(github.openCallback(sealedCallback), null);
  const otherSecret = createTokens(createSealer("o".repeat(48)), "google", () => NOW);
  assert.equal(otherSecret.openRequest(sealedRequest), null);

  // Sealing twice never yields the same token, and nothing inside is readable.
  assert.notEqual(google.sealRequest(request), sealedRequest);
  for (const value of [request.state, request.resultKey, request.returnUrl, request.clientId]) {
    assert.equal(sealedRequest.includes(value), false);
    assert.equal(Buffer.from(sealedRequest.split(".")[2], "base64url").includes(value), false);
  }
});

test("a token expires at its own deadline, which a holder cannot move", () => {
  let now = NOW;
  const tokens = createTokens(sealer, "google", () => now);
  const sealed = tokens.sealRequest(request);
  now = request.expiresAt - 1;
  assert.ok(tokens.openRequest(sealed));
  now = request.expiresAt;
  assert.equal(tokens.openRequest(sealed), null);
  now = NOW;
  assert.equal(tokens.openRequest(tokens.sealRequest({ ...request, expiresAt: NOW })), null);
});

test("tampering with any part of a token, or its framing, makes it unreadable", () => {
  const tokens = createTokens(sealer, "google", () => NOW);
  const sealed = tokens.sealRequest(request);
  for (const tampered of [
    flip(sealed, 1),
    flip(sealed, 2),
    sealed.replace(/^v1\./, "v2."),
    `${sealed}.extra`,
    sealed.split(".").slice(0, 2).join("."),
    sealed.slice(0, -4),
    "",
  ]) {
    assert.equal(tokens.openRequest(tampered), null, tampered.slice(0, 30));
  }
});

test("only a context of exactly the expected shape is accepted, even when sealed correctly", () => {
  const tokens = createTokens(sealer, "google", () => NOW);
  const context = "connect-request:v2:google";
  const sealRaw = (value: unknown) => sealer.seal(JSON.stringify(value), context);
  assert.ok(tokens.openRequest(sealRaw({ version: 2, ...request })));
  for (const value of [
    { version: 1, ...request },
    { version: 2, ...request, extra: true },
    { version: 2, ...request, scopes: [] },
    { version: 2, ...request, resultKey: "short" },
    { version: 2, ...request, expiresAt: "later" },
    { ...request },
    null,
    [],
  ]) {
    assert.equal(tokens.openRequest(sealRaw(value)), null, JSON.stringify(value)?.slice(0, 40));
  }
  assert.equal(tokens.openRequest(sealer.seal("not json", context)), null);
});

test("a result key is the canonical encoding of 32 bytes and nothing else", () => {
  assert.equal(isResultKey(key()), true);
  const valid = key();
  for (const value of [
    valid.slice(1),
    `${valid}A`,
    `${valid.slice(0, 42)}+`,
    `${"A".repeat(42)}B`,
    `${valid.slice(0, 42)}=`,
    "",
  ]) {
    assert.equal(isResultKey(value), false, value);
  }
});

test("a result opens only with its key, for its provider and its sign-in", () => {
  const resultKey = key();
  const state = key();
  const sealed = encryptResult(resultKey, "google", state, '{"accessToken":"a"}');
  assert.match(sealed, /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.equal(decryptResult(resultKey, "google", state, sealed), '{"accessToken":"a"}');
  assert.notEqual(encryptResult(resultKey, "google", state, '{"accessToken":"a"}'), sealed);

  assert.equal(decryptResult(key(), "google", state, sealed), null, "another key");
  assert.equal(decryptResult(resultKey, "github", state, sealed), null, "another provider");
  assert.equal(decryptResult(resultKey, "google", key(), sealed), null, "another sign-in");
  for (const tampered of [
    flip(sealed, 0),
    flip(sealed, 1),
    `${sealed}.x`,
    sealed.split(".")[1],
    `${sealed.split(".")[0]}.AAAA`,
    "",
  ]) {
    assert.equal(decryptResult(resultKey, "google", state, tampered), null, tampered);
  }
  assert.equal(decryptResult("not-a-key", "google", state, sealed), null);
});
