import crypto from "node:crypto";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";

/**
 * Enterprise licenses (M56) — offline-verifiable Ed25519-signed keys.
 *
 * A license is `genlic1.<base64url(payloadJSON)>.<base64url(signature)>`,
 * where the signature is Ed25519 over the UTF-8 bytes of the base64url
 * payload segment. A self-hosted install verifies the key against the public
 * keys embedded below — no network call, no phone-home. The issuing side
 * (Genosyn's own cloud install, Admin → Enterprise Licenses) signs with a
 * private key stored encrypted in `AppSetting` and never embedded anywhere.
 *
 * Expiry semantics: SOFT for paid licenses (features stay on past expiry; the
 * UI shows an expired warning) and HARD for evaluation licenses (an expired
 * evaluation is treated as no license). A paying customer must never lose SSO
 * the day a renewal slips; an eval must stay honest.
 */

/** Database key for the raw license key string on a self-hosted install. */
export const LICENSE_KEY_SETTING = "license.key";
/** Database key for the issuer's encrypted Ed25519 private key (PEM). */
export const LICENSE_SIGNING_KEY_SETTING = "license.signingPrivateKey";

const LICENSE_PREFIX = "genlic1";

/**
 * Ed25519 public keys (standard base64, DER/SPKI) that this build trusts to
 * have signed a license. Multiple entries support rotation — a key is valid
 * if ANY listed key verifies it.
 *
 * To mint a keypair: run `npm run license:keygen`, commit the printed public
 * key into this array, and keep the private key out of the repo (paste it at
 * Admin → Enterprise Licenses on the issuing install only).
 */
export const LICENSE_VERIFY_PUBLIC_KEYS: readonly string[] = [
  // genosyn.com production signing key, minted 2026-08 for M56.
  "MCowBQYDK2VwAyEAYHmdLdBK9vPSaMKfuNhpezMxCFEqkctu4xj/g68WbTA=",
];

export type LicensePayload = {
  v: 1;
  id: string;
  company: string;
  email: string | null;
  issuedAt: string;
  expiresAt: string;
  seats: number | null;
  evaluation: boolean;
};

export type InstanceLicenseStatus = {
  status: "none" | "valid" | "expired" | "invalid";
  payload: LicensePayload | null;
  /** Whether enterprise features are unlocked: signature ok AND (not expired
   * OR not an evaluation) — soft expiry for paid, hard for evaluation. */
  featureValid: boolean;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function parsePayloadJson(raw: string): LicensePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (o.v !== 1) return null;
  if (typeof o.id !== "string" || !o.id) return null;
  if (typeof o.company !== "string" || !o.company) return null;
  if (o.email !== null && typeof o.email !== "string") return null;
  if (typeof o.issuedAt !== "string" || Number.isNaN(Date.parse(o.issuedAt))) return null;
  if (typeof o.expiresAt !== "string" || Number.isNaN(Date.parse(o.expiresAt))) return null;
  if (o.seats !== null && (typeof o.seats !== "number" || !Number.isInteger(o.seats))) return null;
  if (typeof o.evaluation !== "boolean") return null;
  return {
    v: 1,
    id: o.id,
    company: o.company,
    email: o.email,
    issuedAt: o.issuedAt,
    expiresAt: o.expiresAt,
    seats: o.seats,
    evaluation: o.evaluation,
  };
}

/** Sign a payload with an Ed25519 private key (PKCS8 PEM) into a full key. */
export function signLicense(privateKeyPem: string, payload: LicensePayload): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const payloadSegment = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const signature = crypto.sign(null, Buffer.from(payloadSegment, "utf8"), key);
  return `${LICENSE_PREFIX}.${payloadSegment}.${b64url(signature)}`;
}

/**
 * Decode a key WITHOUT verifying the signature — for display and for error
 * messages. `valid` here only means "the payload decodes to the documented
 * shape"; trust requires {@link verifyLicenseKeyWith}.
 */
export function parseLicenseKey(
  key: string,
): { payload: LicensePayload; valid: boolean } | null {
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return null;
  let raw: string;
  try {
    raw = Buffer.from(parts[1], "base64url").toString("utf8");
  } catch {
    return null;
  }
  const payload = parsePayloadJson(raw);
  if (!payload) return null;
  return { payload, valid: true };
}

/**
 * Verify a key against an explicit list of base64 SPKI Ed25519 public keys.
 * Returns the trusted payload, or null when the format is wrong or no key in
 * the list verifies the signature. Pure — the embedded-list wrapper and the
 * tests both call this.
 */
export function verifyLicenseKeyWith(
  publicKeys: readonly string[],
  key: string,
): { payload: LicensePayload } | null {
  const parts = key.trim().split(".");
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) return null;
  const payloadSegment = parts[1];
  let signature: Buffer;
  try {
    signature = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (signature.length === 0) return null;
  const data = Buffer.from(payloadSegment, "utf8");
  let verified = false;
  for (const publicKey of publicKeys) {
    try {
      const keyObject = crypto.createPublicKey({
        key: Buffer.from(publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      if (crypto.verify(null, data, keyObject, signature)) {
        verified = true;
        break;
      }
    } catch {
      // A malformed key in the list must not mask a later valid one.
    }
  }
  if (!verified) return null;
  const payload = parsePayloadJson(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  if (!payload) return null;
  return { payload };
}

/** Verify against the embedded {@link LICENSE_VERIFY_PUBLIC_KEYS}. */
export function verifyLicenseKey(key: string): { payload: LicensePayload } | null {
  return verifyLicenseKeyWith(effectiveVerifyKeys(), key);
}

/** `genlic1.abcd…wxyz` — enough to recognise a key, never enough to use it. */
export function maskLicenseKey(key: string): string {
  const trimmed = key.trim();
  const dot = trimmed.indexOf(".");
  const body = dot >= 0 ? trimmed.slice(dot + 1) : trimmed;
  if (body.length <= 8) return `${LICENSE_PREFIX}.••••`;
  return `${LICENSE_PREFIX}.${body.slice(0, 4)}…${body.slice(-4)}`;
}

export function isLicenseExpired(payload: LicensePayload, now = new Date()): boolean {
  return Date.parse(payload.expiresAt) <= now.getTime();
}

// ─────────────────── instance license state (DB-backed) ────────────────────

// Test seam: route tests cannot commit a public key into the shipped array,
// so they inject an ephemeral one here. Never set outside tests.
let verifyKeysOverride: readonly string[] | null = null;

export function _setVerifyKeysForTest(keys: readonly string[] | null): void {
  verifyKeysOverride = keys;
  invalidateLicenseCache();
}

function effectiveVerifyKeys(): readonly string[] {
  return verifyKeysOverride ?? LICENSE_VERIFY_PUBLIC_KEYS;
}

const CACHE_TTL_MS = 30_000;
let cachedStatus: InstanceLicenseStatus | null = null;
let cachedAt = 0;

export function invalidateLicenseCache(): void {
  cachedStatus = null;
  cachedAt = 0;
}

function statusFor(key: string | null): InstanceLicenseStatus {
  if (!key) return { status: "none", payload: null, featureValid: false };
  const verified = verifyLicenseKey(key);
  if (!verified) {
    // Show what the key claims even when we don't trust it, so the admin page
    // can say WHICH key is bad rather than shrugging.
    const parsed = parseLicenseKey(key);
    return { status: "invalid", payload: parsed?.payload ?? null, featureValid: false };
  }
  const expired = isLicenseExpired(verified.payload);
  return {
    status: expired ? "expired" : "valid",
    payload: verified.payload,
    // Soft expiry for paid licenses, hard for evaluations.
    featureValid: !expired || !verified.payload.evaluation,
  };
}

/**
 * The install's license status, memoized for 30s (the `publicUrl` pattern) so
 * per-request entitlement resolution never turns into a settings-table scan.
 */
export async function getInstanceLicense(): Promise<InstanceLicenseStatus> {
  const now = Date.now();
  if (cachedStatus && now - cachedAt < CACHE_TTL_MS) return cachedStatus;
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({
    key: LICENSE_KEY_SETTING,
  });
  cachedStatus = statusFor(row?.value ?? null);
  cachedAt = now;
  return cachedStatus;
}

async function upsertSetting(key: string, value: string): Promise<void> {
  const repo = AppDataSource.getRepository(AppSetting);
  const existing = await repo.findOneBy({ key });
  if (existing) {
    existing.value = value;
    await repo.save(existing);
  } else {
    await repo.save(repo.create({ key, value }));
  }
}

export async function setInstanceLicenseKey(key: string): Promise<void> {
  await upsertSetting(LICENSE_KEY_SETTING, key.trim());
  invalidateLicenseCache();
}

export async function clearInstanceLicenseKey(): Promise<void> {
  await AppDataSource.getRepository(AppSetting).delete({ key: LICENSE_KEY_SETTING });
  invalidateLicenseCache();
}

// ──────────────────────── issuer signing key ────────────────────────────────

export async function getSigningPrivateKey(): Promise<string | null> {
  const row = await AppDataSource.getRepository(AppSetting).findOneBy({
    key: LICENSE_SIGNING_KEY_SETTING,
  });
  if (!row?.value) return null;
  try {
    return decryptSecret(row.value);
  } catch {
    // A rotated encryption key makes the PEM unreadable — report "not
    // configured" so the admin re-pastes it rather than issuance 500ing.
    // eslint-disable-next-line no-console
    console.warn(
      "[license] could not decrypt the stored signing key (was the encryption key rotated?) — re-enter it at Admin → Enterprise Licenses",
    );
    return null;
  }
}

/**
 * Store the issuer's private key, first proving it is a usable Ed25519 key by
 * signing a probe — a bad paste fails here, not at the first issuance.
 */
export async function setSigningPrivateKey(pem: string): Promise<void> {
  let keyObject: crypto.KeyObject;
  try {
    keyObject = crypto.createPrivateKey(pem);
  } catch {
    throw new Error("That is not a valid PEM private key");
  }
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw new Error("The signing key must be an Ed25519 private key");
  }
  crypto.sign(null, Buffer.from("probe", "utf8"), keyObject);
  await upsertSetting(LICENSE_SIGNING_KEY_SETTING, encryptSecret(pem));
}

export async function clearSigningPrivateKey(): Promise<void> {
  await AppDataSource.getRepository(AppSetting).delete({
    key: LICENSE_SIGNING_KEY_SETTING,
  });
}
