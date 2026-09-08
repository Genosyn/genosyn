import type { Request } from "express";
import { createUserSession } from "../services/userSessions.js";

/** Upgrade a route test's explicit signed-session fixture to a persisted login. */
export async function persistTestSession(req: Request): Promise<void> {
  const session = req.session;
  if (!session?.userId || session.userSessionId) return;
  const identity = await createUserSession({
    id: session.userId,
    sessionVersion: session.sessionVersion ?? 0,
  });
  req.session = { ...identity, ...session };
}
