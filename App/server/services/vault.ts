import crypto from "node:crypto";
import { createGuardrails, generate as generateOtp } from "otplib";
import { In } from "typeorm";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import {
  EMPLOYEE_VAULT_ACCESS_RANK,
  EmployeeVaultGrant,
  type EmployeeVaultAccessLevel,
} from "../db/entities/EmployeeVaultGrant.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import {
  VaultItem,
  type VaultItemType,
  type VaultItemVisibility,
} from "../db/entities/VaultItem.js";
import {
  VaultItemMemberAccess,
  type VaultMemberAccessLevel,
} from "../db/entities/VaultItemMemberAccess.js";
import { decryptSecretWithStrongKeys, encryptSecret } from "../lib/secret.js";

const vaultTotpAlgorithmSchema = z.enum(["sha1", "sha256", "sha512"]);

const vaultTotpSchema = z
  .object({
    secret: z.string().min(1).max(128),
    issuer: z.string().max(255),
    accountName: z.string().max(500),
    algorithm: vaultTotpAlgorithmSchema,
    digits: z.union([z.literal(6), z.literal(7), z.literal(8)]),
    period: z.number().int().min(15).max(120),
  })
  .strict();

export type VaultTotp = z.infer<typeof vaultTotpSchema>;

const passkeyBinarySchema = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9+/_-]+={0,2}$/);

const vaultPasskeyCredentialSchema = z
  .object({
    id: z.string().uuid(),
    credentialId: passkeyBinarySchema,
    isResidentCredential: z.boolean(),
    rpId: z.string().min(1).max(253),
    privateKey: passkeyBinarySchema,
    userHandle: z.string().max(4096).optional(),
    signCount: z.number().int().min(0).max(0xffffffff),
    largeBlob: z.string().max(131_072).optional(),
    backupEligibility: z.boolean().optional(),
    backupState: z.boolean().optional(),
    userName: z.string().max(500).optional(),
    userDisplayName: z.string().max(500).optional(),
    createdAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().nullable(),
  })
  .strict();
const vaultStoredPasskeySchema = vaultPasskeyCredentialSchema.extend({
  // The lease lives inside the encrypted, versioned payload so every App
  // process contends through the same SQLite/Postgres compare-and-swap.
  useLeaseId: z.string().uuid().nullable().default(null),
  useLeaseExpiresAt: z.string().datetime().nullable().default(null),
});
const vaultPasskeyRegistrationLeaseSchema = z
  .object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    websiteOrigin: z.string().min(1).max(2048),
    expiresAt: z.string().datetime(),
  })
  .strict();
type VaultPasskeyRegistrationLease = z.infer<typeof vaultPasskeyRegistrationLeaseSchema>;
const vaultPasskeyCredentialInputSchema = vaultPasskeyCredentialSchema.omit({
  id: true,
  createdAt: true,
  lastUsedAt: true,
});

/**
 * Sensitive CDP-compatible passkey material. This type is intentionally
 * exported only for server-owned browser plumbing; values must never cross an
 * HTTP, MCP, model, audit, transcript, error, or logging boundary.
 */
export type VaultPasskeyCredential = z.infer<typeof vaultPasskeyCredentialSchema>;
type VaultStoredPasskey = z.infer<typeof vaultStoredPasskeySchema>;
export type VaultPasskeyCredentialInput = Omit<
  VaultPasskeyCredential,
  "id" | "createdAt" | "lastUsedAt"
>;

export type VaultPasskeyView = Pick<
  VaultPasskeyCredential,
  "id" | "rpId" | "userName" | "userDisplayName"
> & {
  createdAt: Date;
  lastUsedAt: Date | null;
};

const vaultPayloadSchema = z
  .object({
    title: z.string(),
    username: z.string(),
    secret: z.string(),
    websiteUrl: z.string(),
    notes: z.string(),
    // Defaults are applied while decrypting old ciphertext, so adding these
    // authenticators requires no database column or ciphertext migration.
    totp: vaultTotpSchema.nullable().default(null),
    passkeys: z.array(vaultStoredPasskeySchema).max(32).default([]),
    passkeyRegistrationLease: vaultPasskeyRegistrationLeaseSchema.nullable().default(null),
  })
  .strict();

export type VaultPayload = z.infer<typeof vaultPayloadSchema>;

const VAULT_PASSWORD_CHARACTER_CLASSES = [
  "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "abcdefghijklmnopqrstuvwxyz",
  "0123456789",
  "!@#$%^&*()-_=+[]{}:,.?",
] as const;
const VAULT_PASSWORD_ALPHABET = VAULT_PASSWORD_CHARACTER_CLASSES.join("");
const DEFAULT_VAULT_PASSWORD_LENGTH = 24;
const VAULT_TOTP_GUARDRAILS = createGuardrails({
  // Sixteen Base32 characters (80 bits) remain common on existing services.
  // Accept those imports while bounding retained and processed key material.
  MIN_SECRET_BYTES: 10,
  MAX_SECRET_BYTES: 64,
  MIN_PERIOD: 15,
  MAX_PERIOD: 120,
});
const VAULT_PASSKEY_USE_LEASE_MS = 120_000;
const VAULT_PASSKEY_REGISTRATION_LEASE_MS = 30_000;

export type VaultHumanActor = {
  userId: string;
  role: Role;
};

export type VaultItemView = {
  id: string;
  companyId: string;
  type: VaultItemType;
  visibility: VaultItemVisibility;
  title: string;
  username: string;
  websiteUrl: string;
  notes: string;
  hasTotp: boolean;
  passkeys: VaultPasskeyView[];
  version: number;
  createdByUserId: string | null;
  createdByEmployeeId: string | null;
  createdAt: Date;
  updatedAt: Date;
  effectiveAccessLevel: VaultMemberAccessLevel;
  canEdit: boolean;
  canShare: boolean;
  canDelete: boolean;
  canReveal: boolean;
};

export type VaultPasskeyRegistrationItem = {
  id: string;
  companyId: string;
  type: "login";
  title: string;
  username: string;
  websiteUrl: string;
  version: number;
  createdByEmployeeId: string;
};

export type VaultMemberAccessView = {
  id: string;
  vaultItemId: string;
  userId: string;
  accessLevel: VaultMemberAccessLevel;
  createdAt: Date;
  updatedAt: Date;
  member: {
    id: string;
    name: string;
    email: string;
    role: Role;
  };
};

export type VaultMemberAccessCandidate = {
  id: string;
  name: string;
  email: string;
  role: Role;
  isCreator: boolean;
  access: {
    id: string;
    accessLevel: VaultMemberAccessLevel;
  } | null;
};

export type EmployeeVaultGrantView = {
  id: string;
  vaultItemId: string;
  employeeId: string;
  accessLevel: EmployeeVaultAccessLevel;
  createdAt: Date;
  updatedAt: Date;
  employee: {
    id: string;
    name: string;
    slug: string;
    role: string;
  };
};

export type EmployeeVaultGrantCandidate = {
  id: string;
  name: string;
  slug: string;
  role: string;
  grant: {
    id: string;
    accessLevel: EmployeeVaultAccessLevel;
  } | null;
};

export class VaultError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

/**
 * Generate a cryptographically random password with every standard character
 * class represented. The length bounds keep generated credentials compatible
 * with ordinary password fields while still providing ample entropy.
 */
export function generateVaultPassword(length = DEFAULT_VAULT_PASSWORD_LENGTH): string {
  if (!Number.isInteger(length) || length < 16 || length > 128) {
    throw new VaultError("Password length must be an integer from 16 to 128", 400);
  }

  const characters = VAULT_PASSWORD_CHARACTER_CLASSES.map(
    (characterClass) => characterClass[crypto.randomInt(characterClass.length)],
  );
  while (characters.length < length) {
    characters.push(VAULT_PASSWORD_ALPHABET[crypto.randomInt(VAULT_PASSWORD_ALPHABET.length)]);
  }
  // Fisher-Yates with crypto.randomInt avoids modulo bias and prevents the
  // guaranteed character-class positions from being predictable.
  for (let index = characters.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join("");
}

function encryptionScope(companyId: string): string {
  return `company:${companyId}:vault`;
}

function normalizeVaultWebsiteUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    const website = new URL(trimmed);
    if (website.protocol !== "http:" && website.protocol !== "https:") throw new Error();
    if (website.username || website.password) throw new Error();
    return website.toString();
  } catch {
    throw new VaultError(
      "Website URL must be an absolute http(s) URL without embedded credentials",
      400,
    );
  }
}

function vaultWebsiteOrigin(value: string): string | null {
  if (!value) return null;
  try {
    const website = new URL(value);
    if (website.protocol !== "http:" && website.protocol !== "https:") return null;
    return website.origin;
  } catch {
    return null;
  }
}

function activeVaultPasskeyRegistrationLease(
  payload: VaultPayload,
  at = Date.now(),
): VaultPasskeyRegistrationLease | null {
  const lease = payload.passkeyRegistrationLease;
  if (!lease) return null;
  const expiresAt = Date.parse(lease.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > at ? lease : null;
}

function assertNoActiveVaultPasskeyRegistration(payload: VaultPayload): void {
  if (activeVaultPasskeyRegistrationLease(payload)) {
    throw new VaultError(
      "This Vault login is completing a software passkey registration. Retry after it finishes.",
      409,
    );
  }
}

function requireVaultPasskeyRegistrationLease(
  payload: VaultPayload,
  registrationLeaseId: string,
  employeeId: string,
): VaultPasskeyRegistrationLease {
  const lease = payload.passkeyRegistrationLease;
  // Expiry permits a newer registration to replace an abandoned reservation.
  // A remote ceremony that already completed may still finalize afterward if
  // no newer acquisition replaced its unguessable token.
  if (!lease || lease.id !== registrationLeaseId || lease.employeeId !== employeeId) {
    throw new VaultError(
      "That Vault passkey registration session expired. Start it again safely.",
      409,
    );
  }
  return lease;
}

function normalizeVaultTotpSecret(value: string): string {
  const compact = value.trim().toUpperCase().replace(/[\s-]/g, "");
  const matched = /^([A-Z2-7]+)(=*)$/.exec(compact);
  if (!matched || matched[2].length > 6) {
    throw new VaultError("Enter a valid Base32 TOTP setup key or otpauth URI", 400);
  }
  const secret = matched[1];
  if (![0, 2, 4, 5, 7].includes(secret.length % 8)) {
    throw new VaultError("Enter a valid Base32 TOTP setup key or otpauth URI", 400);
  }

  let accumulator = 0;
  let bitCount = 0;
  let byteCount = 0;
  for (const character of secret) {
    const valueIndex = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
    accumulator = (accumulator << 5) | valueIndex;
    bitCount += 5;
    while (bitCount >= 8) {
      bitCount -= 8;
      byteCount += 1;
      accumulator &= (1 << bitCount) - 1;
    }
  }
  if (bitCount > 0 && accumulator !== 0) {
    throw new VaultError("Enter a valid Base32 TOTP setup key or otpauth URI", 400);
  }
  if (byteCount < 10 || byteCount > 64) {
    throw new VaultError("The TOTP setup key must contain 10 to 64 bytes", 400);
  }
  return secret;
}

function uniqueTotpParameter(uri: URL, name: string): string | null {
  const values = uri.searchParams.getAll(name);
  if (values.length > 1) {
    throw new VaultError("The TOTP setup URI contains duplicate parameters", 400);
  }
  return values[0] ?? null;
}

export function normalizeVaultTotpSetup(setupKey: string): VaultTotp {
  const trimmed = setupKey.trim();
  if (!trimmed || trimmed.length > 4096) {
    throw new VaultError("Enter a valid Base32 TOTP setup key or otpauth URI", 400);
  }
  if (!trimmed.toLowerCase().startsWith("otpauth://")) {
    return {
      secret: normalizeVaultTotpSecret(trimmed),
      issuer: "",
      accountName: "",
      algorithm: "sha1",
      digits: 6,
      period: 30,
    };
  }

  let uri: URL;
  try {
    uri = new URL(trimmed);
  } catch {
    throw new VaultError("Enter a valid Base32 TOTP setup key or otpauth URI", 400);
  }
  if (uri.protocol !== "otpauth:" || uri.hostname.toLowerCase() !== "totp") {
    throw new VaultError("Only time-based otpauth TOTP setup URIs are supported", 400);
  }

  const secret = normalizeVaultTotpSecret(uniqueTotpParameter(uri, "secret") ?? "");
  const rawAlgorithm = (uniqueTotpParameter(uri, "algorithm") ?? "sha1").toLowerCase();
  const algorithm = vaultTotpAlgorithmSchema.safeParse(rawAlgorithm);
  if (!algorithm.success) {
    throw new VaultError("The TOTP algorithm must be SHA1, SHA256, or SHA512", 400);
  }
  const rawDigits = uniqueTotpParameter(uri, "digits") ?? "6";
  if (!/^[678]$/.test(rawDigits)) {
    throw new VaultError("The TOTP code length must be 6, 7, or 8 digits", 400);
  }
  const digits = Number(rawDigits) as 6 | 7 | 8;
  const rawPeriod = uniqueTotpParameter(uri, "period") ?? "30";
  if (!/^\d+$/.test(rawPeriod)) {
    throw new VaultError("The TOTP period must be from 15 to 120 seconds", 400);
  }
  const period = Number(rawPeriod);
  if (!Number.isSafeInteger(period) || period < 15 || period > 120) {
    throw new VaultError("The TOTP period must be from 15 to 120 seconds", 400);
  }

  let label = "";
  try {
    label = decodeURIComponent(uri.pathname.replace(/^\//, ""));
  } catch {
    throw new VaultError("The TOTP setup URI has an invalid account label", 400);
  }
  const separator = label.indexOf(":");
  const labelIssuer = separator >= 0 ? label.slice(0, separator).trim() : "";
  const accountName = (separator >= 0 ? label.slice(separator + 1) : label).trim();
  const parameterIssuer = uniqueTotpParameter(uri, "issuer")?.trim() ?? "";
  if (labelIssuer && parameterIssuer && labelIssuer !== parameterIssuer) {
    throw new VaultError("The TOTP setup URI has inconsistent issuer metadata", 400);
  }
  const issuer = parameterIssuer || labelIssuer;
  if (issuer.length > 255 || accountName.length > 500) {
    throw new VaultError("The TOTP setup URI metadata is too long", 400);
  }
  return { secret, issuer, accountName, algorithm: algorithm.data, digits, period };
}

function toPasskeyView(passkey: VaultPasskeyCredential): VaultPasskeyView {
  return {
    id: passkey.id,
    rpId: passkey.rpId,
    userName: passkey.userName,
    userDisplayName: passkey.userDisplayName,
    createdAt: new Date(passkey.createdAt),
    lastUsedAt: passkey.lastUsedAt ? new Date(passkey.lastUsedAt) : null,
  };
}

function withoutVaultPasskeyLease(passkey: VaultStoredPasskey): VaultPasskeyCredential {
  const { useLeaseId: _useLeaseId, useLeaseExpiresAt: _useLeaseExpiresAt, ...credential } = passkey;
  return credential;
}

function requireStoredVaultPasskeyLease(passkey: VaultStoredPasskey, leaseId: string): void {
  // Expiry allows a new acquisition to replace an abandoned lease. An
  // assertion that already happened may persist after the deadline so long as
  // no new acquisition replaced its unguessable token; the payload CAS then
  // makes the old record and any new lease mutually exclusive.
  if (passkey.useLeaseId !== leaseId) {
    throw new VaultError("That Vault passkey use session expired. Start it again safely.", 409);
  }
}

function hasActiveVaultPasskeyUseLease(passkey: VaultStoredPasskey, at = Date.now()): boolean {
  const expiresAt = passkey.useLeaseExpiresAt ? Date.parse(passkey.useLeaseExpiresAt) : Number.NaN;
  return !!passkey.useLeaseId && Number.isFinite(expiresAt) && expiresAt > at;
}

function assertNoActiveVaultPasskeyUse(payload: VaultPayload, passkeyId?: string): void {
  if (
    payload.passkeys.some(
      (passkey) =>
        (!passkeyId || passkey.id === passkeyId) && hasActiveVaultPasskeyUseLease(passkey),
    )
  ) {
    throw new VaultError(
      "This Vault login is completing a software passkey sign-in. Retry after it finishes.",
      409,
    );
  }
}

function normalizeVaultPasskeyRpId(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  try {
    const parsed = new URL(`https://${candidate}`);
    if (
      !candidate ||
      parsed.hostname.toLowerCase() !== candidate ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/"
    ) {
      throw new Error();
    }
    return parsed.hostname.toLowerCase();
  } catch {
    throw new VaultError("The software passkey has an invalid relying-party ID", 400);
  }
}

function normalizeVaultPasskeyCredential(
  credential: VaultPasskeyCredentialInput,
): VaultPasskeyCredentialInput {
  const parsed = vaultPasskeyCredentialInputSchema.safeParse(credential);
  if (!parsed.success) {
    throw new VaultError("The software passkey credential is incomplete or invalid", 400);
  }
  const decodeBinary = (value: string, maximumBytes: number, allowEmpty = false): Buffer => {
    const unpadded = value.replace(/=+$/, "");
    if ((!allowEmpty && !unpadded) || unpadded.length % 4 === 1) throw new Error();
    const encoding = /[-_]/.test(unpadded) ? "base64url" : "base64";
    const bytes = Buffer.from(unpadded, encoding);
    const canonical = bytes.toString(encoding).replace(/=+$/, "");
    if (canonical !== unpadded || bytes.length > maximumBytes) throw new Error();
    return bytes;
  };
  try {
    decodeBinary(parsed.data.credentialId, 4096);
    const privateKeyBytes = decodeBinary(parsed.data.privateKey, 8192);
    if (parsed.data.userHandle !== undefined) {
      decodeBinary(parsed.data.userHandle, 64, true);
    }
    if (parsed.data.largeBlob !== undefined) {
      decodeBinary(parsed.data.largeBlob, 96 * 1024, true);
    }
    const privateKey = crypto.createPrivateKey({
      key: privateKeyBytes,
      format: "der",
      type: "pkcs8",
    });
    const curve = privateKey.asymmetricKeyDetails?.namedCurve;
    if (privateKey.asymmetricKeyType !== "ec" || !["prime256v1", "P-256"].includes(curve ?? "")) {
      throw new Error();
    }
  } catch {
    throw new VaultError("The software passkey credential is incomplete or invalid", 400);
  }
  const rpId = normalizeVaultPasskeyRpId(parsed.data.rpId);
  return { ...parsed.data, rpId };
}

function assertVaultPasskeyMatchesLogin(
  item: VaultItem,
  payload: VaultPayload,
  rpId: string,
): void {
  if (item.type !== "login") {
    throw new VaultError("Software passkeys can only be attached to Vault logins", 400);
  }
  try {
    const website = new URL(payload.websiteUrl);
    const hostname = website.hostname.toLowerCase();
    if (!hostname || (hostname !== rpId && !hostname.endsWith(`.${rpId}`))) throw new Error();
  } catch {
    throw new VaultError(
      "The software passkey relying party does not match this Vault login's website",
      400,
    );
  }
}

async function replaceVaultPayload(
  row: VaultItem,
  payload: VaultPayload,
  conflictMessage: string,
): Promise<VaultItem> {
  const update = await AppDataSource.getRepository(VaultItem).update(
    { id: row.id, companyId: row.companyId, version: row.version },
    {
      encryptedPayload: encryptPayload(row.companyId, payload),
      version: row.version + 1,
    },
  );
  if (update.affected !== 1) throw new VaultError(conflictMessage, 409);
  return loadItem(row.companyId, row.id);
}

/**
 * Clear only the matching encrypted lease. A stale Browser cleanup cannot
 * unlock a newer ceremony, and bounded CAS retries tolerate unrelated Vault
 * metadata writes in another App process.
 */
export async function releaseVaultPasskeyUseForEmployee(args: {
  companyId: string;
  itemId: string;
  passkeyId: string;
  leaseId: string;
}): Promise<void> {
  const repo = AppDataSource.getRepository(VaultItem);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await repo.findOneBy({ id: args.itemId, companyId: args.companyId });
    if (!row) return;
    const payload = decryptPayload(row);
    const passkey = payload.passkeys.find((candidate) => candidate.id === args.passkeyId);
    if (!passkey || passkey.useLeaseId !== args.leaseId) return;
    const cleared: VaultStoredPasskey = {
      ...passkey,
      useLeaseId: null,
      useLeaseExpiresAt: null,
    };
    const nextPayload: VaultPayload = {
      ...payload,
      passkeys: payload.passkeys.map((candidate) =>
        candidate.id === passkey.id ? cleared : candidate,
      ),
    };
    const update = await repo.update(
      { id: row.id, companyId: row.companyId, version: row.version },
      {
        encryptedPayload: encryptPayload(row.companyId, nextPayload),
        version: row.version + 1,
      },
    );
    if (update.affected === 1) return;
  }
  throw new VaultError("The Vault passkey lease changed while it was being released", 409);
}

/** Clear only the matching encrypted registration reservation. */
export async function releaseVaultPasskeyRegistrationForEmployee(args: {
  companyId: string;
  itemId: string;
  registrationLeaseId: string;
}): Promise<void> {
  const repo = AppDataSource.getRepository(VaultItem);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const row = await repo.findOneBy({ id: args.itemId, companyId: args.companyId });
    if (!row) return;
    const payload = decryptPayload(row);
    if (payload.passkeyRegistrationLease?.id !== args.registrationLeaseId) return;
    const nextPayload: VaultPayload = { ...payload, passkeyRegistrationLease: null };
    const update = await repo.update(
      { id: row.id, companyId: row.companyId, version: row.version },
      {
        encryptedPayload: encryptPayload(row.companyId, nextPayload),
        version: row.version + 1,
      },
    );
    if (update.affected === 1) return;
  }
  throw new VaultError("The Vault passkey registration changed while it was being released", 409);
}

function decryptPayload(row: VaultItem): VaultPayload {
  try {
    const ciphertextParts = row.encryptedPayload.split(".");
    const storedScope =
      ciphertextParts.length === 5 && ciphertextParts[0] === "v2"
        ? Buffer.from(ciphertextParts[1], "base64url").toString("utf8")
        : "";
    if (storedScope !== encryptionScope(row.companyId)) {
      throw new Error("ciphertext scope does not match item company");
    }
    const decoded = JSON.parse(decryptSecretWithStrongKeys(row.encryptedPayload)) as unknown;
    const parsed = vaultPayloadSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("invalid payload shape");
    return parsed.data;
  } catch {
    throw new VaultError("This Vault item could not be decrypted", 500);
  }
}

function encryptPayload(companyId: string, payload: VaultPayload): string {
  return encryptSecret(JSON.stringify(payload), encryptionScope(companyId));
}

function isHumanManager(row: VaultItem, actor: VaultHumanActor): boolean {
  return actor.role === "owner" || actor.role === "admin" || row.createdByUserId === actor.userId;
}

function effectiveHumanAccess(
  row: VaultItem,
  actor: VaultHumanActor,
  explicitAccess: VaultMemberAccessLevel | null,
): VaultMemberAccessLevel | null {
  if (isHumanManager(row, actor)) return "edit";
  if (explicitAccess === "edit") return "edit";
  if (row.visibility === "company" || explicitAccess === "view") return "view";
  return null;
}

function toView(
  row: VaultItem,
  payload: VaultPayload,
  actor: VaultHumanActor,
  explicitAccess: VaultMemberAccessLevel | null,
): VaultItemView {
  const effectiveAccessLevel = effectiveHumanAccess(row, actor, explicitAccess);
  if (!effectiveAccessLevel) throw new VaultError("Vault item not found", 404);
  const manager = isHumanManager(row, actor);
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type,
    visibility: row.visibility,
    title: payload.title,
    username: payload.username,
    websiteUrl: payload.websiteUrl,
    notes: payload.notes,
    hasTotp: payload.totp !== null,
    passkeys: payload.passkeys.map(toPasskeyView),
    version: row.version,
    createdByUserId: row.createdByUserId,
    createdByEmployeeId: row.createdByEmployeeId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    effectiveAccessLevel,
    canEdit: effectiveAccessLevel === "edit",
    canShare: manager,
    canDelete: manager,
    canReveal: true,
  };
}

async function loadHumanAccess(
  companyId: string,
  itemId: string,
  userId: string,
): Promise<VaultItemMemberAccess | null> {
  return AppDataSource.getRepository(VaultItemMemberAccess).findOneBy({
    companyId,
    vaultItemId: itemId,
    userId,
  });
}

async function loadItem(companyId: string, itemId: string): Promise<VaultItem> {
  const row = await AppDataSource.getRepository(VaultItem).findOneBy({
    id: itemId,
    companyId,
  });
  if (!row) throw new VaultError("Vault item not found", 404);
  return row;
}

async function loadAccessibleItem(
  companyId: string,
  itemId: string,
  actor: VaultHumanActor,
): Promise<{
  row: VaultItem;
  payload: VaultPayload;
  explicitAccess: VaultMemberAccessLevel | null;
  view: VaultItemView;
}> {
  const row = await loadItem(companyId, itemId);
  const access = await loadHumanAccess(companyId, itemId, actor.userId);
  const explicitAccess = access?.accessLevel ?? null;
  if (!effectiveHumanAccess(row, actor, explicitAccess)) {
    throw new VaultError("Vault item not found", 404);
  }
  const payload = decryptPayload(row);
  return { row, payload, explicitAccess, view: toView(row, payload, actor, explicitAccess) };
}

async function loadManagedItem(
  companyId: string,
  itemId: string,
  actor: VaultHumanActor,
): Promise<{ row: VaultItem; payload: VaultPayload }> {
  const row = await loadItem(companyId, itemId);
  if (!isHumanManager(row, actor)) {
    throw new VaultError("Only the creator or a company admin can manage sharing", 403);
  }
  return { row, payload: decryptPayload(row) };
}

export async function listVaultItems(
  companyId: string,
  actor: VaultHumanActor,
): Promise<VaultItemView[]> {
  const rows = await AppDataSource.getRepository(VaultItem).find({
    where: { companyId },
    order: { updatedAt: "DESC", createdAt: "DESC" },
  });
  if (rows.length === 0) return [];

  const accessRows = await AppDataSource.getRepository(VaultItemMemberAccess).find({
    where: {
      companyId,
      userId: actor.userId,
      vaultItemId: In(rows.map((row) => row.id)),
    },
  });
  const accessByItem = new Map(accessRows.map((row) => [row.vaultItemId, row.accessLevel]));
  const visible = rows.filter(
    (row) => effectiveHumanAccess(row, actor, accessByItem.get(row.id) ?? null) !== null,
  );
  return visible.map((row) =>
    toView(row, decryptPayload(row), actor, accessByItem.get(row.id) ?? null),
  );
}

export async function getVaultItem(
  companyId: string,
  itemId: string,
  actor: VaultHumanActor,
): Promise<VaultItemView> {
  return (await loadAccessibleItem(companyId, itemId, actor)).view;
}

export async function createVaultItem(args: {
  companyId: string;
  actor: VaultHumanActor;
  type: VaultItemType;
  visibility: VaultItemVisibility;
  payload: VaultPayload;
  totpSetupKey?: string;
}): Promise<VaultItemView> {
  const repo = AppDataSource.getRepository(VaultItem);
  if (
    args.type !== "login" &&
    (args.totpSetupKey ||
      args.payload.totp ||
      args.payload.passkeys.length > 0 ||
      args.payload.passkeyRegistrationLease)
  ) {
    throw new VaultError("Additional authenticators can only be attached to a Vault login", 400);
  }
  const payload: VaultPayload = {
    ...args.payload,
    websiteUrl: normalizeVaultWebsiteUrl(args.payload.websiteUrl),
    totp: args.totpSetupKey ? normalizeVaultTotpSetup(args.totpSetupKey) : args.payload.totp,
  };
  const row = repo.create({
    companyId: args.companyId,
    type: args.type,
    visibility: args.visibility,
    encryptedPayload: encryptPayload(args.companyId, payload),
    createdByUserId: args.actor.userId,
    createdByEmployeeId: null,
  });
  await repo.save(row);
  return toView(row, payload, args.actor, null);
}

export async function updateVaultItem(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
  expectedVersion: number;
  patch: Partial<Pick<VaultPayload, "title" | "username" | "secret" | "websiteUrl" | "notes">> & {
    type?: VaultItemType;
    visibility?: VaultItemVisibility;
  };
}): Promise<{ before: VaultItemView; item: VaultItemView }> {
  const loaded = await loadAccessibleItem(args.companyId, args.itemId, args.actor);
  if (!loaded.view.canEdit) throw new VaultError("Edit access is required", 403);
  assertNoActiveVaultPasskeyRegistration(loaded.payload);
  if (loaded.row.version !== args.expectedVersion) {
    throw new VaultError(
      "This Vault item changed while you were editing it. Reload and retry.",
      409,
    );
  }
  if (args.patch.visibility !== undefined && !isHumanManager(loaded.row, args.actor)) {
    throw new VaultError("Only the creator or a company admin can change visibility", 403);
  }
  const nextType = args.patch.type ?? loaded.row.type;
  if (
    nextType !== "login" &&
    (loaded.payload.totp !== null || loaded.payload.passkeys.length > 0)
  ) {
    throw new VaultError(
      "Remove the saved TOTP and software passkeys before changing this login's type",
      409,
    );
  }
  const nextWebsiteUrl =
    args.patch.websiteUrl === undefined
      ? loaded.payload.websiteUrl
      : normalizeVaultWebsiteUrl(args.patch.websiteUrl);
  const currentWebsiteOrigin = vaultWebsiteOrigin(loaded.payload.websiteUrl);
  if (
    args.patch.websiteUrl !== undefined &&
    loaded.payload.passkeys.length > 0 &&
    (currentWebsiteOrigin === null || currentWebsiteOrigin !== vaultWebsiteOrigin(nextWebsiteUrl))
  ) {
    throw new VaultError(
      "This Vault login has saved passkeys bound to its website origin. Remove them before changing the origin.",
      409,
    );
  }

  const before = loaded.view;
  const payload: VaultPayload = {
    title: args.patch.title ?? loaded.payload.title,
    username: args.patch.username ?? loaded.payload.username,
    secret: args.patch.secret ?? loaded.payload.secret,
    websiteUrl: nextWebsiteUrl,
    notes: args.patch.notes ?? loaded.payload.notes,
    totp: loaded.payload.totp,
    passkeys: loaded.payload.passkeys,
    passkeyRegistrationLease: loaded.payload.passkeyRegistrationLease,
  };
  const repo = AppDataSource.getRepository(VaultItem);
  const update = await repo.update(
    {
      id: loaded.row.id,
      companyId: args.companyId,
      version: args.expectedVersion,
    },
    {
      type: nextType,
      visibility: args.patch.visibility ?? loaded.row.visibility,
      encryptedPayload: encryptPayload(args.companyId, payload),
      version: args.expectedVersion + 1,
    },
  );
  if (update.affected !== 1) {
    throw new VaultError(
      "This Vault item changed while you were editing it. Reload and retry.",
      409,
    );
  }
  const saved = await loadItem(args.companyId, args.itemId);
  return {
    before,
    item: toView(saved, payload, args.actor, loaded.explicitAccess),
  };
}

export async function deleteVaultItem(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<{ id: string; title: string; type: VaultItemType }> {
  const { row, payload } = await loadManagedItem(args.companyId, args.itemId, args.actor);
  assertNoActiveVaultPasskeyRegistration(payload);
  assertNoActiveVaultPasskeyUse(payload);
  await AppDataSource.transaction(async (manager) => {
    await manager.delete(VaultItemMemberAccess, {
      companyId: args.companyId,
      vaultItemId: row.id,
    });
    await manager.delete(EmployeeVaultGrant, {
      companyId: args.companyId,
      vaultItemId: row.id,
    });
    const deletion = await manager.delete(VaultItem, {
      id: row.id,
      companyId: args.companyId,
      version: row.version,
    });
    if (deletion.affected !== 1) {
      throw new VaultError(
        "This Vault item changed while it was being deleted. Reload and retry.",
        409,
      );
    }
  });
  return { id: row.id, title: payload.title, type: row.type };
}

export async function revealVaultItem(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<{ item: VaultItemView; secret: string }> {
  const loaded = await loadAccessibleItem(args.companyId, args.itemId, args.actor);
  return { item: loaded.view, secret: loaded.payload.secret };
}

async function generateVaultTotpCode(
  totp: VaultTotp,
  at: Date,
): Promise<{ code: string; expiresAt: Date }> {
  const epoch = Math.floor(at.getTime() / 1000);
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new VaultError("The requested TOTP time is invalid", 400);
  }
  try {
    const code = await generateOtp({
      secret: totp.secret,
      strategy: "totp",
      algorithm: totp.algorithm,
      digits: totp.digits,
      period: totp.period,
      epoch,
      guardrails: VAULT_TOTP_GUARDRAILS,
    });
    const expiresAt = new Date((Math.floor(epoch / totp.period) + 1) * totp.period * 1000);
    return { code, expiresAt };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("This Vault TOTP could not generate a one-time code", 500);
  }
}

export async function setVaultTotp(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
  setupKey: string;
}): Promise<VaultItemView> {
  const loaded = await loadAccessibleItem(args.companyId, args.itemId, args.actor);
  if (!loaded.view.canEdit) throw new VaultError("Edit access is required", 403);
  assertNoActiveVaultPasskeyRegistration(loaded.payload);
  if (loaded.row.type !== "login") {
    throw new VaultError("TOTP can only be attached to a Vault login", 400);
  }
  const payload: VaultPayload = {
    ...loaded.payload,
    totp: normalizeVaultTotpSetup(args.setupKey),
  };
  const saved = await replaceVaultPayload(
    loaded.row,
    payload,
    "This Vault login changed while its TOTP was being saved. Retry safely.",
  );
  return toView(saved, payload, args.actor, loaded.explicitAccess);
}

export async function deleteVaultTotp(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<VaultItemView> {
  const loaded = await loadAccessibleItem(args.companyId, args.itemId, args.actor);
  if (!loaded.view.canEdit) throw new VaultError("Edit access is required", 403);
  assertNoActiveVaultPasskeyRegistration(loaded.payload);
  if (loaded.row.type !== "login") {
    throw new VaultError("TOTP can only be attached to a Vault login", 400);
  }
  if (!loaded.payload.totp) return loaded.view;
  const payload: VaultPayload = { ...loaded.payload, totp: null };
  const saved = await replaceVaultPayload(
    loaded.row,
    payload,
    "This Vault login changed while its TOTP was being removed. Retry safely.",
  );
  return toView(saved, payload, args.actor, loaded.explicitAccess);
}

export async function getVaultTotpCode(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
  at?: Date;
}): Promise<{ item: VaultItemView; code: string; expiresAt: Date }> {
  const loaded = await loadAccessibleItem(args.companyId, args.itemId, args.actor);
  if (loaded.row.type !== "login" || !loaded.payload.totp) {
    throw new VaultError("This Vault login has no TOTP saved", 404);
  }
  return {
    item: loaded.view,
    ...(await generateVaultTotpCode(loaded.payload.totp, args.at ?? new Date())),
  };
}

export async function deleteVaultPasskey(args: {
  companyId: string;
  itemId: string;
  passkeyId: string;
  actor: VaultHumanActor;
}): Promise<{ item: VaultItemView; passkey: VaultPasskeyView }> {
  const loaded = await loadAccessibleItem(args.companyId, args.itemId, args.actor);
  if (!loaded.view.canEdit) throw new VaultError("Edit access is required", 403);
  assertNoActiveVaultPasskeyRegistration(loaded.payload);
  if (loaded.row.type !== "login") {
    throw new VaultError("Software passkeys can only be attached to Vault logins", 400);
  }
  const passkey = loaded.payload.passkeys.find((candidate) => candidate.id === args.passkeyId);
  if (!passkey) throw new VaultError("Vault passkey not found", 404);
  assertNoActiveVaultPasskeyUse(loaded.payload, passkey.id);
  const payload: VaultPayload = {
    ...loaded.payload,
    passkeys: loaded.payload.passkeys.filter((candidate) => candidate.id !== args.passkeyId),
  };
  const saved = await replaceVaultPayload(
    loaded.row,
    payload,
    "This Vault login changed while its passkey was being removed. Retry safely.",
  );
  return {
    item: toView(saved, payload, args.actor, loaded.explicitAccess),
    passkey: toPasskeyView(passkey),
  };
}

export async function listVaultMemberAccess(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<VaultMemberAccessView[]> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const rows = await AppDataSource.getRepository(VaultItemMemberAccess).find({
    where: { companyId: args.companyId, vaultItemId: args.itemId },
    order: { createdAt: "ASC" },
  });
  if (rows.length === 0) return [];
  const userIds = rows.map((row) => row.userId);
  const [users, memberships] = await Promise.all([
    AppDataSource.getRepository(User).find({ where: { id: In(userIds) } }),
    AppDataSource.getRepository(Membership).find({
      where: { companyId: args.companyId, userId: In(userIds) },
    }),
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const membershipsByUser = new Map(memberships.map((row) => [row.userId, row]));
  return rows.flatMap((row) => {
    const user = usersById.get(row.userId);
    const membership = membershipsByUser.get(row.userId);
    if (!user || !membership) return [];
    return [
      {
        id: row.id,
        vaultItemId: row.vaultItemId,
        userId: row.userId,
        accessLevel: row.accessLevel,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        member: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: membership.role,
        },
      },
    ];
  });
}

export async function listVaultMemberAccessCandidates(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<VaultMemberAccessCandidate[]> {
  const { row } = await loadManagedItem(args.companyId, args.itemId, args.actor);
  const memberships = await AppDataSource.getRepository(Membership).find({
    where: { companyId: args.companyId },
  });
  if (memberships.length === 0) return [];
  const [users, accessRows] = await Promise.all([
    AppDataSource.getRepository(User).find({
      where: { id: In(memberships.map((membership) => membership.userId)) },
    }),
    AppDataSource.getRepository(VaultItemMemberAccess).find({
      where: { companyId: args.companyId, vaultItemId: args.itemId },
    }),
  ]);
  const usersById = new Map(users.map((user) => [user.id, user]));
  const accessByUser = new Map(accessRows.map((access) => [access.userId, access]));
  return memberships
    .flatMap((membership) => {
      const user = usersById.get(membership.userId);
      if (!user) return [];
      const access = accessByUser.get(user.id);
      return [
        {
          id: user.id,
          name: user.name,
          email: user.email,
          role: membership.role,
          isCreator: row.createdByUserId === user.id,
          access: access ? { id: access.id, accessLevel: access.accessLevel } : null,
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function assertCompanyMember(companyId: string, userId: string): Promise<void> {
  const membership = await AppDataSource.getRepository(Membership).findOneBy({
    companyId,
    userId,
  });
  if (!membership) throw new VaultError("Member not found", 404);
}

export async function upsertVaultMemberAccess(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
  userId: string;
  accessLevel: VaultMemberAccessLevel;
}): Promise<VaultMemberAccessView> {
  const { row } = await loadManagedItem(args.companyId, args.itemId, args.actor);
  await assertCompanyMember(args.companyId, args.userId);
  if (row.createdByUserId === args.userId) {
    throw new VaultError("The creator already has full access", 400);
  }
  const repo = AppDataSource.getRepository(VaultItemMemberAccess);
  let access = await repo.findOneBy({
    companyId: args.companyId,
    vaultItemId: args.itemId,
    userId: args.userId,
  });
  if (access) {
    access.accessLevel = args.accessLevel;
  } else {
    access = repo.create({
      companyId: args.companyId,
      vaultItemId: args.itemId,
      userId: args.userId,
      accessLevel: args.accessLevel,
    });
  }
  await repo.save(access);
  const rows = await listVaultMemberAccess(args);
  const hydrated = rows.find((candidate) => candidate.id === access!.id);
  if (!hydrated) throw new VaultError("Member not found", 404);
  return hydrated;
}

export async function updateVaultMemberAccess(args: {
  companyId: string;
  itemId: string;
  accessId: string;
  actor: VaultHumanActor;
  accessLevel: VaultMemberAccessLevel;
}): Promise<VaultMemberAccessView> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const repo = AppDataSource.getRepository(VaultItemMemberAccess);
  const row = await repo.findOneBy({
    id: args.accessId,
    companyId: args.companyId,
    vaultItemId: args.itemId,
  });
  if (!row) throw new VaultError("Member access not found", 404);
  row.accessLevel = args.accessLevel;
  await repo.save(row);
  const rows = await listVaultMemberAccess(args);
  const hydrated = rows.find((candidate) => candidate.id === row.id);
  if (!hydrated) throw new VaultError("Member not found", 404);
  return hydrated;
}

export async function deleteVaultMemberAccess(args: {
  companyId: string;
  itemId: string;
  accessId: string;
  actor: VaultHumanActor;
}): Promise<{ id: string; userId: string; accessLevel: VaultMemberAccessLevel }> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const repo = AppDataSource.getRepository(VaultItemMemberAccess);
  const row = await repo.findOneBy({
    id: args.accessId,
    companyId: args.companyId,
    vaultItemId: args.itemId,
  });
  if (!row) throw new VaultError("Member access not found", 404);
  await repo.delete({ id: row.id });
  return { id: row.id, userId: row.userId, accessLevel: row.accessLevel };
}

async function hydrateEmployeeGrants(
  rows: EmployeeVaultGrant[],
): Promise<EmployeeVaultGrantView[]> {
  if (rows.length === 0) return [];
  const employees = await AppDataSource.getRepository(AIEmployee).find({
    where: { id: In(rows.map((row) => row.employeeId)) },
  });
  const byId = new Map(employees.map((employee) => [employee.id, employee]));
  return rows.flatMap((row) => {
    const employee = byId.get(row.employeeId);
    if (!employee || employee.companyId !== row.companyId) return [];
    return [
      {
        id: row.id,
        vaultItemId: row.vaultItemId,
        employeeId: row.employeeId,
        accessLevel: row.accessLevel,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        employee: {
          id: employee.id,
          name: employee.name,
          slug: employee.slug,
          role: employee.role,
        },
      },
    ];
  });
}

export async function listEmployeeVaultGrants(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<EmployeeVaultGrantView[]> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const rows = await AppDataSource.getRepository(EmployeeVaultGrant).find({
    where: { companyId: args.companyId, vaultItemId: args.itemId },
    order: { createdAt: "ASC" },
  });
  return hydrateEmployeeGrants(rows);
}

export async function listEmployeeVaultGrantCandidates(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
}): Promise<EmployeeVaultGrantCandidate[]> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const [employees, grants] = await Promise.all([
    AppDataSource.getRepository(AIEmployee).find({
      where: { companyId: args.companyId },
      order: { name: "ASC" },
    }),
    AppDataSource.getRepository(EmployeeVaultGrant).find({
      where: { companyId: args.companyId, vaultItemId: args.itemId },
    }),
  ]);
  const byEmployee = new Map(grants.map((grant) => [grant.employeeId, grant]));
  return employees.map((employee) => {
    const grant = byEmployee.get(employee.id);
    return {
      id: employee.id,
      name: employee.name,
      slug: employee.slug,
      role: employee.role,
      grant: grant ? { id: grant.id, accessLevel: grant.accessLevel } : null,
    };
  });
}

async function assertCompanyEmployee(companyId: string, employeeId: string): Promise<void> {
  const employee = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!employee) throw new VaultError("AI Employee not found", 404);
}

export async function upsertEmployeeVaultGrant(args: {
  companyId: string;
  itemId: string;
  actor: VaultHumanActor;
  employeeId: string;
  accessLevel: EmployeeVaultAccessLevel;
}): Promise<EmployeeVaultGrantView> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  await assertCompanyEmployee(args.companyId, args.employeeId);
  const repo = AppDataSource.getRepository(EmployeeVaultGrant);
  let grant = await repo.findOneBy({
    companyId: args.companyId,
    vaultItemId: args.itemId,
    employeeId: args.employeeId,
  });
  if (grant) {
    grant.accessLevel = args.accessLevel;
  } else {
    grant = repo.create({
      companyId: args.companyId,
      vaultItemId: args.itemId,
      employeeId: args.employeeId,
      accessLevel: args.accessLevel,
    });
  }
  await repo.save(grant);
  const [hydrated] = await hydrateEmployeeGrants([grant]);
  if (!hydrated) throw new VaultError("AI Employee not found", 404);
  return hydrated;
}

export async function updateEmployeeVaultGrant(args: {
  companyId: string;
  itemId: string;
  grantId: string;
  actor: VaultHumanActor;
  accessLevel: EmployeeVaultAccessLevel;
}): Promise<EmployeeVaultGrantView> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const repo = AppDataSource.getRepository(EmployeeVaultGrant);
  const grant = await repo.findOneBy({
    id: args.grantId,
    companyId: args.companyId,
    vaultItemId: args.itemId,
  });
  if (!grant) throw new VaultError("Vault Grant not found", 404);
  grant.accessLevel = args.accessLevel;
  await repo.save(grant);
  const [hydrated] = await hydrateEmployeeGrants([grant]);
  if (!hydrated) throw new VaultError("AI Employee not found", 404);
  return hydrated;
}

export async function deleteEmployeeVaultGrant(args: {
  companyId: string;
  itemId: string;
  grantId: string;
  actor: VaultHumanActor;
}): Promise<{ id: string; employeeId: string; accessLevel: EmployeeVaultAccessLevel }> {
  await loadManagedItem(args.companyId, args.itemId, args.actor);
  const repo = AppDataSource.getRepository(EmployeeVaultGrant);
  const grant = await repo.findOneBy({
    id: args.grantId,
    companyId: args.companyId,
    vaultItemId: args.itemId,
  });
  if (!grant) throw new VaultError("Vault Grant not found", 404);
  await repo.delete({ id: grant.id });
  return { id: grant.id, employeeId: grant.employeeId, accessLevel: grant.accessLevel };
}

/**
 * AI-facing metadata discovery. It returns only items explicitly granted to
 * the employee and never includes the encrypted payload's secret field.
 */
export async function listVaultItemsForEmployee(
  companyId: string,
  employeeId: string,
): Promise<
  Array<{
    id: string;
    type: VaultItemType;
    title: string;
    username: string;
    websiteUrl: string;
    hasTotp: boolean;
    passkeys: VaultPasskeyView[];
    accessLevel: EmployeeVaultAccessLevel;
  }>
> {
  await assertCompanyEmployee(companyId, employeeId);
  const grants = await AppDataSource.getRepository(EmployeeVaultGrant).find({
    where: { companyId, employeeId },
  });
  if (grants.length === 0) return [];
  const rows = await AppDataSource.getRepository(VaultItem).find({
    where: { companyId, id: In(grants.map((grant) => grant.vaultItemId)) },
  });
  const grantByItem = new Map(grants.map((grant) => [grant.vaultItemId, grant]));
  return rows.flatMap((row) => {
    const grant = grantByItem.get(row.id);
    const rank = grant ? EMPLOYEE_VAULT_ACCESS_RANK[grant.accessLevel] : undefined;
    if (!grant || typeof rank !== "number") return [];
    const payload = decryptPayload(row);
    return [
      {
        id: row.id,
        type: row.type,
        title: payload.title,
        username: payload.username,
        websiteUrl: payload.websiteUrl,
        hasTotp: payload.totp !== null,
        passkeys: payload.passkeys.map(toPasskeyView),
        accessLevel: grant.accessLevel,
      },
    ];
  });
}

/**
 * Sensitive resolution seam for a governed server-side AI action (for
 * example, filling the App-owned browser). Callers must never serialize the
 * returned payload into a model tool result, transcript, audit row or log.
 */
export async function getVaultItemPayloadForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  required?: EmployeeVaultAccessLevel;
}): Promise<{
  item: VaultItem;
  payload: VaultPayload;
  accessLevel: EmployeeVaultAccessLevel;
}> {
  await assertCompanyEmployee(args.companyId, args.employeeId);
  const required = args.required ?? "use";
  const [item, grant] = await Promise.all([
    AppDataSource.getRepository(VaultItem).findOneBy({
      id: args.itemId,
      companyId: args.companyId,
    }),
    AppDataSource.getRepository(EmployeeVaultGrant).findOneBy({
      companyId: args.companyId,
      vaultItemId: args.itemId,
      employeeId: args.employeeId,
    }),
  ]);
  if (!item || !grant) throw new VaultError("No Grant for that Vault item", 403);
  const have = EMPLOYEE_VAULT_ACCESS_RANK[grant.accessLevel];
  const need = EMPLOYEE_VAULT_ACCESS_RANK[required];
  if (typeof have !== "number" || have < need) {
    throw new VaultError(`The "${required}" Vault Grant level is required`, 403);
  }
  return { item, payload: decryptPayload(item), accessLevel: grant.accessLevel };
}

/**
 * Resolve one credential field for an App-owned, server-side action. The
 * plaintext return is intentionally narrow and ephemeral: callers must pass it
 * directly to the governed sink (such as Playwright `fill`) and must never put
 * it in a model result, response body, transcript, audit row, or log.
 */
export async function getVaultFieldForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  field: "username" | "secret";
}): Promise<string> {
  const resolved = await getVaultItemPayloadForEmployee({
    companyId: args.companyId,
    employeeId: args.employeeId,
    itemId: args.itemId,
    required: "use",
  });
  return resolved.payload[args.field];
}

function assertEmployeeCreatedVaultLogin(
  item: VaultItem,
  employeeId: string,
  authenticator: "TOTP" | "software passkeys",
): void {
  if (item.type !== "login") {
    throw new VaultError(`${authenticator} can only be attached to Vault logins`, 400);
  }
  if (item.createdByEmployeeId !== employeeId) {
    throw new VaultError(
      `AI Employees can only attach ${authenticator} to Vault logins they created`,
      403,
    );
  }
}

/** Store a captured setup key without ever returning it to the Browser tool or model. */
export async function setVaultTotpForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  setupKey: string;
  expectedVersion?: number;
  expectedOrigin?: string;
}): Promise<{ id: string; title: string; hasTotp: true }> {
  const resolved = await getVaultItemPayloadForEmployee({
    companyId: args.companyId,
    employeeId: args.employeeId,
    itemId: args.itemId,
    required: "manage",
  });
  assertEmployeeCreatedVaultLogin(resolved.item, args.employeeId, "TOTP");
  if (args.expectedVersion !== undefined && resolved.item.version !== args.expectedVersion) {
    throw new VaultError(
      "This Vault login changed while its TOTP setup was being captured. Retry safely.",
      409,
    );
  }
  if (
    args.expectedOrigin !== undefined &&
    vaultWebsiteOrigin(resolved.payload.websiteUrl) !== args.expectedOrigin
  ) {
    throw new VaultError(
      "This Vault login's website changed while its TOTP setup was being captured. Retry safely.",
      409,
    );
  }
  assertNoActiveVaultPasskeyRegistration(resolved.payload);
  const payload: VaultPayload = {
    ...resolved.payload,
    totp: normalizeVaultTotpSetup(args.setupKey),
  };
  await replaceVaultPayload(
    resolved.item,
    payload,
    "This Vault login changed while its TOTP was being saved. Retry safely.",
  );
  return { id: resolved.item.id, title: payload.title, hasTotp: true };
}

/** Resolve only the current code for a governed App-owned Browser fill. */
export async function getVaultTotpCodeForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  expectedVersion?: number;
  at?: Date;
}): Promise<{ code: string; expiresAt: Date; itemVersion: number }> {
  const resolved = await getVaultItemPayloadForEmployee({
    companyId: args.companyId,
    employeeId: args.employeeId,
    itemId: args.itemId,
    required: "use",
  });
  if (args.expectedVersion !== undefined && resolved.item.version !== args.expectedVersion) {
    throw new VaultError(
      "This Vault login changed before its TOTP could be used. Reload and retry.",
      409,
    );
  }
  if (resolved.item.type !== "login" || !resolved.payload.totp) {
    throw new VaultError("This Vault login has no TOTP saved", 404);
  }
  return {
    ...(await generateVaultTotpCode(resolved.payload.totp, args.at ?? new Date())),
    itemVersion: resolved.item.version,
  };
}

/**
 * Reserve one AI Employee-created login before Chrome begins a remote passkey
 * registration ceremony. The reservation is encrypted and versioned with the
 * login so separate App processes cannot start competing ceremonies.
 */
export async function beginVaultPasskeyRegistrationForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  expectedVersion?: number;
}): Promise<{
  item: VaultPasskeyRegistrationItem;
  registrationLeaseId: string;
}> {
  if (
    args.expectedVersion !== undefined &&
    (!Number.isInteger(args.expectedVersion) || args.expectedVersion < 1)
  ) {
    throw new VaultError("The expected Vault item version is invalid", 400);
  }
  const registrationLeaseId = crypto.randomUUID();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const resolved = await getVaultItemPayloadForEmployee({
      companyId: args.companyId,
      employeeId: args.employeeId,
      itemId: args.itemId,
      required: "manage",
    });
    assertEmployeeCreatedVaultLogin(resolved.item, args.employeeId, "software passkeys");
    if (args.expectedVersion !== undefined && resolved.item.version !== args.expectedVersion) {
      throw new VaultError(
        "This Vault login changed before its passkey registration started. Reload and retry.",
        409,
      );
    }
    assertNoActiveVaultPasskeyRegistration(resolved.payload);
    if (resolved.payload.passkeys.length >= 32) {
      throw new VaultError("This Vault login cannot store more software passkeys", 409);
    }
    const websiteOrigin = vaultWebsiteOrigin(resolved.payload.websiteUrl);
    if (!websiteOrigin) {
      throw new VaultError(
        "Save an absolute website URL before registering a software passkey",
        400,
      );
    }
    const lease: VaultPasskeyRegistrationLease = {
      id: registrationLeaseId,
      employeeId: args.employeeId,
      websiteOrigin,
      expiresAt: new Date(Date.now() + VAULT_PASSKEY_REGISTRATION_LEASE_MS).toISOString(),
    };
    const payload: VaultPayload = {
      ...resolved.payload,
      passkeyRegistrationLease: lease,
    };
    try {
      const saved = await replaceVaultPayload(
        resolved.item,
        payload,
        "This Vault login changed while its passkey registration was starting. Retry safely.",
      );
      return {
        item: {
          id: saved.id,
          companyId: saved.companyId,
          type: "login",
          title: payload.title,
          username: payload.username,
          websiteUrl: payload.websiteUrl,
          version: saved.version,
          createdByEmployeeId: args.employeeId,
        },
        registrationLeaseId,
      };
    } catch (error) {
      if (
        args.expectedVersion !== undefined ||
        !(error instanceof VaultError) ||
        error.statusCode !== 409 ||
        attempt === 4
      ) {
        throw error;
      }
    }
  }
  throw new VaultError("This Vault passkey registration could not be started safely", 409);
}

/**
 * Persist the credential Chrome created and clear its encrypted reservation.
 * Acquisition already authorized the remote action, so a matching lease token
 * remains authoritative if the employee's Grant is revoked before finalizing.
 */
export async function finalizeVaultPasskeyRegistrationForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  registrationLeaseId: string;
  credential: VaultPasskeyCredentialInput;
}): Promise<VaultPasskeyView> {
  try {
    let normalized: VaultPasskeyCredentialInput | null = null;
    let pendingPasskey: VaultStoredPasskey | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const item = await loadItem(args.companyId, args.itemId);
      const currentPayload = decryptPayload(item);
      const lease = requireVaultPasskeyRegistrationLease(
        currentPayload,
        args.registrationLeaseId,
        args.employeeId,
      );
      const websiteOrigin = vaultWebsiteOrigin(currentPayload.websiteUrl);
      if (
        item.type !== "login" ||
        item.createdByEmployeeId !== args.employeeId ||
        websiteOrigin === null ||
        websiteOrigin !== lease.websiteOrigin
      ) {
        throw new VaultError(
          "That Vault passkey registration no longer matches its original login and website",
          409,
        );
      }
      const normalizedCredential =
        normalized ?? (normalized = normalizeVaultPasskeyCredential(args.credential));
      assertVaultPasskeyMatchesLogin(item, currentPayload, normalizedCredential.rpId);
      if (currentPayload.passkeys.length >= 32) {
        throw new VaultError("This Vault login cannot store more software passkeys", 409);
      }
      if (
        currentPayload.passkeys.some((candidate) =>
          sameSensitivePasskeyValue(candidate.credentialId, normalizedCredential.credentialId),
        )
      ) {
        throw new VaultError("That software passkey is already saved on this Vault login", 409);
      }
      pendingPasskey ??= {
        ...normalizedCredential,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        useLeaseId: null,
        useLeaseExpiresAt: null,
      };
      const payload: VaultPayload = {
        ...currentPayload,
        passkeys: [...currentPayload.passkeys, pendingPasskey],
        passkeyRegistrationLease: null,
      };
      try {
        await replaceVaultPayload(
          item,
          payload,
          "This Vault login changed while its passkey was being finalized. Retry safely.",
        );
        return toPasskeyView(pendingPasskey);
      } catch (error) {
        if (!(error instanceof VaultError) || error.statusCode !== 409 || attempt === 4) {
          throw error;
        }
      }
    }
    throw new VaultError("This Vault passkey registration could not be finalized safely", 409);
  } catch (error) {
    await releaseVaultPasskeyRegistrationForEmployee(args).catch(() => undefined);
    throw error;
  }
}

/**
 * Rehydrate one credential for the App-owned Browser. Its bounded lease is
 * persisted inside the encrypted/versioned payload, preventing separate App
 * processes from starting two authenticators at the same stored signCount.
 */
export async function getVaultPasskeyForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  passkeyId?: string;
  expectedVersion?: number;
}): Promise<{
  item: VaultItem;
  payload: VaultPayload;
  passkey: VaultPasskeyCredential;
  leaseId: string;
}> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const resolved = await getVaultItemPayloadForEmployee({
      companyId: args.companyId,
      employeeId: args.employeeId,
      itemId: args.itemId,
      required: "use",
    });
    if (args.expectedVersion !== undefined && resolved.item.version !== args.expectedVersion) {
      throw new VaultError(
        "This Vault login changed before its passkey could be used. Reload and retry.",
        409,
      );
    }
    if (resolved.item.type !== "login") {
      throw new VaultError("Software passkeys can only be used from Vault logins", 400);
    }
    const passkey = args.passkeyId
      ? resolved.payload.passkeys.find((candidate) => candidate.id === args.passkeyId)
      : resolved.payload.passkeys.length === 1
        ? resolved.payload.passkeys[0]
        : undefined;
    if (!passkey) {
      if (!args.passkeyId && resolved.payload.passkeys.length > 1) {
        throw new VaultError("Choose which saved Vault passkey to use", 400);
      }
      throw new VaultError("Vault passkey not found", 404);
    }
    assertVaultPasskeyMatchesLogin(resolved.item, resolved.payload, passkey.rpId);
    if (hasActiveVaultPasskeyUseLease(passkey)) {
      throw new VaultError("That Vault passkey is already active in another Browser session", 409);
    }
    const leaseId = crypto.randomUUID();
    const leasedPasskey: VaultStoredPasskey = {
      ...passkey,
      useLeaseId: leaseId,
      useLeaseExpiresAt: new Date(Date.now() + VAULT_PASSKEY_USE_LEASE_MS).toISOString(),
    };
    const payload: VaultPayload = {
      ...resolved.payload,
      passkeys: resolved.payload.passkeys.map((candidate) =>
        candidate.id === leasedPasskey.id ? leasedPasskey : candidate,
      ),
    };
    try {
      const item = await replaceVaultPayload(
        resolved.item,
        payload,
        "That Vault passkey changed while its use session was starting. Retry safely.",
      );
      return {
        item,
        payload,
        passkey: withoutVaultPasskeyLease(leasedPasskey),
        leaseId,
      };
    } catch (error) {
      if (
        args.expectedVersion !== undefined ||
        !(error instanceof VaultError) ||
        error.statusCode !== 409 ||
        attempt === 4
      ) {
        throw error;
      }
    }
  }
  throw new VaultError("That Vault passkey use session could not be started safely", 409);
}

function sameSensitivePasskeyValue(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

/**
 * Persist the asserted counter before the leased credential can be used again.
 * Acquisition already authorized the external action. Once that assertion has
 * succeeded, its matching lease token is the authority for mandatory counter
 * bookkeeping even if the employee's Grant was revoked in the meantime.
 */
export async function recordVaultPasskeyUseForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  passkeyId: string;
  leaseId: string;
  credential: VaultPasskeyCredentialInput;
}): Promise<{ passkey: VaultPasskeyView }> {
  try {
    let asserted: VaultPasskeyCredentialInput | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const item = await loadItem(args.companyId, args.itemId);
      const currentPayload = decryptPayload(item);
      const stored = currentPayload.passkeys.find((candidate) => candidate.id === args.passkeyId);
      if (!stored) throw new VaultError("Vault passkey not found", 404);
      requireStoredVaultPasskeyLease(stored, args.leaseId);
      asserted ??= normalizeVaultPasskeyCredential(args.credential);
      const immutableCredentialMatches =
        stored.rpId === asserted.rpId &&
        stored.isResidentCredential === asserted.isResidentCredential &&
        sameSensitivePasskeyValue(stored.credentialId, asserted.credentialId) &&
        sameSensitivePasskeyValue(stored.privateKey, asserted.privateKey) &&
        sameSensitivePasskeyValue(stored.userHandle, asserted.userHandle);
      if (!immutableCredentialMatches) {
        throw new VaultError(
          "The asserted software passkey did not match the leased credential",
          409,
        );
      }
      if (
        (stored.signCount > 0 || asserted.signCount > 0) &&
        asserted.signCount <= stored.signCount
      ) {
        throw new VaultError(
          "The software passkey counter did not advance; its credential may have been cloned",
          409,
        );
      }

      const passkey: VaultStoredPasskey = {
        ...stored,
        signCount: asserted.signCount,
        largeBlob: asserted.largeBlob ?? stored.largeBlob,
        backupEligibility: asserted.backupEligibility ?? stored.backupEligibility,
        backupState: asserted.backupState ?? stored.backupState,
        userName: asserted.userName ?? stored.userName,
        userDisplayName: asserted.userDisplayName ?? stored.userDisplayName,
        lastUsedAt: new Date().toISOString(),
        useLeaseId: null,
        useLeaseExpiresAt: null,
      };
      const payload: VaultPayload = {
        ...currentPayload,
        passkeys: currentPayload.passkeys.map((candidate) =>
          candidate.id === passkey.id ? passkey : candidate,
        ),
      };
      try {
        await replaceVaultPayload(
          item,
          payload,
          "This Vault login changed while its passkey use was being recorded. Retry safely.",
        );
        return { passkey: toPasskeyView(passkey) };
      } catch (error) {
        if (!(error instanceof VaultError) || error.statusCode !== 409 || attempt === 4)
          throw error;
      }
    }
    throw new VaultError("The software passkey counter could not be saved safely", 409);
  } catch (error) {
    // This token-matched release is safe even after Grant revocation or a CAS
    // conflict, and cannot clear a newer Browser ceremony's lease.
    await releaseVaultPasskeyUseForEmployee(args).catch(() => undefined);
    throw error;
  }
}

/**
 * Store a login captured or generated during an AI Employee's browser flow.
 * The creator receives a `manage` Grant atomically. A missing secret is
 * generated server-side and is deliberately not included in the return value.
 */
export async function createVaultLoginForEmployee(args: {
  companyId: string;
  employeeId: string;
  title: string;
  username?: string;
  secret?: string;
  passwordLength?: number;
  websiteUrl?: string;
  notes?: string;
  visibility?: VaultItemVisibility;
}): Promise<{
  id: string;
  companyId: string;
  type: "login";
  visibility: VaultItemVisibility;
  title: string;
  username: string;
  websiteUrl: string;
  createdByEmployeeId: string;
  grantAccessLevel: "manage";
  createdAt: Date;
  updatedAt: Date;
}> {
  await assertCompanyEmployee(args.companyId, args.employeeId);
  const secret = args.secret ?? generateVaultPassword(args.passwordLength);
  if (!secret) throw new VaultError("A captured secret cannot be empty", 400);
  const payload: VaultPayload = {
    title: args.title.trim(),
    username: args.username ?? "",
    secret,
    websiteUrl: normalizeVaultWebsiteUrl(args.websiteUrl ?? ""),
    notes: args.notes ?? "",
    totp: null,
    passkeys: [],
    passkeyRegistrationLease: null,
  };
  if (!payload.title) throw new VaultError("A title is required", 400);

  const saved = await AppDataSource.transaction(async (manager) => {
    const itemRepo = manager.getRepository(VaultItem);
    const item = itemRepo.create({
      companyId: args.companyId,
      type: "login",
      visibility: args.visibility ?? "company",
      encryptedPayload: encryptPayload(args.companyId, payload),
      createdByUserId: null,
      createdByEmployeeId: args.employeeId,
    });
    await itemRepo.save(item);
    const grantRepo = manager.getRepository(EmployeeVaultGrant);
    await grantRepo.save(
      grantRepo.create({
        companyId: args.companyId,
        vaultItemId: item.id,
        employeeId: args.employeeId,
        accessLevel: "manage",
      }),
    );
    return item;
  });

  return {
    id: saved.id,
    companyId: saved.companyId,
    type: "login",
    visibility: saved.visibility,
    title: payload.title,
    username: payload.username,
    websiteUrl: payload.websiteUrl,
    createdByEmployeeId: args.employeeId,
    grantAccessLevel: "manage",
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}

/**
 * Let an AI Employee with a `manage` Grant maintain login metadata without
 * gaining a plaintext read or rotation primitive. The existing secret is
 * decrypted only inside this service and immediately re-encrypted unchanged.
 */
export async function updateVaultLoginMetadataForEmployee(args: {
  companyId: string;
  employeeId: string;
  itemId: string;
  patch: {
    title?: string;
    username?: string;
    notes?: string;
  };
}): Promise<{
  id: string;
  companyId: string;
  type: "login";
  visibility: VaultItemVisibility;
  title: string;
  username: string;
  websiteUrl: string;
  createdByEmployeeId: string | null;
  accessLevel: "manage";
  createdAt: Date;
  updatedAt: Date;
}> {
  if (Object.keys(args.patch).length === 0) {
    throw new VaultError("Provide at least one metadata field to update", 400);
  }
  if (Object.keys(args.patch).some((field) => !["title", "username", "notes"].includes(field))) {
    throw new VaultError("AI Employees cannot change a Vault login's saved website", 403);
  }
  const resolved = await getVaultItemPayloadForEmployee({
    companyId: args.companyId,
    employeeId: args.employeeId,
    itemId: args.itemId,
    required: "manage",
  });
  if (resolved.item.type !== "login") {
    throw new VaultError("Only Vault login metadata can be updated this way", 400);
  }
  assertNoActiveVaultPasskeyRegistration(resolved.payload);

  const payload: VaultPayload = {
    title: args.patch.title?.trim() ?? resolved.payload.title,
    username: args.patch.username ?? resolved.payload.username,
    secret: resolved.payload.secret,
    websiteUrl: resolved.payload.websiteUrl,
    notes: args.patch.notes ?? resolved.payload.notes,
    totp: resolved.payload.totp,
    passkeys: resolved.payload.passkeys,
    passkeyRegistrationLease: resolved.payload.passkeyRegistrationLease,
  };
  if (!payload.title) throw new VaultError("A title is required", 400);

  const repo = AppDataSource.getRepository(VaultItem);
  const update = await repo.update(
    {
      id: resolved.item.id,
      companyId: args.companyId,
      version: resolved.item.version,
    },
    {
      encryptedPayload: encryptPayload(args.companyId, payload),
      version: resolved.item.version + 1,
    },
  );
  if (update.affected !== 1) {
    throw new VaultError("This Vault login changed while it was being updated. Retry safely.", 409);
  }
  const saved = await loadItem(args.companyId, args.itemId);
  return {
    id: saved.id,
    companyId: saved.companyId,
    type: "login",
    visibility: saved.visibility,
    title: payload.title,
    username: payload.username,
    websiteUrl: payload.websiteUrl,
    createdByEmployeeId: saved.createdByEmployeeId,
    accessLevel: "manage",
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  };
}
