import crypto from "node:crypto";
import bcrypt from "bcrypt";
import QRCode from "qrcode";
import { generateSecret, generateURI, verify as verifyOtp } from "otplib";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { Company } from "../db/entities/Company.js";
import { Membership } from "../db/entities/Membership.js";
import { In, IsNull, Not } from "typeorm";
import { TotpCredential } from "../db/entities/TotpCredential.js";
import {
  WebAuthnCredential,
  type WebAuthnCredentialKind,
} from "../db/entities/WebAuthnCredential.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";
import { getPublicUrl } from "./publicUrl.js";

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_BYTES = 10;

export class TwoFactorError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "TwoFactorError";
  }
}

export type TwoFactorCredentialSummary = {
  id: string;
  name: string;
  kind: WebAuthnCredentialKind;
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

export type TotpCredentialSummary = {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type TwoFactorStatus = {
  enabled: boolean;
  totpCredentials: TotpCredentialSummary[];
  webAuthnCredentials: TwoFactorCredentialSummary[];
  recoveryCodesRemaining: number;
};

function webAuthnConfig(): { origin: string; rpID: string } {
  const publicUrl = new URL(getPublicUrl());
  return { origin: publicUrl.origin, rpID: publicUrl.hostname };
}

function parseTransports(value: string | null): AuthenticatorTransportFuture[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AuthenticatorTransportFuture =>
      ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"].includes(String(item)),
    );
  } catch {
    return [];
  }
}

function parseRecoveryHashes(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === "string" && /^[a-f0-9]{64}$/.test(item),
    );
  } catch {
    return [];
  }
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function hashRecoveryCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

function generateRecoveryCode(): string {
  const raw = crypto.randomBytes(RECOVERY_CODE_BYTES).toString("hex").toUpperCase();
  return raw.match(/.{1,5}/g)!.join("-");
}

function replaceRecoveryCodes(user: User): string[] {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  user.recoveryCodes = JSON.stringify(codes.map(hashRecoveryCode));
  return codes;
}

function ensureRecoveryCodes(user: User): string[] {
  if (user.recoveryCodes !== null) return [];
  return replaceRecoveryCodes(user);
}

function summarizeCredential(row: WebAuthnCredential): TwoFactorCredentialSummary {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    deviceType: row.deviceType,
    backedUp: row.backedUp,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

function summarizeTotp(row: TotpCredential): TotpCredentialSummary {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** Enrolled authenticator apps. Setups still mid-flow are not second factors. */
function enrolledTotpCredentials(userId: string): Promise<TotpCredential[]> {
  return AppDataSource.getRepository(TotpCredential).find({
    where: { userId, verifiedAt: Not(IsNull()) },
    order: { createdAt: "ASC" },
  });
}

/** How many second factors this account can currently sign in with. */
async function countTwoFactorMethods(userId: string): Promise<number> {
  const [totp, webAuthn] = await Promise.all([
    AppDataSource.getRepository(TotpCredential).countBy({ userId, verifiedAt: Not(IsNull()) }),
    AppDataSource.getRepository(WebAuthnCredential).countBy({ userId }),
  ]);
  return totp + webAuthn;
}

export async function getTwoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  const [user, totpCredentials, credentials] = await Promise.all([
    AppDataSource.getRepository(User).findOneBy({ id: userId }),
    enrolledTotpCredentials(userId),
    AppDataSource.getRepository(WebAuthnCredential).find({
      where: { userId },
      order: { createdAt: "ASC" },
    }),
  ]);
  if (!user) throw new TwoFactorError("User not found", 404);
  return {
    enabled: totpCredentials.length > 0 || credentials.length > 0,
    totpCredentials: totpCredentials.map(summarizeTotp),
    webAuthnCredentials: credentials.map(summarizeCredential),
    recoveryCodesRemaining: parseRecoveryHashes(user.recoveryCodes).length,
  };
}

export async function hasTwoFactorMethod(userId: string): Promise<boolean> {
  return (await countTwoFactorMethods(userId)) > 0;
}

async function assertMayRemoveLastTwoFactorMethod(userId: string): Promise<void> {
  const memberships = await AppDataSource.getRepository(Membership).findBy({ userId });
  if (memberships.length === 0) return;
  const required = await AppDataSource.getRepository(Company).countBy({
    id: In(memberships.map((membership) => membership.companyId)),
    requireTwoFactor: true,
  });
  if (required > 0) {
    throw new TwoFactorError("Two-factor authentication is required by one of your companies", 403);
  }
}

export async function getTwoFactorLoginMethods(userId: string): Promise<{
  enabled: boolean;
  totp: boolean;
  webAuthn: boolean;
  recovery: boolean;
}> {
  const status = await getTwoFactorStatus(userId);
  return {
    enabled: status.enabled,
    totp: status.totpCredentials.length > 0,
    webAuthn: status.webAuthnCredentials.length > 0,
    recovery: status.recoveryCodesRemaining > 0,
  };
}

export async function confirmCurrentPassword(user: User, password: string): Promise<void> {
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    throw new TwoFactorError("Current password is incorrect", 400);
  }
}

export async function beginTotpEnrollment(
  user: User,
  password: string,
  name: string,
): Promise<{ credentialId: string; secret: string; otpAuthUri: string; qrDataUrl: string }> {
  await confirmCurrentPassword(user, password);
  const repo = AppDataSource.getRepository(TotpCredential);
  const enrolled = await enrolledTotpCredentials(user.id);
  if (enrolled.some((row) => row.name.toLowerCase() === name.toLowerCase())) {
    throw new TwoFactorError("You already have an authenticator app with that name", 409);
  }

  // Whatever the Member was setting up before this is now abandoned — a
  // half-finished seed is not a second factor and must not linger.
  await repo.delete({ userId: user.id, verifiedAt: IsNull() });

  const secret = generateSecret();
  const otpAuthUri = generateURI({
    issuer: "Genosyn",
    label: user.email,
    secret,
  });
  const qrDataUrl = await QRCode.toDataURL(otpAuthUri, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
    color: { dark: "#0f172a", light: "#ffffff" },
  });
  const row = await repo.save(
    repo.create({
      userId: user.id,
      name,
      secret: encryptSecret(secret, `user:${user.id}`),
      verifiedAt: null,
      lastUsedAt: null,
    }),
  );
  return { credentialId: row.id, secret, otpAuthUri, qrDataUrl };
}

async function verifyTotpSecret(secretBlob: string, token: string): Promise<boolean> {
  try {
    const result = await verifyOtp({
      secret: decryptSecret(secretBlob),
      token,
      epochTolerance: 30,
    });
    return result.valid;
  } catch {
    return false;
  }
}

export async function finishTotpEnrollment(
  user: User,
  credentialId: string,
  token: string,
): Promise<{
  status: TwoFactorStatus;
  credential: TotpCredentialSummary;
  recoveryCodes: string[];
}> {
  const repo = AppDataSource.getRepository(TotpCredential);
  const row = await repo.findOneBy({ id: credentialId, userId: user.id, verifiedAt: IsNull() });
  if (!row) throw new TwoFactorError("Start authenticator-app setup first", 400);
  if (!(await verifyTotpSecret(row.secret, token))) {
    throw new TwoFactorError("That verification code is invalid or expired", 400);
  }
  row.verifiedAt = new Date();
  await repo.save(row);
  const recoveryCodes = ensureRecoveryCodes(user);
  if (recoveryCodes.length > 0) {
    await AppDataSource.getRepository(User).save(user);
  }
  return {
    status: await getTwoFactorStatus(user.id),
    credential: summarizeTotp(row),
    recoveryCodes,
  };
}

export async function verifyTotpLogin(user: User, token: string): Promise<boolean> {
  // A Member may carry several authenticators; any enrolled one completes the
  // sign-in. Each seed is tried until one accepts the code.
  for (const row of await enrolledTotpCredentials(user.id)) {
    if (!(await verifyTotpSecret(row.secret, token))) continue;
    row.lastUsedAt = new Date();
    await AppDataSource.getRepository(TotpCredential).save(row);
    return true;
  }
  return false;
}

export async function removeTotpCredential(args: {
  user: User;
  credentialId: string;
  password: string;
}): Promise<TwoFactorStatus> {
  await confirmCurrentPassword(args.user, args.password);
  const repo = AppDataSource.getRepository(TotpCredential);
  const row = await repo.findOneBy({ id: args.credentialId, userId: args.user.id });
  if (!row) throw new TwoFactorError("Authenticator app not found", 404);
  // An unverified row was never a second factor, so removing it can't strand
  // the account and doesn't touch recovery codes.
  const wasEnrolled = row.verifiedAt !== null;
  if (wasEnrolled && (await countTwoFactorMethods(args.user.id)) === 1) {
    await assertMayRemoveLastTwoFactorMethod(args.user.id);
  }
  await repo.remove(row);
  if (wasEnrolled && (await countTwoFactorMethods(args.user.id)) === 0) {
    // Recovery codes must not outlive the methods they back up.
    args.user.recoveryCodes = null;
    await AppDataSource.getRepository(User).save(args.user);
  }
  return getTwoFactorStatus(args.user.id);
}

export async function beginWebAuthnEnrollment(args: {
  user: User;
  password: string;
  kind: WebAuthnCredentialKind;
}) {
  await confirmCurrentPassword(args.user, args.password);
  const credentials = await AppDataSource.getRepository(WebAuthnCredential).findBy({
    userId: args.user.id,
  });
  const { rpID } = webAuthnConfig();
  return generateRegistrationOptions({
    rpName: "Genosyn",
    rpID,
    userID: Buffer.from(args.user.id, "utf8"),
    userName: args.user.email,
    userDisplayName: args.user.name || args.user.email,
    timeout: 5 * 60 * 1000,
    attestationType: "none",
    excludeCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: parseTransports(credential.transports),
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    preferredAuthenticatorType: args.kind === "security_key" ? "securityKey" : "localDevice",
    supportedAlgorithmIDs: [-7, -257],
  });
}

export async function finishWebAuthnEnrollment(args: {
  user: User;
  expectedChallenge: string;
  response: RegistrationResponseJSON;
  name: string;
  kind: WebAuthnCredentialKind;
}): Promise<{
  status: TwoFactorStatus;
  credential: TwoFactorCredentialSummary;
  recoveryCodes: string[];
}> {
  const { origin, rpID } = webAuthnConfig();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      supportedAlgorithmIDs: [-7, -257],
    });
  } catch {
    throw new TwoFactorError("The passkey or security key could not be verified", 400);
  }
  if (!verification.verified) {
    throw new TwoFactorError("The passkey or security key could not be verified", 400);
  }

  const info = verification.registrationInfo;
  const existing = await AppDataSource.getRepository(WebAuthnCredential).findOneBy({
    credentialId: info.credential.id,
  });
  if (existing) throw new TwoFactorError("That credential is already registered", 409);

  const row = AppDataSource.getRepository(WebAuthnCredential).create({
    userId: args.user.id,
    credentialId: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString("base64url"),
    counter: info.credential.counter,
    transports:
      info.credential.transports && info.credential.transports.length > 0
        ? JSON.stringify(info.credential.transports)
        : null,
    kind: args.kind,
    name: args.name,
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    lastUsedAt: null,
  });
  await AppDataSource.getRepository(WebAuthnCredential).save(row);

  const recoveryCodes = ensureRecoveryCodes(args.user);
  if (recoveryCodes.length > 0) {
    await AppDataSource.getRepository(User).save(args.user);
  }
  return {
    status: await getTwoFactorStatus(args.user.id),
    credential: summarizeCredential(row),
    recoveryCodes,
  };
}

export async function beginWebAuthnLogin(userId: string) {
  const credentials = await AppDataSource.getRepository(WebAuthnCredential).findBy({ userId });
  if (credentials.length === 0) {
    throw new TwoFactorError("No passkey or security key is enrolled", 400);
  }
  const { rpID } = webAuthnConfig();
  return generateAuthenticationOptions({
    rpID,
    timeout: 5 * 60 * 1000,
    allowCredentials: credentials.map((credential) => ({
      id: credential.credentialId,
      transports: parseTransports(credential.transports),
    })),
    userVerification: "required",
  });
}

export async function verifyWebAuthnLogin(args: {
  userId: string;
  expectedChallenge: string;
  response: AuthenticationResponseJSON;
}): Promise<boolean> {
  const row = await AppDataSource.getRepository(WebAuthnCredential).findOneBy({
    userId: args.userId,
    credentialId: args.response.id,
  });
  if (!row) return false;
  const { origin, rpID } = webAuthnConfig();
  try {
    const verification = await verifyAuthenticationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.credentialId,
        publicKey: new Uint8Array(Buffer.from(row.publicKey, "base64url")),
        counter: row.counter,
        transports: parseTransports(row.transports),
      },
      requireUserVerification: true,
    });
    if (!verification.verified) return false;
    row.counter = verification.authenticationInfo.newCounter;
    row.deviceType = verification.authenticationInfo.credentialDeviceType;
    row.backedUp = verification.authenticationInfo.credentialBackedUp;
    row.lastUsedAt = new Date();
    await AppDataSource.getRepository(WebAuthnCredential).save(row);
    return true;
  } catch {
    return false;
  }
}

export async function removeWebAuthnCredential(args: {
  user: User;
  credentialId: string;
  password: string;
}): Promise<TwoFactorStatus> {
  await confirmCurrentPassword(args.user, args.password);
  const repo = AppDataSource.getRepository(WebAuthnCredential);
  const row = await repo.findOneBy({ id: args.credentialId, userId: args.user.id });
  if (!row) throw new TwoFactorError("Credential not found", 404);
  if ((await countTwoFactorMethods(args.user.id)) === 1) {
    await assertMayRemoveLastTwoFactorMethod(args.user.id);
  }
  await repo.remove(row);
  // Recovery codes must not remain usable once every second-factor method is
  // gone, so re-count after the removal rather than trusting the earlier read.
  if ((await countTwoFactorMethods(args.user.id)) === 0) {
    args.user.recoveryCodes = null;
    await AppDataSource.getRepository(User).save(args.user);
  }
  return getTwoFactorStatus(args.user.id);
}

export async function useRecoveryCode(user: User, code: string): Promise<boolean> {
  const hashes = parseRecoveryHashes(user.recoveryCodes);
  const candidate = Buffer.from(hashRecoveryCode(code), "hex");
  const index = hashes.findIndex((hash) => {
    const stored = Buffer.from(hash, "hex");
    return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
  });
  if (index < 0) return false;
  hashes.splice(index, 1);
  user.recoveryCodes = JSON.stringify(hashes);
  await AppDataSource.getRepository(User).save(user);
  return true;
}

export async function regenerateRecoveryCodes(
  user: User,
  password: string,
): Promise<{ status: TwoFactorStatus; recoveryCodes: string[] }> {
  await confirmCurrentPassword(user, password);
  const methods = await getTwoFactorLoginMethods(user.id);
  if (!methods.enabled) {
    throw new TwoFactorError("Enable two-factor authentication first", 400);
  }
  const recoveryCodes = replaceRecoveryCodes(user);
  await AppDataSource.getRepository(User).save(user);
  return { status: await getTwoFactorStatus(user.id), recoveryCodes };
}

export async function disableTwoFactor(user: User, password: string): Promise<TwoFactorStatus> {
  await confirmCurrentPassword(user, password);
  await assertMayRemoveLastTwoFactorMethod(user.id);
  await AppDataSource.transaction(async (manager) => {
    await manager.delete(WebAuthnCredential, { userId: user.id });
    await manager.delete(TotpCredential, { userId: user.id });
    user.recoveryCodes = null;
    await manager.save(User, user);
  });
  return getTwoFactorStatus(user.id);
}
