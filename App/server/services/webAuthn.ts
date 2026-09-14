import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import type { EntityManager } from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { WebAuthnCredential } from "../db/entities/WebAuthnCredential.js";
import { getPublicUrl } from "./publicUrl.js";

const CEREMONY_TIMEOUT_MS = 5 * 60 * 1000;

export function webAuthnConfig(): { origin: string; rpID: string } {
  const publicUrl = new URL(getPublicUrl());
  return { origin: publicUrl.origin, rpID: publicUrl.hostname };
}

export function parseWebAuthnTransports(value: string | null): AuthenticatorTransportFuture[] {
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

/**
 * Build either an account-bound second-factor ceremony or a discoverable,
 * usernameless primary sign-in. Omitting `allowCredentials` in the latter is
 * deliberate: the browser may offer any passkey scoped to this RP without the
 * server first learning an email address.
 */
export async function beginWebAuthnAuthentication(userId?: string) {
  const credentials = userId
    ? await AppDataSource.getRepository(WebAuthnCredential).findBy({ userId })
    : [];
  if (userId && credentials.length === 0) return null;
  const { rpID } = webAuthnConfig();
  return generateAuthenticationOptions({
    rpID,
    timeout: CEREMONY_TIMEOUT_MS,
    ...(userId
      ? {
          allowCredentials: credentials.map((credential) => ({
            id: credential.credentialId,
            transports: parseWebAuthnTransports(credential.transports),
          })),
        }
      : {}),
    userVerification: "required",
  });
}

export type VerifiedStoredWebAuthnAssertion = {
  user: User;
  credential: WebAuthnCredential;
};

/**
 * Verify an assertion against the credential row it names and atomically
 * advance that row. `expectedUserId` is supplied for password-following 2FA;
 * primary passkey sign-in discovers the account from the globally unique
 * credential id and requires the authenticator's user handle as a second
 * binding back to that account.
 */
type VerifyStoredWebAuthnAssertionArgs = {
  expectedChallenge: string;
  response: AuthenticationResponseJSON;
  expectedUserId?: string;
  requireUserHandle?: boolean;
};

async function verifyWithManager(
  manager: EntityManager,
  args: VerifyStoredWebAuthnAssertionArgs,
  lockCredential: boolean,
): Promise<VerifiedStoredWebAuthnAssertion | null> {
  const credentialRepo = manager.getRepository(WebAuthnCredential);
  const where = {
    credentialId: args.response.id,
    ...(args.expectedUserId ? { userId: args.expectedUserId } : {}),
  };
  const row = lockCredential
    ? await credentialRepo.findOne({ where, lock: { mode: "pessimistic_write" } })
    : await credentialRepo.findOneBy(where);
  if (!row) return null;

  const user = await manager.getRepository(User).findOneBy({ id: row.userId });
  if (!user) return null;
  const expectedUserHandle = Buffer.from(user.id, "utf8").toString("base64url");
  const returnedUserHandle = args.response.response.userHandle;
  if (args.requireUserHandle && !returnedUserHandle) return null;
  if (returnedUserHandle && returnedUserHandle !== expectedUserHandle) return null;

  const { origin, rpID } = webAuthnConfig();
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: args.response,
      expectedChallenge: args.expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.credentialId,
        publicKey: new Uint8Array(Buffer.from(row.publicKey, "base64url")),
        counter: row.counter,
        transports: parseWebAuthnTransports(row.transports),
      },
      requireUserVerification: true,
    });
  } catch {
    return null;
  }
  if (!verification.verified) return null;
  const changes = {
    counter: verification.authenticationInfo.newCounter,
    deviceType: verification.authenticationInfo.credentialDeviceType,
    backedUp: verification.authenticationInfo.credentialBackedUp,
    lastUsedAt: new Date(),
  };
  if (lockCredential) {
    Object.assign(row, changes);
    await credentialRepo.save(row);
  } else {
    // SQLite has no row-level lock. Claim the counter transition
    // optimistically so two assertions verified from the same stale counter
    // cannot both succeed. Avoiding a surrounding transaction is deliberate:
    // better-sqlite3 has one connection and rejects overlapping transactions.
    const claimed = await credentialRepo.update({ id: row.id, counter: row.counter }, changes);
    if (claimed.affected !== 1) return null;
    Object.assign(row, changes);
  }
  return { user, credential: row };
}

export async function verifyStoredWebAuthnAssertion(
  args: VerifyStoredWebAuthnAssertionArgs,
): Promise<VerifiedStoredWebAuthnAssertion | null> {
  if (config.db.driver === "postgres") {
    return AppDataSource.transaction((manager) => verifyWithManager(manager, args, true));
  }
  return verifyWithManager(AppDataSource.manager, args, false);
}
