import { AppDataSource } from "../db/datasource.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";

/**
 * A null result authorizes one privileged tool call. A string is a stable,
 * model-facing denial that must be returned without invoking the underlying
 * coding, browser, configured-MCP, or parallel-delegation tool.
 */
export type PrivilegedToolCallAuthorizer = () => Promise<string | null>;

/**
 * Build the live authorization seam for an administrative Member's AI turn.
 *
 * The membership and User auth-epoch lookups intentionally happen for every
 * privileged tool call.
 * Built-in Genosyn tools already re-check the same row in mcpInternal; this
 * authorizer closes the corresponding gap for in-process coding tools and the
 * long-lived browser / configured-MCP bridges.
 *
 * Revocation is sticky for the life of the turn. Re-adding, re-promoting, or
 * changing credentials for the Member later must not resurrect authority
 * delegated by an older browser request; they can start a fresh turn after
 * authenticating again.
 */
export function createPrivilegedMemberToolAuthorizer(args: {
  companyId: string;
  userId: string;
  /** User auth epoch observed when this model turn began. */
  sessionVersion: number;
}): PrivilegedToolCallAuthorizer {
  let revokedReason: string | null = null;

  return async () => {
    if (revokedReason) return revokedReason;

    const [membership, user] = await Promise.all([
      AppDataSource.getRepository(Membership).findOneBy({
        companyId: args.companyId,
        userId: args.userId,
      }),
      AppDataSource.getRepository(User).findOneBy({ id: args.userId }),
    ]);
    if (!user || user.sessionVersion !== args.sessionVersion) {
      revokedReason =
        "This privileged tool is unavailable because the requesting Member's authentication changed. Start a new turn after signing in again.";
      return revokedReason;
    }
    if (!membership) {
      revokedReason =
        "This privileged tool is unavailable because the requesting Member no longer has access to the company. Start a new turn after access is restored.";
      return revokedReason;
    }
    if (membership.role !== "owner" && membership.role !== "admin") {
      revokedReason =
        "This privileged tool is unavailable because the requesting Member is no longer an owner or admin. Continue only with the governed Genosyn tools that remain authorized.";
      return revokedReason;
    }
    return null;
  };
}
