import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { generateToken, hashToken } from "../lib/token.js";
import { sendEmail } from "./email.js";
import { getPublicUrl } from "./publicUrl.js";

const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

export function hashEmailVerificationToken(token: string): string {
  return hashToken(token);
}

/** Rotate the single-use token before sending so older links stop working. */
export async function sendEmailVerification(user: User): Promise<void> {
  const token = generateToken();
  user.emailVerificationTokenHash = hashEmailVerificationToken(token);
  user.emailVerificationExpiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  await AppDataSource.getRepository(User).save(user);

  const link = `${getPublicUrl()}/verify-email/${token}`;
  await sendEmail({
    to: user.email,
    subject: "Verify your Genosyn email",
    text: `Verify your email address (valid for 24 hours): ${link}`,
    bodyPreview: "Email-verification link redacted. The link is valid for 24 hours.",
    purpose: "email_verification",
    triggeredByUserId: user.id,
  });
}

export async function verifyEmailToken(token: string): Promise<User | null> {
  const repo = AppDataSource.getRepository(User);
  const user = await repo.findOneBy({
    emailVerificationTokenHash: hashEmailVerificationToken(token),
  });
  if (!user || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
    return null;
  }

  user.emailVerifiedAt = new Date();
  user.emailVerificationTokenHash = null;
  user.emailVerificationExpiresAt = null;
  await claimBootstrapMasterAdminIfEligible(user);
  await repo.save(user);
  return user;
}

/**
 * The configured address is the operator's proof that this account may claim
 * an otherwise-empty instance. Promotion happens only after mailbox ownership
 * has been verified; unlike the former first-signup rule, an internet race can
 * never choose a different address.
 */
export async function claimBootstrapMasterAdminIfEligible(user: User): Promise<boolean> {
  if (user.isMasterAdmin || !user.emailVerifiedAt) return user.isMasterAdmin;
  const bootstrapEmail = config.security.bootstrapMasterAdminEmail.trim().toLowerCase();
  if (!bootstrapEmail || user.email.trim().toLowerCase() !== bootstrapEmail) return false;
  const repo = AppDataSource.getRepository(User);
  if ((await repo.count({ where: { isMasterAdmin: true } })) > 0) return false;
  user.isMasterAdmin = true;
  // Never let a cookie minted while the account was unverified inherit
  // operator authority. The verified operator signs in again from scratch.
  user.sessionVersion += 1;
  await repo.save(user);
  return true;
}

export function emailVerificationRequired(user: User): boolean {
  return config.security.multiTenant && !user.emailVerifiedAt;
}
