import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  BitwardenCryptoError,
  decryptAsymmetricEncString,
  decryptEncString,
  decryptEncStringToText,
  hkdfExpand,
  parseEncString,
  stretchKey,
  symmetricKeyFromBytes,
} from "./encString.js";

/**
 * The bottom of the Bitwarden stack. Every mirrored credential is read through
 * these four primitives, and a mistake in any of them is silent: the wrong
 * HKDF, a MAC checked after the padding, or a misparsed header all produce
 * plausible-looking bytes or a misleading error rather than a loud failure.
 *
 * The AES-256-CBC-HMAC-SHA256 vector below is the official Bitwarden SDK one
 * (`crypto/src/enc_string/symmetric.rs`), reproduced here so a refactor that
 * changes what `2.` means has to disagree with upstream to pass.
 */

const SDK_VECTOR = {
  key: Buffer.from(Array.from({ length: 64 }, (_, index) => index)),
  iv: Buffer.from("d8da2400c4ba965531936ea8b9e32aac", "hex"),
  ciphertext: Buffer.from(
    "ea4d100fbd5224bcb6584043915e1eb224eb8243ffcfb7a849e7527ac18b1981",
    "hex",
  ),
  mac: Buffer.from("3c4e2c6f48e9030656fad9f23ee5b8dde796bd2c63bddc37c4c2653c66c39582", "hex"),
  plaintext: "Bitwarden SDK test vector",
};

function encStringFrom(iv: Buffer, ciphertext: Buffer, mac: Buffer): string {
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${mac.toString("base64")}`;
}

/** Encrypt with a 64-byte key exactly the way a Bitwarden client writes a type-2 value. */
function sealType2(plaintext: Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = crypto
    .createHmac("sha256", key.subarray(32, 64))
    .update(iv)
    .update(ciphertext)
    .digest();
  return encStringFrom(iv, ciphertext, mac);
}

test("decrypts the official Bitwarden SDK AES-256-CBC-HMAC-SHA256 vector", () => {
  const value = encStringFrom(SDK_VECTOR.iv, SDK_VECTOR.ciphertext, SDK_VECTOR.mac);
  const key = symmetricKeyFromBytes(SDK_VECTOR.key);
  assert.equal(decryptEncStringToText(value, key), SDK_VECTOR.plaintext);
  assert.deepEqual(
    decryptEncString(value, key),
    Buffer.from(SDK_VECTOR.plaintext, "utf8"),
    "the byte-level result must match too, not only its UTF-8 rendering",
  );
});

test("splits a 64-byte key into enc || mac, and rejects other lengths", () => {
  const key = symmetricKeyFromBytes(SDK_VECTOR.key);
  assert.deepEqual(key.encKey, SDK_VECTOR.key.subarray(0, 32));
  assert.deepEqual(key.macKey, SDK_VECTOR.key.subarray(32, 64));

  const short = symmetricKeyFromBytes(SDK_VECTOR.key.subarray(0, 32));
  assert.deepEqual(short.encKey, SDK_VECTOR.key.subarray(0, 32));
  assert.equal(short.macKey, null);

  assert.throws(
    () => symmetricKeyFromBytes(Buffer.alloc(48)),
    (error: unknown) =>
      error instanceof BitwardenCryptoError && /48 bytes/.test((error as Error).message),
  );
});

test("a tampered MAC fails the integrity check", () => {
  const tampered = Buffer.from(SDK_VECTOR.mac);
  tampered[0] ^= 0x01;
  const value = encStringFrom(SDK_VECTOR.iv, SDK_VECTOR.ciphertext, tampered);
  assert.throws(
    () => decryptEncString(value, symmetricKeyFromBytes(SDK_VECTOR.key)),
    (error: unknown) =>
      error instanceof BitwardenCryptoError &&
      /integrity check failed/i.test((error as Error).message),
  );
});

test("verifies the MAC before decrypting, so bad padding is never an oracle", () => {
  // A ciphertext that is a valid block length but decrypts to bytes whose
  // final octet (0xff) can never be PKCS#7 padding. Encrypting with padding
  // switched off makes that deterministic rather than a one-in-256 gamble.
  const raw = Buffer.alloc(32, 0xff);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    SDK_VECTOR.key.subarray(0, 32),
    SDK_VECTOR.iv,
  );
  cipher.setAutoPadding(false);
  const garbage = Buffer.concat([cipher.update(raw), cipher.final()]);
  const honestMac = crypto
    .createHmac("sha256", SDK_VECTOR.key.subarray(32, 64))
    .update(SDK_VECTOR.iv)
    .update(garbage)
    .digest();

  // With a correct MAC the padding failure is the one that surfaces...
  assert.throws(
    () =>
      decryptEncString(
        encStringFrom(SDK_VECTOR.iv, garbage, honestMac),
        symmetricKeyFromBytes(SDK_VECTOR.key),
      ),
    (error: unknown) =>
      error instanceof BitwardenCryptoError &&
      /could not be decrypted/i.test((error as Error).message),
  );

  // ...but once the MAC is wrong the integrity check must fire first, so an
  // attacker learns nothing about the padding of a ciphertext they forged.
  const forgedMac = Buffer.from(honestMac);
  forgedMac[31] ^= 0xff;
  assert.throws(
    () =>
      decryptEncString(
        encStringFrom(SDK_VECTOR.iv, garbage, forgedMac),
        symmetricKeyFromBytes(SDK_VECTOR.key),
      ),
    (error: unknown) =>
      error instanceof BitwardenCryptoError &&
      /integrity check failed/i.test((error as Error).message),
  );
});

test("refuses a 32-byte key for an authenticated (type 2) string", () => {
  const value = encStringFrom(SDK_VECTOR.iv, SDK_VECTOR.ciphertext, SDK_VECTOR.mac);
  assert.throws(
    () => decryptEncString(value, symmetricKeyFromBytes(SDK_VECTOR.key.subarray(0, 32))),
    (error: unknown) =>
      error instanceof BitwardenCryptoError && /64-byte key/i.test((error as Error).message),
  );
});

test("rejects a type-2 string whose IV or MAC is the wrong length", () => {
  const shortIv = encStringFrom(
    SDK_VECTOR.iv.subarray(0, 8),
    SDK_VECTOR.ciphertext,
    SDK_VECTOR.mac,
  );
  assert.throws(
    () => decryptEncString(shortIv, symmetricKeyFromBytes(SDK_VECTOR.key)),
    (error: unknown) =>
      error instanceof BitwardenCryptoError && /IV length/i.test((error as Error).message),
  );
  const shortMac = encStringFrom(
    SDK_VECTOR.iv,
    SDK_VECTOR.ciphertext,
    SDK_VECTOR.mac.subarray(0, 16),
  );
  assert.throws(
    () => decryptEncString(shortMac, symmetricKeyFromBytes(SDK_VECTOR.key)),
    (error: unknown) =>
      error instanceof BitwardenCryptoError && /MAC length/i.test((error as Error).message),
  );
});

test("hkdfExpand is Expand-only and is not crypto.hkdfSync", () => {
  const prk = crypto.randomBytes(32);
  const ours = hkdfExpand(prk, "enc", 32);

  // The trap this module exists to avoid: Node runs Extract first, so the
  // same inputs give different — and silently wrong — key material.
  const nodes = Buffer.from(crypto.hkdfSync("sha256", prk, Buffer.alloc(0), "enc", 32));
  assert.equal(ours.length, 32);
  assert.notDeepEqual(ours, nodes);

  // RFC 5869 §2.3 for L = 32: T(1) = HMAC(PRK, info || 0x01).
  const hand = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from("enc", "utf8"), Buffer.from([1])]))
    .digest();
  assert.deepEqual(ours, hand);
});

test("hkdfExpand chains T(n-1) into the next block", () => {
  const prk = crypto.randomBytes(32);
  const first = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from("mac", "utf8"), Buffer.from([1])]))
    .digest();
  const second = crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([first, Buffer.from("mac", "utf8"), Buffer.from([2])]))
    .digest();
  assert.deepEqual(hkdfExpand(prk, "mac", 64), Buffer.concat([first, second]));
  // A partial block is truncated, not rounded up.
  assert.deepEqual(hkdfExpand(prk, "mac", 40), Buffer.concat([first, second]).subarray(0, 40));
});

test("stretchKey derives enc and mac from the same 32-byte key", () => {
  const key = crypto.randomBytes(32);
  const stretched = stretchKey(key);
  assert.deepEqual(
    stretched.encKey,
    crypto
      .createHmac("sha256", key)
      .update(Buffer.concat([Buffer.from("enc", "utf8"), Buffer.from([1])]))
      .digest(),
  );
  assert.deepEqual(
    stretched.macKey,
    crypto
      .createHmac("sha256", key)
      .update(Buffer.concat([Buffer.from("mac", "utf8"), Buffer.from([1])]))
      .digest(),
  );
  assert.throws(
    () => stretchKey(crypto.randomBytes(64)),
    (error: unknown) => error instanceof BitwardenCryptoError,
  );
});

test("parseEncString reads the header form, the legacy form, and refuses the rest", () => {
  assert.deepEqual(parseEncString("2.aXY=|Y3Q=|bWFj"), {
    type: 2,
    parts: ["aXY=", "Y3Q=", "bWFj"],
  });
  assert.deepEqual(parseEncString("4.cnNh"), { type: 4, parts: ["cnNh"] });
  // Header-less, two pipe-separated parts: a pre-authenticator (type 0) value.
  assert.deepEqual(parseEncString("aXY=|Y3Q="), { type: 0, parts: ["aXY=", "Y3Q="] });
  assert.deepEqual(parseEncString("  2.aXY=|Y3Q=|bWFj  "), {
    type: 2,
    parts: ["aXY=", "Y3Q=", "bWFj"],
  });

  for (const malformed of ["", "   ", "not-an-enc-string", "aXY=|Y3Q=|bWFj"]) {
    assert.throws(
      () => parseEncString(malformed),
      (error: unknown) => error instanceof BitwardenCryptoError,
      `expected ${JSON.stringify(malformed)} to be rejected`,
    );
  }
});

test("a COSE (type 7) string says so instead of being misparsed", () => {
  assert.throws(
    () => decryptEncString("7.Y29zZQ==", symmetricKeyFromBytes(SDK_VECTOR.key)),
    (error: unknown) =>
      error instanceof BitwardenCryptoError && /COSE/i.test((error as Error).message),
  );
  assert.throws(
    () => decryptEncString("9.Y29zZQ==", symmetricKeyFromBytes(SDK_VECTOR.key)),
    (error: unknown) =>
      error instanceof BitwardenCryptoError &&
      /Unsupported Bitwarden encryption type 9/.test((error as Error).message),
  );
});

test("round-trips a legacy type-0 (MAC-less) string", () => {
  const key = crypto.randomBytes(32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const ciphertext = Buffer.concat([cipher.update("legacy user key", "utf8"), cipher.final()]);
  const headerless = `${iv.toString("base64")}|${ciphertext.toString("base64")}`;

  assert.equal(decryptEncStringToText(headerless, symmetricKeyFromBytes(key)), "legacy user key");
  assert.equal(
    decryptEncStringToText(`0.${headerless}`, symmetricKeyFromBytes(key)),
    "legacy user key",
    "the explicit 0. header must mean the same thing as the header-less form",
  );
});

test("round-trips a type-2 string this module did not write", () => {
  const key = crypto.randomBytes(64);
  const secret = "correct horse battery staple";
  assert.equal(
    decryptEncStringToText(sealType2(Buffer.from(secret), key), symmetricKeyFromBytes(key)),
    secret,
  );
});

test("decryptAsymmetricEncString unwraps an RSA-OAEP-SHA1 (type 4) value", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const organizationKey = crypto.randomBytes(64);
  const sealed = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
    organizationKey,
  );
  const value = `4.${sealed.toString("base64")}`;
  assert.deepEqual(decryptAsymmetricEncString(value, privateKey), organizationKey);

  // Type 3 is the SHA-256 variant; reading a SHA-1 value as one must fail
  // rather than return whatever OAEP unpadding produces.
  assert.throws(
    () => decryptAsymmetricEncString(`3.${sealed.toString("base64")}`, privateKey),
    (error: unknown) => error instanceof BitwardenCryptoError,
  );
  assert.throws(
    () => decryptAsymmetricEncString(`2.${sealed.toString("base64")}`, privateKey),
    (error: unknown) =>
      error instanceof BitwardenCryptoError &&
      /RSA encryption type 2/.test((error as Error).message),
  );
});


test("refuses an unauthenticated value read with an authenticated key", () => {
  // The downgrade a hostile server would attempt: take a real authenticated
  // value, relabel it type 0, drop the MAC, and XOR the IV so the first
  // plaintext block decrypts to whatever it likes. AES-CBC has no integrity of
  // its own, so the only thing standing in the way is refusing the type.
  const key64 = crypto.randomBytes(64);
  const key = symmetricKeyFromBytes(key64);
  const plaintext = "https://bank.example/login";
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key64.subarray(0, 32), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  const forgedIv = Buffer.from(iv);
  const want = Buffer.from("https://evil.tl/", "utf8");
  const have = Buffer.from(plaintext.slice(0, 16), "utf8");
  for (let i = 0; i < 16; i += 1) forgedIv[i] ^= have[i] ^ want[i];
  const forged = `0.${forgedIv.toString("base64")}|${ct.toString("base64")}`;

  assert.throws(
    () => decryptEncStringToText(forged, key),
    /without authentication cannot be read with an authenticated key/,
  );

  // The legacy path this type exists for still works: a 32-byte key has no MAC
  // half, so an old account's protected user key is still readable.
  const legacyKey = symmetricKeyFromBytes(key64.subarray(0, 32));
  const legacyIv = crypto.randomBytes(16);
  const legacy = crypto.createCipheriv("aes-256-cbc", key64.subarray(0, 32), legacyIv);
  const legacyCt = Buffer.concat([legacy.update("legacy", "utf8"), legacy.final()]);
  assert.equal(
    decryptEncStringToText(
      `0.${legacyIv.toString("base64")}|${legacyCt.toString("base64")}`,
      legacyKey,
    ),
    "legacy",
  );
});
