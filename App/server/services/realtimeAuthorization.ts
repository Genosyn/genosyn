import type { Request } from "express";
import { AppDataSource } from "../db/datasource.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import {
  resolveUserSession,
  userSessionIdentity,
  type UserSessionIdentity,
} from "./userSessions.js";

export type RealtimeAuthentication =
  | { kind: "session"; identity: UserSessionIdentity }
  | { kind: "api-key"; keyId: string };

/** Capture the exact credential already checked by the HTTP auth middleware. */
export function realtimeAuthenticationForRequest(req: Request): RealtimeAuthentication {
  if (req.apiKey) return { kind: "api-key", keyId: req.apiKey.id };
  const identity = userSessionIdentity(req.session);
  if (!identity) throw new Error("A valid sign-in is required for realtime access");
  return { kind: "session", identity };
}

export function realtimeHandshakeExpiry(authentication: RealtimeAuthentication): number {
  const ttlExpiry = Date.now() + 60_000;
  return authentication.kind === "session"
    ? Math.min(ttlExpiry, authentication.identity.expiresAt)
    : ttlExpiry;
}

/** No cache: every replica consults the current credential and membership. */
export async function realtimeUserIsAuthorized(
  userId: string,
  companyId: string,
  authentication: RealtimeAuthentication | undefined,
): Promise<boolean> {
  if (!authentication) return false;
  if (authentication.kind === "session") {
    if (authentication.identity.userId !== userId) return false;
    if (!(await resolveUserSession(authentication.identity))) return false;
  } else if (authentication.kind === "api-key") {
    const key = await AppDataSource.getRepository(ApiKey).findOneBy({
      id: authentication.keyId,
      companyId,
      userId,
    });
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt.getTime() <= Date.now())) {
      return false;
    }
    if (!(await AppDataSource.getRepository(User).existsBy({ id: userId }))) return false;
  } else {
    return false;
  }
  return AppDataSource.getRepository(Membership).existsBy({ userId, companyId });
}
