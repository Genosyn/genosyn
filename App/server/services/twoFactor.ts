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
import {
  WebAuthnCredential,
  type WebAuthnCredentialKind,
} from "../db/entities/WebAuthnCredential.js";
import { config } from "../../config.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";

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

export type TwoFactorStatus = {
  enabled: boolean;
  totpEnabled: boolean;
  webAuthnCredentials: TwoFactorCredentialSummary[];
  recoveryCodesRemaining: number;
};

function webAuthnConfig(): { origin: string; rpID: string } {
  const publicUrl = new URL(config.publicUrl);
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

export async function getTwoFactorStatus(userId: string): Promise<TwoFactorStatus> {
  const [user, credentials] = await Promise.all([
    AppDataSource.getRepository(User).findOneBy({ id: userId }),
    AppDataSource.getRepository(WebAuthnCredential).find({
      where: { userId },
      order: { createdAt: "ASC" },
    }),
  ]);
  if (!user) throw new TwoFactorError("User not found", 404);
  const totpEnabled = user.totpEnabledAt !== null;
  return {
    enabled: totpEnabled || credentials.length > 0,
    totpEnabled,
    webAuthnCredentials: credentials.map(summarizeCredential),
    recoveryCodesRemaining: parseRecoveryHashes(user.recoveryCodes).length,
  };
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
    totp: status.totpEnabled,
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
): Promise<{ secret: string; otpAuthUri: string; qrDataUrl: string }> {
  await confirmCurrentPassword(user, password);
  if (user.totpEnabledAt) {
    throw new TwoFactorError("An authenticator app is already enrolled", 409);
  }

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
  user.totpSecret = encryptSecret(secret);
  user.totpEnabledAt = null;
  await AppDataSource.getRepository(User).save(user);
  return { secret, otpAuthUri, qrDataUrl };
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
  token: string,
): Promise<{ status: TwoFactorStatus; recoveryCodes: string[] }> {
  if (!user.totpSecret || user.totpEnabledAt) {
    throw new TwoFactorError("Start authenticator-app setup first", 400);
  }
  if (!(await verifyTotpSecret(user.totpSecret, token))) {
    throw new TwoFactorError("That verification code is invalid or expired", 400);
  }
  user.totpEnabledAt = new Date();
  const recoveryCodes = ensureRecoveryCodes(user);
  await AppDataSource.getRepository(User).save(user);
  return { status: await getTwoFactorStatus(user.id), recoveryCodes };
}

export async function verifyTotpLogin(user: User, token: string): Promise<boolean> {
  if (!user.totpEnabledAt || !user.totpSecret) return false;
  return verifyTotpSecret(user.totpSecret, token);
}

export async function removeTotp(user: User, password: string): Promise<TwoFactorStatus> {
  await confirmCurrentPassword(user, password);
  user.totpSecret = null;
  user.totpEnabledAt = null;
  const credentialCount = await AppDataSource.getRepository(WebAuthnCredential).countBy({
    userId: user.id,
  });
  if (credentialCount === 0) user.recoveryCodes = null;
  await AppDataSource.getRepository(User).save(user);
  return getTwoFactorStatus(user.id);
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
  await repo.remove(row);
  const remaining = await repo.countBy({ userId: args.user.id });
  if (remaining === 0 && !args.user.totpEnabledAt) {
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
  await AppDataSource.transaction(async (manager) => {
    await manager.delete(WebAuthnCredential, { userId: user.id });
    user.totpSecret = null;
    user.totpEnabledAt = null;
    user.recoveryCodes = null;
    await manager.save(User, user);
  });
  return getTwoFactorStatus(user.id);
}
