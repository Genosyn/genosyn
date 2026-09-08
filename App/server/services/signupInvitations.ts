import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { Invitation } from "../db/entities/Invitation.js";
import { hashToken } from "../lib/token.js";

/** Registration may use an invitation, but only acceptance consumes it. */
export async function findOpenSignupInvitation(
  token: string,
  email: string,
): Promise<Invitation | null> {
  const repo = AppDataSource.getRepository(Invitation);
  // Retain links issued before invitation tokens were hashed through expiry.
  const invitation =
    (await repo.findOneBy({ token: hashToken(token) })) ?? (await repo.findOneBy({ token }));
  if (
    !invitation ||
    invitation.acceptedAt ||
    invitation.expiresAt <= new Date() ||
    invitation.email.trim().toLowerCase() !== email.trim().toLowerCase()
  ) {
    return null;
  }
  const companyExists = await AppDataSource.getRepository(Company).existsBy({
    id: invitation.companyId,
  });
  return companyExists ? invitation : null;
}
