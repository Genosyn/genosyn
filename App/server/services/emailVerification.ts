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
  await repo.save(user);
  return user;
}

export function emailVerificationRequired(user: User): boolean {
  return config.security.multiTenant && !user.emailVerifiedAt;
}
