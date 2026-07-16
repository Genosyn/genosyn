import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import {
  decryptConnectionConfig,
  encryptConnectionConfig,
  getConnection,
} from "../integrations.js";
import {
  currentGoogleAccessToken,
  currentGoogleGrantedScope,
  ensureFreshGoogleToken,
} from "../../integrations/providers/google/auth.js";
import type {
  IntegrationConfig,
  IntegrationRuntimeContext,
} from "../../integrations/types.js";
import { getProfile } from "./gmailClient.js";

/**
 * MailAccount lifecycle + the token seam between the Email section and the
 * Integrations framework.
 *
 * A MailAccount borrows the OAuth credentials of a `google`
 * IntegrationConnection — this module is the only place the Email code
 * touches encryptedConfig, and it follows the same recipe the Google
 * provider uses: decrypt → ensureFreshGoogleToken (refreshes when <60s to
 * expiry) → re-encrypt and persist if the token rotated.
 */

const GMAIL_SCOPE_MARKER = "auth/gmail.";

/** Get a fresh Gmail-capable access token for a connection, persisting any
 * rotated token back onto the row. Throws with a human-readable message when
 * the connection is unusable (wrong provider, Gmail scope not granted). */
export async function freshGmailAccessToken(
  conn: IntegrationConnection,
): Promise<string> {
  if (conn.provider !== "google") {
    throw new Error("Mail accounts require a Google connection.");
  }
  const cfg = decryptConnectionConfig(conn);
  let rotated: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    authMode: conn.authMode,
    config: cfg,
    setConfig(next) {
      rotated = next;
    },
  };
  const scope = currentGoogleGrantedScope(ctx);
  if (!scope.includes(GMAIL_SCOPE_MARKER)) {
    throw new Error(
      "This Google connection was authorized without the Gmail scope. Reconnect it with the Gmail product selected.",
    );
  }
  await ensureFreshGoogleToken(ctx);
  const token = currentGoogleAccessToken(ctx);
  if (rotated) {
    conn.encryptedConfig = encryptConnectionConfig(rotated);
    await AppDataSource.getRepository(IntegrationConnection).save(conn);
  }
  return token;
}

/** Resolve the account's connection and return a fresh access token. */
export async function accessTokenForAccount(
  account: MailAccount,
): Promise<string> {
  const conn = await getConnection(account.companyId, account.connectionId);
  if (!conn) {
    throw new Error(
      "The Google connection behind this mail account was deleted. Remove the account and connect again.",
    );
  }
  return freshGmailAccessToken(conn);
}

/**
 * Connect a mailbox: verify the connection can speak Gmail, read the
 * profile for the address + initial history cursor, and create the row.
 * The first heartbeat pass performs the backfill.
 */
export async function createMailAccount(args: {
  companyId: string;
  connectionId: string;
  createdByUserId: string | null;
}): Promise<MailAccount> {
  const repo = AppDataSource.getRepository(MailAccount);
  const existing = await repo.findOneBy({ connectionId: args.connectionId });
  if (existing) {
    throw new Error("That Google connection is already linked to a mail account.");
  }
  const conn = await getConnection(args.companyId, args.connectionId);
  if (!conn) throw new Error("Connection not found");
  const token = await freshGmailAccessToken(conn);
  const profile = await getProfile(token);
  const account = repo.create({
    companyId: args.companyId,
    connectionId: args.connectionId,
    address: profile.emailAddress,
    status: "active",
    statusMessage: "",
    historyId: "",
    lastSyncAt: null,
    backfilledAt: null,
    createdByUserId: args.createdByUserId,
  });
  return repo.save(account);
}

/** Delete the account and its entire local mirror. The underlying Google
 * connection is left alone — other surfaces may still use it. */
export async function deleteMailAccount(account: MailAccount): Promise<void> {
  const id = account.id;
  await AppDataSource.getRepository(MailMessage).delete({ accountId: id });
  await AppDataSource.getRepository(MailThread).delete({ accountId: id });
  await AppDataSource.getRepository(MailLabel).delete({ accountId: id });
  await AppDataSource.getRepository(MailRule).delete({ accountId: id });
  await AppDataSource.getRepository(MailHandover).delete({ accountId: id });
  await AppDataSource.getRepository(EmployeeMailAccountGrant).delete({
    accountId: id,
  });
  await AppDataSource.getRepository(MailAccount).delete({ id });
}

export type MailAccountDTO = {
  id: string;
  connectionId: string;
  address: string;
  status: string;
  statusMessage: string;
  lastSyncAt: string | null;
  backfilledAt: string | null;
  backfilledCount: number;
  createdAt: string;
};

export function serializeMailAccount(a: MailAccount): MailAccountDTO {
  return {
    id: a.id,
    connectionId: a.connectionId,
    address: a.address,
    status: a.status,
    statusMessage: a.statusMessage,
    lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
    backfilledAt: a.backfilledAt ? a.backfilledAt.toISOString() : null,
    backfilledCount: a.backfilledCount,
    createdAt: a.createdAt.toISOString(),
  };
}
