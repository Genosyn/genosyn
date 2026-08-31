import crypto from "node:crypto";

/**
 * Bitwarden's `EncString` wire format, and the two decryption primitives every
 * other module here is built from.
 *
 * A Bitwarden vault is end-to-end encrypted: the server stores only opaque
 * strings shaped `<type>.<part>|<part>|<part>`, and a client that wants to read
 * an item has to reproduce the same key hierarchy the official clients use.
 * This module is the bottom of that stack — it knows nothing about accounts,
 * HTTP, or ciphers, only how to turn one string plus one key into bytes.
 *
 * Two details are easy to get wrong and are therefore stated here rather than
 * left to the reader:
 *
 *  - The MAC covers `iv || ct` and is verified **before** the ciphertext is
 *    decrypted. Decrypt-then-verify would turn every malformed row into a
 *    padding oracle.
 *  - Bitwarden stretches a key with HKDF **Expand only** (RFC 5869 §2.3),
 *    treating the 32-byte master key as the PRK. `crypto.hkdfSync` performs
 *    Extract *and* Expand and produces different bytes, so it cannot be used.
 *    See {@link hkdfExpand}.
 */

/** A symmetric Bitwarden key: 32 bytes (encrypt-only) or 64 bytes (enc || mac). */
export type BitwardenSymmetricKey = {
  encKey: Buffer;
  /** Null only for the legacy 32-byte, MAC-less form. */
  macKey: Buffer | null;
};

export class BitwardenCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BitwardenCryptoError";
  }
}

const IV_BYTES = 16;
const MAC_BYTES = 32;

/**
 * RFC 5869 §2.3 HKDF-Expand with SHA-256, with the PRK supplied directly.
 *
 * Node's `crypto.hkdfSync` always runs Extract first. Bitwarden does not, so
 * using it here would derive a different — and silently wrong — key.
 */
export function hkdfExpand(prk: Buffer, info: string, length: number): Buffer {
  const hashLength = 32;
  const blocks = Math.ceil(length / hashLength);
  if (blocks < 1 || blocks > 255) throw new BitwardenCryptoError("Invalid HKDF output length");
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  for (let index = 1; index <= blocks; index += 1) {
    previous = crypto
      .createHmac("sha256", prk)
      .update(Buffer.concat([previous, Buffer.from(info, "utf8"), Buffer.from([index])]))
      .digest();
    chunks.push(previous);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

/**
 * Split raw key material into the shape Bitwarden expects.
 *
 * 64 bytes is the only form that can carry a MAC, and it is what every user
 * key, organization key and per-item key decrypts to. 32 bytes appears only as
 * KDF-derived unlock material or on very old accounts.
 */
export function symmetricKeyFromBytes(bytes: Buffer): BitwardenSymmetricKey {
  if (bytes.length === 64) {
    return { encKey: bytes.subarray(0, 32), macKey: bytes.subarray(32, 64) };
  }
  if (bytes.length === 32) return { encKey: bytes, macKey: null };
  throw new BitwardenCryptoError(`Unsupported Bitwarden key length (${bytes.length} bytes)`);
}

/** Stretch a 32-byte KDF-derived key into the 64-byte wrapping key. */
export function stretchKey(key: Buffer): BitwardenSymmetricKey {
  if (key.length !== 32) throw new BitwardenCryptoError("Only a 32-byte key can be stretched");
  return { encKey: hkdfExpand(key, "enc", 32), macKey: hkdfExpand(key, "mac", 32) };
}

export type ParsedEncString = {
  type: number;
  parts: string[];
};

/**
 * Parse the `<type>.<part>|<part>` envelope.
 *
 * A string with no `<type>.` header is a legacy value: two pipe-separated
 * parts mean type 0. Base64 never contains a `.`, so splitting on it is
 * unambiguous.
 */
export function parseEncString(value: string): ParsedEncString {
  const trimmed = value.trim();
  if (!trimmed) throw new BitwardenCryptoError("Empty Bitwarden encrypted string");
  const headerParts = trimmed.split(".");
  if (headerParts.length === 2) {
    const type = Number.parseInt(headerParts[0], 10);
    if (!Number.isInteger(type)) throw new BitwardenCryptoError("Unreadable encrypted-string type");
    return { type, parts: headerParts[1].split("|") };
  }
  const parts = trimmed.split("|");
  if (parts.length === 2) return { type: 0, parts };
  throw new BitwardenCryptoError("Unreadable Bitwarden encrypted string");
}

function decodeBase64(value: string, label: string): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) throw new BitwardenCryptoError(`Empty ${label} in encrypted string`);
  return decoded;
}

/**
 * Decrypt one symmetric `EncString` (type 0 or 2) with the supplied key.
 *
 * Type 2 is everything a modern vault contains. Type 0 survives only as the
 * protected user key of accounts that predate authenticated encryption, and is
 * accepted for exactly that reason.
 *
 * **The encryption type must match the key**, in both directions. An
 * authenticated key refusing an unauthenticated value is not pedantry: AES-CBC
 * carries no integrity of its own, so a server that holds only ciphertext can
 * relabel a genuine `2.iv|ct|mac` value as `0.iv'|ct` and XOR the IV to make
 * the first plaintext block decrypt to anything it likes. Every later block and
 * the padding still verify. Applied to a Login's saved URI that rewrites the
 * one origin the Browser is allowed to type the password into — which is to say
 * it turns the vault into a phishing channel. Bitwarden's own client makes the
 * same check for the same reason.
 */
export function decryptEncString(value: string, key: BitwardenSymmetricKey): Buffer {
  const { type, parts } = parseEncString(value);
  if (type === 0) {
    if (key.macKey) {
      throw new BitwardenCryptoError(
        "A Bitwarden value without authentication cannot be read with an authenticated key",
      );
    }
    if (parts.length !== 2) throw new BitwardenCryptoError("Malformed AES-CBC encrypted string");
    const iv = decodeBase64(parts[0], "IV");
    const ciphertext = decodeBase64(parts[1], "ciphertext");
    if (iv.length !== IV_BYTES) throw new BitwardenCryptoError("Bad IV length");
    return aesCbcDecrypt(key.encKey, iv, ciphertext);
  }
  if (type === 2) {
    if (parts.length !== 3)
      throw new BitwardenCryptoError("Malformed AES-CBC-HMAC encrypted string");
    if (!key.macKey) {
      throw new BitwardenCryptoError("An authenticated Bitwarden value needs a 64-byte key");
    }
    const iv = decodeBase64(parts[0], "IV");
    const ciphertext = decodeBase64(parts[1], "ciphertext");
    const mac = decodeBase64(parts[2], "MAC");
    if (iv.length !== IV_BYTES) throw new BitwardenCryptoError("Bad IV length");
    if (mac.length !== MAC_BYTES) throw new BitwardenCryptoError("Bad MAC length");
    const expected = crypto.createHmac("sha256", key.macKey).update(iv).update(ciphertext).digest();
    if (!crypto.timingSafeEqual(expected, mac)) {
      throw new BitwardenCryptoError("Bitwarden integrity check failed");
    }
    return aesCbcDecrypt(key.encKey, iv, ciphertext);
  }
  if (type === 7) {
    throw new BitwardenCryptoError(
      "This Bitwarden item uses the newer COSE encryption Genosyn cannot read yet",
    );
  }
  throw new BitwardenCryptoError(`Unsupported Bitwarden encryption type ${type}`);
}

function aesCbcDecrypt(encKey: Buffer, iv: Buffer, ciphertext: Buffer): Buffer {
  if (encKey.length !== 32) throw new BitwardenCryptoError("Bad AES key length");
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new BitwardenCryptoError("Bad ciphertext length");
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-cbc", encKey, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BitwardenCryptoError("A Bitwarden value could not be decrypted");
  }
}

/** Decrypt a symmetric `EncString` and return it as UTF-8 text. */
export function decryptEncStringToText(value: string, key: BitwardenSymmetricKey): string {
  return decryptEncString(value, key).toString("utf8");
}

/**
 * Decrypt an RSA-encapsulated `EncString` (types 3-6) with the account's
 * private key.
 *
 * Types 5 and 6 append a MAC that the official clients parse and then ignore;
 * we do the same rather than inventing a check no writer produces.
 */
export function decryptAsymmetricEncString(value: string, privateKey: crypto.KeyObject): Buffer {
  const { type, parts } = parseEncString(value);
  const oaepHash = type === 3 || type === 5 ? "sha256" : "sha1";
  if (type !== 3 && type !== 4 && type !== 5 && type !== 6) {
    throw new BitwardenCryptoError(`Unsupported Bitwarden RSA encryption type ${type}`);
  }
  const ciphertext = decodeBase64(parts[0], "ciphertext");
  try {
    return crypto.privateDecrypt(
      { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash },
      ciphertext,
    );
  } catch {
    throw new BitwardenCryptoError("A Bitwarden organization key could not be decrypted");
  }
}
