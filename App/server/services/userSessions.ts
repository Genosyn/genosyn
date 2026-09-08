import type { Request } from "express";
import { LessThanOrEqual } from "typeorm";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { User } from "../db/entities/User.js";
import { UserSession } from "../db/entities/UserSession.js";

/** Signed identity also carried by one-shot realtime handshake credentials. */
export type UserSessionIdentity = {
  userId: string;
  userSessionId: string;
  sessionVersion: number;
  expiresAt: number;
};

export function userSessionIdentity(
  value: Partial<UserSessionIdentity> | null | undefined,
): UserSessionIdentity | null {
  if (
    !value ||
    typeof value.userId !== "string" ||
    !value.userId ||
    typeof value.userSessionId !== "string" ||
    !value.userSessionId ||
    !Number.isSafeInteger(value.sessionVersion) ||
    !Number.isSafeInteger(value.expiresAt)
  ) {
    return null;
  }
  return value as UserSessionIdentity;
}

export async function createUserSession(
  user: Pick<User, "id" | "sessionVersion">,
): Promise<UserSessionIdentity> {
  const repo = AppDataSource.getRepository(UserSession);
  const expiresAt = new Date(Date.now() + config.security.sessionMaxAgeDays * 86_400_000);
  // Expired rows are inert; reclaim them on sign-in without a separate worker.
  await repo.delete({ expiresAt: LessThanOrEqual(new Date()) });
  const session = await repo.save(
    repo.create({ userId: user.id, sessionVersion: user.sessionVersion, expiresAt }),
  );
  return {
    userId: user.id,
    userSessionId: session.id,
    sessionVersion: user.sessionVersion,
    expiresAt: expiresAt.getTime(),
  };
}

/** Both the signed lifetime and the persisted sign-in must still be valid. */
export async function resolveUserSession(
  value: Partial<UserSessionIdentity> | null | undefined,
): Promise<User | null> {
  const identity = userSessionIdentity(value);
  if (!identity || identity.expiresAt <= Date.now()) return null;
  const session = await AppDataSource.getRepository(UserSession).findOneBy({
    id: identity.userSessionId,
    userId: identity.userId,
    sessionVersion: identity.sessionVersion,
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;
  const user = await AppDataSource.getRepository(User).findOneBy({ id: identity.userId });
  return user?.sessionVersion === identity.sessionVersion &&
    Math.min(identity.expiresAt, session.expiresAt.getTime()) > Date.now()
    ? user
    : null;
}

/** Removing one row signs out this browser without revoking other browsers. */
export async function revokeCurrentUserSession(req: Request): Promise<void> {
  const identity = userSessionIdentity(req.session);
  if (identity) {
    await AppDataSource.getRepository(UserSession).delete({
      id: identity.userSessionId,
      userId: identity.userId,
      sessionVersion: identity.sessionVersion,
    });
  }
  req.session = null;
}
