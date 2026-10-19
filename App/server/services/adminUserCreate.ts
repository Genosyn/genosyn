import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import { QueryFailedError } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { generateToken, hashToken } from "../lib/token.js";
import { recordAudit } from "./audit.js";
import type { AdminUserRow } from "./adminDirectory.js";
import { sendEmail, type SendEmailResult } from "./email.js";
import { getPublicUrl } from "./publicUrl.js";
import { emitMembershipAuthorizationChange } from "./resourceEvents.js";
import { ensureUserHandle } from "./userHandle.js";

/**
 * Admin → Users → Add user: a master admin creates someone's account directly,
 * for an install where sign-ups are closed, mail is not set up, or the people
 * simply should not have to register themselves.
 *
 * The admin either sets the first password (and passes it on however they
 * like) or leaves it to the person: then the account gets a password nobody
 * knows plus a one-time setup link — the password-reset token, so the existing
 * `/reset` page and its single-use, expiring rules apply unchanged. The link
 * is emailed and also handed back to the admin, because an install without an
 * email transport would otherwise strand it in the server console.
 *
 * Nothing here vouches for the mailbox: the account starts unverified exactly
 * as a self-registered one does, so a multi-tenant install still asks for
 * verification and master-admin promotion still needs it.
 */

/** A setup link is an invitation, so it lives as long as one (7 days). */
export const ADMIN_SETUP_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_ROUNDS = 12;

export class AdminUserCreateError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "AdminUserCreateError";
  }
}

export type AdminUserCreateInput = {
  name: string;
  email: string;
  /** Null leaves the password to the person, through an emailed setup link. */
  password: string | null;
  /** The company to add them to, or null for an account in no company yet. */
  companyId: string | null;
  role: Extract<Role, "member" | "admin">;
  actorUserId: string | null;
};

export type AdminUserCreateResult = {
  row: AdminUserRow;
  /** The one-time setup link when no password was set; null otherwise. */
  setupLink: string | null;
  /** How the welcome email went: `skipped` means no transport is configured. */
  emailStatus: SendEmailResult["status"];
};

export async function createUserAsAdmin(
  input: AdminUserCreateInput,
): Promise<AdminUserCreateResult> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  const users = AppDataSource.getRepository(User);
  if (await users.existsBy({ email })) {
    throw new AdminUserCreateError("A user with that email already exists.", 409);
  }
  const company = input.companyId
    ? await AppDataSource.getRepository(Company).findOneBy({ id: input.companyId })
    : null;
  if (input.companyId && !company) {
    throw new AdminUserCreateError("That company no longer exists.", 404);
  }

  const setupToken = input.password === null ? generateToken() : null;
  // Without a password from the admin the account gets one nobody knows; the
  // setup link is the only way in until the person chooses their own.
  const passwordHash = await bcrypt.hash(
    input.password ?? randomBytes(32).toString("base64url"),
    BCRYPT_ROUNDS,
  );

  let user: User;
  try {
    user = await AppDataSource.transaction(async (manager) => {
      const repo = manager.getRepository(User);
      const saved = await repo.save(
        repo.create({
          email,
          name,
          passwordHash,
          isMasterAdmin: false,
          resetToken: setupToken ? hashToken(setupToken) : null,
          resetExpiresAt: setupToken ? new Date(Date.now() + ADMIN_SETUP_LINK_TTL_MS) : null,
          emailVerifiedAt: null,
          emailVerificationTokenHash: null,
          emailVerificationExpiresAt: null,
          sessionVersion: 0,
        }),
      );
      if (company) {
        const memberships = manager.getRepository(Membership);
        await memberships.save(
          memberships.create({ companyId: company.id, userId: saved.id, role: input.role }),
        );
      }
      return saved;
    });
  } catch (err) {
    // Someone registered the same address between the check and the insert.
    if (err instanceof QueryFailedError && (await users.existsBy({ email }))) {
      throw new AdminUserCreateError("A user with that email already exists.", 409);
    }
    throw err;
  }
  await ensureUserHandle(user);

  if (company) {
    emitMembershipAuthorizationChange(company.id);
    await recordAudit({
      companyId: company.id,
      actorUserId: input.actorUserId,
      action: "member.add",
      targetType: "member",
      targetId: user.id,
      targetLabel: user.email,
      metadata: { role: input.role, addedBy: "admin" },
    });
  }

  const setupLink = setupToken ? setupLinkFor(setupToken) : null;
  const emailStatus = await sendWelcome(user, company, setupLink, input.actorUserId);
  return {
    row: {
      id: user.id,
      email: user.email,
      name: user.name,
      handle: user.handle,
      avatarKey: user.avatarKey ?? null,
      createdAt: user.createdAt.toISOString(),
      isMasterAdmin: false,
      membershipCount: company ? 1 : 0,
      ownedCompanies: [],
    },
    setupLink,
    emailStatus,
  };
}

/** The reset page, told it is a first password so it says "Choose", not "Reset". */
export function setupLinkFor(token: string): string {
  const url = new URL(`/reset/${token}`, getPublicUrl());
  url.searchParams.set("setup", "1");
  return url.toString();
}

async function sendWelcome(
  user: User,
  company: Company | null,
  setupLink: string | null,
  actorUserId: string | null,
): Promise<SendEmailResult["status"]> {
  const where = company ? ` to ${company.name}` : "";
  const signIn = new URL("/login", getPublicUrl()).toString();
  const text = setupLink
    ? `Hi ${user.name}, an administrator added you${where} on Genosyn. Choose your password to sign in (the link works once and expires in 7 days): ${setupLink}`
    : `Hi ${user.name}, an administrator added you${where} on Genosyn. Sign in at ${signIn} as ${user.email} with the password they gave you.`;
  try {
    const result = await sendEmail({
      to: user.email,
      subject: "You've been added to Genosyn",
      text,
      bodyPreview: setupLink
        ? "Account setup link redacted. The link works once and expires in 7 days."
        : text,
      purpose: "welcome",
      triggeredByUserId: actorUserId,
    });
    return result.status;
  } catch {
    // The account exists either way; the admin still has the link to share.
    return "failed";
  }
}
