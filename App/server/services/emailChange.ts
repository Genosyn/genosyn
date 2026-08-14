import { AppDataSource } from "../db/datasource.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { User } from "../db/entities/User.js";
import { createAuthFlowState, consumeAuthFlowState } from "./authFlowState.js";
import { sendEmail } from "./email.js";
import { getPublicUrl } from "./publicUrl.js";
import { IsNull } from "typeorm";

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

type EmailChangeState = {
  userId: string;
  newEmail: string;
  sessionVersion: number;
};

/** Send a single-use confirmation to the new address without changing identity yet. */
export async function requestEmailChange(user: User, newEmail: string): Promise<void> {
  const token = await createAuthFlowState(
    "email-change",
    { userId: user.id, newEmail, sessionVersion: user.sessionVersion } satisfies EmailChangeState,
    EMAIL_CHANGE_TTL_MS,
  );
  const link = `${getPublicUrl()}/verify-email/${token}`;
  await sendEmail({
    to: newEmail,
    subject: "Confirm your new Genosyn email",
    text: `Confirm this email address (valid for 24 hours): ${link}`,
    bodyPreview: "Email-change confirmation link redacted. The link is valid for 24 hours.",
    purpose: "email_verification",
    triggeredByUserId: user.id,
  });
}

/**
 * Consume an email-change token and switch the address only after proving the
 * new mailbox. Session version binding invalidates a request after any other
 * credential-sensitive account change.
 */
export async function confirmEmailChangeToken(token: string): Promise<User | null> {
  const state = await consumeAuthFlowState<EmailChangeState>("email-change", token);
  if (!state) return null;
  return AppDataSource.transaction(async (manager) => {
    const users = manager.getRepository(User);
    const user = await users.findOneBy({ id: state.userId });
    if (!user || user.sessionVersion !== state.sessionVersion) return null;
    const existing = await users.findOneBy({ email: state.newEmail });
    if (existing && existing.id !== user.id) return null;
    user.email = state.newEmail;
    user.emailVerifiedAt = new Date();
    user.emailVerificationTokenHash = null;
    user.emailVerificationExpiresAt = null;
    user.sessionVersion += 1;
    await users.save(user);
    // An email change alters the account's primary identity. Revoke personal
    // API keys as well as browser sessions so every credential is reissued
    // under the confirmed address.
    await manager.update(
      ApiKey,
      { userId: user.id, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );
    return user;
  });
}
