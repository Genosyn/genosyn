import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import { argon2id } from "hash-wasm";

import { BitwardenCryptoError } from "./encString.js";
import {
  BITWARDEN_KDF_ARGON2ID,
  BITWARDEN_KDF_PBKDF2,
  assertUsableKdf,
  deriveBitwardenMasterKey,
  deriveBitwardenPasswordHash,
  normalizeBitwardenEmail,
  unwrapBitwardenOrganizationKey,
  unwrapBitwardenPrivateKey,
  unwrapBitwardenSymmetricKey,
  unwrapBitwardenUserKey,
} from "./keys.js";

/**
 * The key hierarchy. Each derivation here is checked against an independent
 * computation rather than against the module's own output, because every trap
 * in this file (Argon2's MiB-vs-KiB salt, the inverted PBKDF2 arguments in the
 * server hash, HKDF-Expand-only) produces a *valid-looking* key that simply
 * fails to unlock anything.
 */

/** RFC 5869 §2.3 Expand for one 32-byte block, computed independently here. */
function expand(prk: Buffer, info: string): Buffer {
  return crypto
    .createHmac("sha256", prk)
    .update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([1])]))
    .digest();
}

function sealType2(plaintext: Buffer, key: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key.subarray(0, 32), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = crypto
    .createHmac("sha256", key.subarray(32, 64))
    .update(iv)
    .update(ciphertext)
    .digest();
  return `2.${iv.toString("base64")}|${ciphertext.toString("base64")}|${mac.toString("base64")}`;
}

function sealType0(plaintext: Buffer, encKey: Buffer): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${iv.toString("base64")}|${ciphertext.toString("base64")}`;
}

const PBKDF2_KDF = {
  kind: BITWARDEN_KDF_PBKDF2,
  iterations: 5_000,
  memory: null,
  parallelism: null,
} as const;

test("normalizes the KDF salt email", () => {
  assert.equal(normalizeBitwardenEmail("  Ops@Example.COM \n"), "ops@example.com");
});

test("derives a PBKDF2 master key from the trimmed, lowercased email", async () => {
  const derived = await deriveBitwardenMasterKey("hunter2", "  Ops@Example.COM  ", PBKDF2_KDF);
  assert.deepEqual(
    derived,
    crypto.pbkdf2Sync("hunter2", "ops@example.com", 5_000, 32, "sha256"),
    "the salt must be the normalized email, and the output exactly 32 bytes",
  );
  assert.equal(derived.length, 32);

  // Same account typed differently must unlock the same vault.
  assert.deepEqual(
    derived,
    await deriveBitwardenMasterKey("hunter2", "ops@example.com", PBKDF2_KDF),
  );
  // ...and a different account must not.
  assert.notDeepEqual(
    derived,
    await deriveBitwardenMasterKey("hunter2", "other@example.com", PBKDF2_KDF),
  );
});

test("derives an Argon2id master key with memory read as MiB", async () => {
  const password = "hunter2";
  const email = "ops@example.com";
  const kdf = {
    kind: BITWARDEN_KDF_ARGON2ID,
    iterations: 2,
    memory: 16,
    parallelism: 1,
  } as const;

  const derived = await deriveBitwardenMasterKey(password, email, kdf);
  assert.equal(derived.length, 32);
  assert.deepEqual(
    derived,
    await deriveBitwardenMasterKey(password, email, kdf),
    "the same parameters must always give the same key",
  );

  // Independently computed: the salt is SHA-256(email), and the reported
  // memory is MiB where Argon2 counts KiB.
  const expected = Buffer.from(
    await argon2id({
      password,
      salt: crypto.createHash("sha256").update(email, "utf8").digest(),
      iterations: 2,
      memorySize: 16 * 1024,
      parallelism: 1,
      hashLength: 32,
      outputType: "binary",
    }),
  );
  assert.deepEqual(derived, expected);

  // If memory were passed through unscaled, 16 and 32 would both be clamped
  // to the same tiny value; they must not agree.
  const bigger = await deriveBitwardenMasterKey(password, email, { ...kdf, memory: 32 });
  assert.notDeepEqual(derived, bigger);
});

test("the server password hash inverts the PBKDF2 arguments", () => {
  const masterKey = crypto.randomBytes(32);
  const password = "hunter2";
  const hash = deriveBitwardenPasswordHash(masterKey, password);

  assert.equal(hash, crypto.pbkdf2Sync(masterKey, password, 1, 32, "sha256").toString("base64"));
  // The classic bug: password as the PBKDF2 password and key as the salt. That
  // both authenticates against nothing and hands the server unlock material.
  assert.notEqual(hash, crypto.pbkdf2Sync(password, masterKey, 1, 32, "sha256").toString("base64"));
  // The value sent to the server must never be the key that unlocks the vault.
  assert.notEqual(hash, masterKey.toString("base64"));
  assert.equal(Buffer.from(hash, "base64").length, 32);
});

test("assertUsableKdf refuses a downgraded or malformed KDF", () => {
  assert.doesNotThrow(() => assertUsableKdf({ ...PBKDF2_KDF }));
  assert.doesNotThrow(() =>
    assertUsableKdf({
      kind: BITWARDEN_KDF_PBKDF2,
      iterations: 600_000,
      memory: null,
      parallelism: null,
    }),
  );

  // A hostile or misconfigured server answering `prelogin` with one round.
  for (const iterations of [1, 1_000, 4_999, 0, -1, 5_000.5]) {
    assert.throws(
      () =>
        assertUsableKdf({
          kind: BITWARDEN_KDF_PBKDF2,
          iterations,
          memory: null,
          parallelism: null,
        }),
      (error: unknown) =>
        error instanceof BitwardenCryptoError && /PBKDF2 iteration/i.test((error as Error).message),
      `expected ${iterations} PBKDF2 iterations to be refused`,
    );
  }

  assert.doesNotThrow(() =>
    assertUsableKdf({ kind: BITWARDEN_KDF_ARGON2ID, iterations: 3, memory: 64, parallelism: 4 }),
  );
  const badArgon = [
    { iterations: 1, memory: 64, parallelism: 4 },
    { iterations: 3, memory: 8, parallelism: 4 },
    { iterations: 3, memory: 4_096, parallelism: 4 },
    { iterations: 3, memory: 64, parallelism: 0 },
    { iterations: 3, memory: null, parallelism: 4 },
    { iterations: 3, memory: 64, parallelism: null },
  ] as const;
  for (const params of badArgon) {
    assert.throws(
      () => assertUsableKdf({ kind: BITWARDEN_KDF_ARGON2ID, ...params }),
      (error: unknown) =>
        error instanceof BitwardenCryptoError &&
        /Argon2id parameters/i.test((error as Error).message),
      `expected ${JSON.stringify(params)} to be refused`,
    );
  }
});

test("deriveBitwardenMasterKey refuses to derive from an unsafe KDF at all", async () => {
  await assert.rejects(
    deriveBitwardenMasterKey("hunter2", "ops@example.com", {
      kind: BITWARDEN_KDF_PBKDF2,
      iterations: 1_000,
      memory: null,
      parallelism: null,
    }),
    (error: unknown) => error instanceof BitwardenCryptoError,
  );
});

test("unwraps a user key wrapped by the stretched master key", () => {
  const masterKey = crypto.randomBytes(32);
  const userKeyBytes = crypto.randomBytes(64);
  // Built the way a Bitwarden client builds it, without reusing stretchKey.
  const stretched = Buffer.concat([expand(masterKey, "enc"), expand(masterKey, "mac")]);
  const protectedUserKey = sealType2(userKeyBytes, stretched);

  const unwrapped = unwrapBitwardenUserKey(protectedUserKey, masterKey);
  assert.deepEqual(unwrapped.encKey, userKeyBytes.subarray(0, 32));
  assert.deepEqual(unwrapped.macKey, userKeyBytes.subarray(32, 64));

  // The wrong master password must fail loudly rather than yield junk bytes.
  assert.throws(
    () => unwrapBitwardenUserKey(protectedUserKey, crypto.randomBytes(32)),
    (error: unknown) => error instanceof BitwardenCryptoError,
  );
});

test("unwraps a legacy type-0 user key with the raw master key", () => {
  const masterKey = crypto.randomBytes(32);
  const userKeyBytes = crypto.randomBytes(64);
  const protectedUserKey = sealType0(userKeyBytes, masterKey);

  const unwrapped = unwrapBitwardenUserKey(protectedUserKey, masterKey);
  assert.deepEqual(unwrapped.encKey, userKeyBytes.subarray(0, 32));
  assert.deepEqual(unwrapped.macKey, userKeyBytes.subarray(32, 64));

  // A stretched key must not be used for the legacy form: the choice is made
  // by the encryption type, not by guessing.
  const stretched = Buffer.concat([expand(masterKey, "enc"), expand(masterKey, "mac")]);
  assert.throws(
    () => unwrapBitwardenUserKey(sealType0(userKeyBytes, stretched.subarray(0, 32)), masterKey),
    (error: unknown) => error instanceof BitwardenCryptoError,
  );
});

test("unwraps a per-item key wrapped by another symmetric key", () => {
  const userKey = crypto.randomBytes(64);
  const itemKey = crypto.randomBytes(64);
  const unwrapped = unwrapBitwardenSymmetricKey(sealType2(itemKey, userKey), {
    encKey: userKey.subarray(0, 32),
    macKey: userKey.subarray(32, 64),
  });
  assert.deepEqual(unwrapped.encKey, itemKey.subarray(0, 32));
  assert.deepEqual(unwrapped.macKey, itemKey.subarray(32, 64));
});

test("recovers the account private key and unwraps an organization key with it", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const userKeyBytes = crypto.randomBytes(64);
  const userKey = {
    encKey: userKeyBytes.subarray(0, 32),
    macKey: userKeyBytes.subarray(32, 64),
  };
  const der = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const recovered = unwrapBitwardenPrivateKey(sealType2(der, userKeyBytes), userKey);

  const organizationKeyBytes = crypto.randomBytes(64);
  const wrapped = `4.${crypto
    .publicEncrypt(
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" },
      organizationKeyBytes,
    )
    .toString("base64")}`;

  const organizationKey = unwrapBitwardenOrganizationKey(wrapped, recovered);
  assert.deepEqual(organizationKey.encKey, organizationKeyBytes.subarray(0, 32));
  assert.deepEqual(organizationKey.macKey, organizationKeyBytes.subarray(32, 64));

  // A private key that is not really a key must be reported, not returned.
  assert.throws(
    () => unwrapBitwardenPrivateKey(sealType2(Buffer.from("not a key"), userKeyBytes), userKey),
    (error: unknown) =>
      error instanceof BitwardenCryptoError &&
      /private key could not be read/i.test((error as Error).message),
  );
});
