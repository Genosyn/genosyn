/**
 * Reading the QR code Google Authenticator's "Transfer accounts" shows.
 *
 * Moving a site's two-factor into a Vault normally means turning it off and on again to
 * get a fresh QR code, which is a chore, and sometimes needs a support ticket. People
 * who already have the account in Google Authenticator don't have to: its export QR
 * holds the setup keys, as `otpauth-migration://offline?data=<protobuf>`. This reads
 * that format and turns each account into an ordinary `otpauth://` URI, which is what
 * the Vault already takes. Nothing here leaves the browser it runs in.
 *
 * The format, for the fields this reads:
 *
 *   MigrationPayload { repeated OtpParameters otp_parameters = 1; ... }
 *   OtpParameters {
 *     bytes secret = 1; string name = 2; string issuer = 3;
 *     Algorithm algorithm = 4;  // 1 SHA1, 2 SHA256, 3 SHA512, 4 MD5
 *     DigitCount digits = 5;    // 1 six, 2 eight
 *     OtpType type = 6;         // 1 HOTP, 2 TOTP
 *     int64 counter = 7;
 *   }
 *
 * An account the Vault can't use, a counter-based one or one on MD5, is left out rather
 * than turned into something that would generate wrong codes.
 */

export type MigratedAuthenticator = {
  /** What a person recognises it by: `issuer (account)`. */
  label: string;
  /** An ordinary `otpauth://totp/` URI for the Vault's setup key field. */
  uri: string;
};

export function isOtpauthMigrationUri(value: string): boolean {
  return value.trim().toLowerCase().startsWith("otpauth-migration://");
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

class Reader {
  private at = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get done(): boolean {
    return this.at >= this.bytes.length;
  }
  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.at >= this.bytes.length || shift > 63) throw new Error("Truncated varint");
      const byte = this.bytes[this.at++];
      // Past 2^53 only the counter could be this long, and nothing here reads that.
      if (shift < 49) result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  }
  chunk(): Uint8Array {
    const length = this.varint();
    if (length > this.bytes.length - this.at) throw new Error("Truncated field");
    const out = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }
  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 2) this.chunk();
    else if (wireType === 1) this.at += 8;
    else if (wireType === 5) this.at += 4;
    else throw new Error("Unknown wire type");
  }
}

type Parameters = {
  secret: Uint8Array | null;
  name: string;
  issuer: string;
  algorithm: number;
  digits: number;
  type: number;
};

function readParameters(bytes: Uint8Array): Parameters {
  const reader = new Reader(bytes);
  const text = new TextDecoder();
  const out: Parameters = { secret: null, name: "", issuer: "", algorithm: 0, digits: 0, type: 0 };
  while (!reader.done) {
    const tag = reader.varint();
    const field = Math.floor(tag / 8);
    const wire = tag % 8;
    if (field === 1 && wire === 2) out.secret = reader.chunk();
    else if (field === 2 && wire === 2) out.name = text.decode(reader.chunk());
    else if (field === 3 && wire === 2) out.issuer = text.decode(reader.chunk());
    else if (field === 4 && wire === 0) out.algorithm = reader.varint();
    else if (field === 5 && wire === 0) out.digits = reader.varint();
    else if (field === 6 && wire === 0) out.type = reader.varint();
    else reader.skip(wire);
  }
  return out;
}

const ALGORITHMS: Record<number, string> = { 0: "SHA1", 1: "SHA1", 2: "SHA256", 3: "SHA512" };

function toUri(row: Parameters): MigratedAuthenticator | null {
  if (!row.secret || row.secret.length === 0) return null;
  if (row.type !== 0 && row.type !== 2) return null;
  const algorithm = ALGORITHMS[row.algorithm];
  if (!algorithm) return null;
  const digits = row.digits === 2 ? 8 : 6;
  // An exported name is often already `Issuer:account`, which the Vault reads too.
  const separator = row.name.indexOf(":");
  const issuer = row.issuer.trim() || (separator > 0 ? row.name.slice(0, separator).trim() : "");
  const account = (separator > 0 ? row.name.slice(separator + 1) : row.name).trim();
  const label = issuer ? `${issuer}:${account}` : account;
  const query = new URLSearchParams({ secret: base32(row.secret) });
  if (issuer) query.set("issuer", issuer);
  query.set("algorithm", algorithm);
  query.set("digits", String(digits));
  query.set("period", "30");
  return {
    label: issuer && account ? `${issuer} (${account})` : issuer || account || "Unnamed account",
    uri: `otpauth://totp/${encodeURIComponent(label)}?${query.toString()}`,
  };
}

/** Each account in an export QR the Vault can use. Throws on something that isn't one. */
export function readOtpauthMigrationUri(value: string): MigratedAuthenticator[] {
  const url = new URL(value.trim());
  const data = url.searchParams.get("data");
  if (url.protocol !== "otpauth-migration:" || !data) {
    throw new Error("That isn't a Google Authenticator export code.");
  }
  // `URLSearchParams` reads a raw `+` as a space, and exporters don't all escape it.
  const decoded = atob(data.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const reader = new Reader(bytes);
  const accounts: MigratedAuthenticator[] = [];
  while (!reader.done) {
    const tag = reader.varint();
    if (Math.floor(tag / 8) === 1 && tag % 8 === 2) {
      const account = toUri(readParameters(reader.chunk()));
      if (account) accounts.push(account);
    } else {
      reader.skip(tag % 8);
    }
  }
  return accounts;
}
