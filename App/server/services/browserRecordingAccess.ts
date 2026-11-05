import { AppDataSource } from "../db/datasource.js";
import type { BrowserSession } from "../db/entities/BrowserSession.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import type { Role } from "../db/entities/Membership.js";

/**
 * Who may watch a browser recording, wherever it's shown. It holds the whole screen,
 * sign-in pages included, so there's no wider audience to fall back to.
 *
 * A Member browser is a person's own computer, so its recording stays with that
 * owner whatever their company role. Genosyn's own browser is company equipment:
 * its recordings are for the company's owners and admins, and nobody else.
 */
export async function mayWatchBrowserRecording(
  reader: { userId?: string | null; role?: Role | null },
  session: Pick<BrowserSession, "companyId" | "memberBrowserId">,
): Promise<boolean> {
  if (session.memberBrowserId) {
    if (!reader.userId) return false;
    return AppDataSource.getRepository(MemberBrowser).existsBy({
      id: session.memberBrowserId,
      companyId: session.companyId,
      ownerUserId: reader.userId,
    });
  }
  return reader.role === "owner" || reader.role === "admin";
}
