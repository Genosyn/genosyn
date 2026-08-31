import crypto from "node:crypto";
import { promisify } from "node:util";
import { argon2id } from "hash-wasm";

import {
  BitwardenCryptoError,
  type BitwardenSymmetricKey,
  decryptAsymmetricEncString,
  decryptEncString,
  parseEncString,
  stretchKey,
  symmetricKeyFromBytes,
} from "./encString.js";

/**
 * The Bitwarden key hierarchy, from a master password down to the keys that
 * decrypt individual vault items.
 *
 * ```
 *   master password + email  --KDF-->  master key (32 bytes)
 *   master key               --HKDF->  stretched key (64) --unwraps--> user key (64)
 *   user key                 --unwraps--> RSA private key --unwraps--> organization keys (64)
 *   user/organization key    --unwraps--> per-item key (64), when the item has one
 * ```
 *
 * The master key is *never* used to decrypt vault content directly, and the
 * hash sent to the server is deliberately a different derivation from the key
 * that unwraps the vault — the server must never learn anything that unlocks
 * the ciphertext it stores.
 */

/** Bitwarden's KDF discriminator, as returned by `prelogin`. */
export const BITWARDEN_KDF_PBKDF2 = 0;
export const BITWARDEN_KDF_ARGON2ID = 1;

export type BitwardenKdf = {
  kind: typeof BITWARDEN_KDF_PBKDF2 | typeof BITWARDEN_KDF_ARGON2ID;
  iterations: number;
  /** Argon2id only, in MiB. */
  memory: number | null;
  /** Argon2id only. */
  parallelism: number | null;
};

/**
 * Bounds on what a server may ask for, in both directions.
 *
 * The lower bounds are the official clients' downgrade protection: a server
 * that answers `prelogin` with one PBKDF2 round could otherwise make the
 * derived key trivially brute-forceable. The upper bounds matter just as much
 * here, because unlike a desktop client this runs on a shared server — an
 * unbounded iteration count is a denial of service the operator did not choose,
 * paid for by every other request. Both ends match Bitwarden's own accepted
 * ranges.
 */
const MIN_PBKDF2_ITERATIONS = 5_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const MIN_ARGON2_ITERATIONS = 2;
const MAX_ARGON2_ITERATIONS = 10;
const MIN_ARGON2_MEMORY_MIB = 15;
const MAX_ARGON2_MEMORY_MIB = 1024;
const MIN_ARGON2_PARALLELISM = 1;
const MAX_ARGON2_PARALLELISM = 16;

/**
 * 600,000 PBKDF2 rounds is a fifth of a second of pure CPU. Running it on the
 * threadpool keeps one Vault reveal from stalling every other request in the
 * process. (Argon2id below is WASM and unavoidably synchronous; it is paid once
 * per unlock and then cached.)
 */
const pbkdf2 = promisify(crypto.pbkdf2);

/** Bitwarden salts the KDF with the account email, trimmed and lowercased. */
export function normalizeBitwardenEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function assertUsableKdf(kdf: BitwardenKdf): void {
  if (kdf.kind === BITWARDEN_KDF_PBKDF2) {
    if (
      !Number.isInteger(kdf.iterations) ||
      kdf.iterations < MIN_PBKDF2_ITERATIONS ||
      kdf.iterations > MAX_PBKDF2_ITERATIONS
    ) {
      throw new BitwardenCryptoError(
        "The Bitwarden server reported a PBKDF2 iteration count outside the accepted range",
      );
    }
    return;
  }
  if (
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < MIN_ARGON2_ITERATIONS ||
    kdf.iterations > MAX_ARGON2_ITERATIONS ||
    !Number.isInteger(kdf.memory) ||
    (kdf.memory ?? 0) < MIN_ARGON2_MEMORY_MIB ||
    (kdf.memory ?? 0) > MAX_ARGON2_MEMORY_MIB ||
    !Number.isInteger(kdf.parallelism) ||
    (kdf.parallelism ?? 0) < MIN_ARGON2_PARALLELISM ||
    (kdf.parallelism ?? 0) > MAX_ARGON2_PARALLELISM
  ) {
    throw new BitwardenCryptoError("The Bitwarden server reported unsafe Argon2id parameters");
  }
}

/**
 * Derive the 32-byte master key.
 *
 * Argon2id salts with `SHA-256(email)` rather than the email itself, and the
 * reported memory is MiB where Argon2 wants KiB. Both are silent-wrong-answer
 * traps rather than errors, so they are done in one place.
 */
export async function deriveBitwardenMasterKey(
  masterPassword: string,
  email: string,
  kdf: BitwardenKdf,
): Promise<Buffer> {
  assertUsableKdf(kdf);
  const salt = normalizeBitwardenEmail(email);
  if (kdf.kind === BITWARDEN_KDF_PBKDF2) {
    return pbkdf2(masterPassword, salt, kdf.iterations, 32, "sha256");
  }
  const derived = await argon2id({
    password: masterPassword,
    salt: crypto.createHash("sha256").update(salt, "utf8").digest(),
    iterations: kdf.iterations,
    memorySize: (kdf.memory ?? 0) * 1024,
    parallelism: kdf.parallelism ?? 1,
    hashLength: 32,
    outputType: "binary",
  });
  return Buffer.from(derived);
}

/**
 * The value sent to the server as the password.
 *
 * Note the inversion: the master key is the PBKDF2 *password* and the typed
 * master password is the *salt*, over a single round. Anything else here
 * either fails to authenticate or leaks the unlock key to the server.
 */
export function deriveBitwardenPasswordHash(masterKey: Buffer, masterPassword: string): string {
  return crypto.pbkdf2Sync(masterKey, masterPassword, 1, 32, "sha256").toString("base64");
}

/**
 * Unwrap the account's user key.
 *
 * Which path applies is decided by the encryption type of the stored value,
 * not by any key length: a legacy type-0 user key is unwrapped with the raw
 * master key, everything else with the stretched key.
 */
export function unwrapBitwardenUserKey(
  protectedUserKey: string,
  masterKey: Buffer,
): BitwardenSymmetricKey {
  const { type } = parseEncString(protectedUserKey);
  const wrappingKey = type === 0 ? symmetricKeyFromBytes(masterKey) : stretchKey(masterKey);
  return symmetricKeyFromBytes(decryptEncString(protectedUserKey, wrappingKey));
}

/** Unwrap a key that was itself wrapped by another symmetric key. */
export function unwrapBitwardenSymmetricKey(
  wrapped: string,
  wrappingKey: BitwardenSymmetricKey,
): BitwardenSymmetricKey {
  return symmetricKeyFromBytes(decryptEncString(wrapped, wrappingKey));
}

/** Recover the account's RSA private key, which unwraps organization keys. */
export function unwrapBitwardenPrivateKey(
  protectedPrivateKey: string,
  userKey: BitwardenSymmetricKey,
): crypto.KeyObject {
  const der = decryptEncString(protectedPrivateKey, userKey);
  try {
    return crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new BitwardenCryptoError("The Bitwarden account private key could not be read");
  }
}

/** Unwrap one organization key from its RSA-encapsulated form. */
export function unwrapBitwardenOrganizationKey(
  wrapped: string,
  privateKey: crypto.KeyObject,
): BitwardenSymmetricKey {
  return symmetricKeyFromBytes(decryptAsymmetricEncString(wrapped, privateKey));
}
