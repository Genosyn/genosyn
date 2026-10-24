import { AppDataSource } from "../../db/datasource.js";
import { ConnectedApp } from "../../db/entities/ConnectedApp.js";
import { revokeConnectedApp } from "./tokens.js";

/**
 * A Member's connected apps in one company, as Settings → API keys lists them.
 * Personal like API keys: each Member sees and disconnects only their own.
 */

export type ConnectedAppView = {
  id: string;
  name: string;
  /** Where the app's sign-in returned to: the app's own address, such as https://claude.ai. */
  redirectOrigin: string;
  scope: string;
  lastUsedAt: string | null;
  /** When it stops working unless it refreshes before then. */
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: ConnectedApp["revokedReason"];
  createdAt: string;
};

function originOf(uri: string): string {
  try {
    return new URL(uri).origin;
  } catch {
    return uri;
  }
}

export function serializeConnectedApp(app: ConnectedApp): ConnectedAppView {
  return {
    id: app.id,
    name: app.name,
    redirectOrigin: originOf(app.redirectUri),
    scope: app.scope,
    lastUsedAt: app.lastUsedAt ? app.lastUsedAt.toISOString() : null,
    expiresAt: app.expiresAt.toISOString(),
    revokedAt: app.revokedAt ? app.revokedAt.toISOString() : null,
    revokedReason: app.revokedReason,
    createdAt: app.createdAt.toISOString(),
  };
}

/** Every app the Member connected to the company, newest first, disconnected ones included. */
export async function listConnectedApps(
  companyId: string,
  userId: string,
): Promise<ConnectedAppView[]> {
  const rows = await AppDataSource.getRepository(ConnectedApp).find({
    where: { companyId, userId },
    order: { createdAt: "DESC" },
    take: 200,
  });
  return rows.map(serializeConnectedApp);
}

/** Disconnect one of the Member's own apps. Null when there is no such app of theirs. */
export async function disconnectConnectedApp(
  companyId: string,
  userId: string,
  id: string,
): Promise<ConnectedAppView | null> {
  const app = await AppDataSource.getRepository(ConnectedApp).findOneBy({ id, companyId, userId });
  if (!app) return null;
  const revoked = await revokeConnectedApp(app, "member", userId);
  return serializeConnectedApp(revoked ?? app);
}
