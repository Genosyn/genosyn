import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Keygrip from "keygrip";

import { config } from "../../config.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { getEffectiveInstanceSecrets } from "../lib/instanceSecrets.js";
import { hashApiToken } from "../middleware/auth.js";
import { createUserSession } from "../services/userSessions.js";
import { insert } from "./dbHarness.js";

/**
 * Fixtures for tests that drive the real `createApp()` stack — cookie session
 * middleware, origin checks and all — with a real API key or a real signed
 * session cookie, rather than a hand-mounted router with a fake session.
 */

type MutableConfig = {
  dataDir: string;
  sessionSecret: string;
  security: { encryptionSecret: string; multiTenant: boolean };
};

/**
 * Give the process strong secrets and a throwaway data directory, so the
 * session middleware never creates `.instance-secrets.json` beside a
 * developer's real data. Returns the function that puts everything back.
 */
export function withTestInstanceSecrets(): () => void {
  const mutable = config as unknown as MutableConfig;
  const original = {
    dataDir: mutable.dataDir,
    sessionSecret: mutable.sessionSecret,
    encryptionSecret: mutable.security.encryptionSecret,
    multiTenant: mutable.security.multiTenant,
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-api-access-"));
  mutable.dataDir = dataDir;
  mutable.sessionSecret = `api-access-session-${randomBytes(24).toString("hex")}`;
  mutable.security.encryptionSecret = `api-access-encryption-${randomBytes(24).toString("hex")}`;
  mutable.security.multiTenant = false;
  return () => {
    mutable.dataDir = original.dataDir;
    mutable.sessionSecret = original.sessionSecret;
    mutable.security.encryptionSecret = original.encryptionSecret;
    mutable.security.multiTenant = original.multiTenant;
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
}

/** A verified user who owns (or holds `role` in) a fresh company. */
export async function createMemberOfNewCompany(
  role: Role = "owner",
  userValues: Partial<User> = {},
): Promise<{ user: User; company: Company; membership: Membership }> {
  const user = await insert(User, {
    email: `${role}-${randomUUID()}@example.test`,
    name: `Test ${role}`,
    passwordHash: "not-a-real-hash",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
    ...userValues,
  });
  const company = await insert(Company, {
    name: "Acme",
    slug: `acme-${randomUUID()}`,
    ownerId: user.id,
  });
  const membership = await insert(Membership, { companyId: company.id, userId: user.id, role });
  return { user, company, membership };
}

/** Mint an API key the way `POST /api-keys` does, returning the row and its plaintext. */
export async function mintTestApiKey(
  userId: string,
  companyId: string,
  values: Partial<ApiKey> = {},
): Promise<{ key: ApiKey; token: string }> {
  const body = randomBytes(32).toString("base64url");
  const key = await insert(ApiKey, {
    userId,
    companyId,
    name: "automation",
    prefix: body.slice(0, 8),
    tokenHash: hashApiToken(body),
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    ...values,
  });
  return { key, token: `gen_${body}` };
}

/**
 * A `Cookie` header carrying a persisted sign-in for `user`, signed exactly as
 * `cookie-session` signs `genosyn.sid` with the instance's session secret.
 */
export async function sessionCookieFor(user: Pick<User, "id" | "sessionVersion">): Promise<string> {
  const identity = await createUserSession(user);
  const now = Date.now();
  const value = Buffer.from(
    JSON.stringify({ ...identity, authenticatedAt: now, secondFactorAt: now }),
  ).toString("base64");
  const signature = new Keygrip([getEffectiveInstanceSecrets().sessionSecret]).sign(
    `genosyn.sid=${value}`,
  );
  return `genosyn.sid=${value}; genosyn.sid.sig=${signature}`;
}

/** A request path for an OpenAPI template: `{cid}` is the company, every other parameter a fresh id. */
export function concretePath(template: string, companyId: string): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) =>
    name === "cid" ? companyId : randomUUID(),
  );
}
