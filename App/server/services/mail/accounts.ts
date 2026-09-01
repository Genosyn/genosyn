import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailLabel } from "../../db/entities/MailLabel.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailHandover } from "../../db/entities/MailHandover.js";
import { MailChatMessage } from "../../db/entities/MailChatMessage.js";
import { MailDraftSendBatch } from "../../db/entities/MailDraftSendBatch.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailSavedSearch } from "../../db/entities/MailSavedSearch.js";
import { EmployeeMailAccountGrant } from "../../db/entities/EmployeeMailAccountGrant.js";
import { IntegrationConnection } from "../../db/entities/IntegrationConnection.js";
import {
  decryptConnectionConfig,
  getConnection,
  claimConnectionForCredentialWrite,
  persistConnectionConfigIfCurrent,
  withConnectionCredentialMutation,
} from "../integrations.js";
import {
  currentGoogleAccessToken,
  currentGoogleGrantedScope,
  ensureFreshGoogleToken,
  hasGoogleGmailMailboxScope,
} from "../../integrations/providers/google/auth.js";
import type { IntegrationConfig, IntegrationRuntimeContext } from "../../integrations/types.js";
import { getProfile } from "./gmailClient.js";
import { parseImapConnectionConfig, releaseImapConnection } from "./imapClient.js";
import type { MailAccountProvider } from "../../db/entities/MailAccount.js";

/**
 * MailAccount lifecycle + the credential seam between the Email section and
 * the Integrations framework.
 *
 * A MailAccount borrows an IntegrationConnection's credentials rather than
 * holding any of its own, and this module is the only place the Email code
 * touches `encryptedConfig`. For a `google` Connection that means the OAuth
 * recipe the Google provider uses — decrypt → ensureFreshGoogleToken
 * (refreshes when <60s to expiry) → re-encrypt and persist if the token
 * rotated. For an `imap` Connection it is simply a decrypt: an app password
 * does not rotate.
 */

/** Which mailbox backend a Connection's provider implies. */
export function mailProviderForConnection(provider: string): MailAccountProvider {
  if (provider === "imap") return "imap";
  if (provider === "google") return "gmail";
  throw new Error(
    "A mailbox needs a Google connection or an email account (IMAP) connection.",
  );
}

/** Get a fresh Gmail-capable access token for a connection, persisting any
 * rotated token back onto the row. Throws with a human-readable message when
 * the connection is unusable (wrong provider, Gmail scope not granted). */
async function freshGmailCredential(
  conn: IntegrationConnection,
): Promise<{ token: string; encryptedConfigSnapshot: string }> {
  if (conn.provider !== "google") {
    throw new Error("Mail accounts require a Google connection.");
  }
  const cfg = decryptConnectionConfig(conn);
  const credentialSnapshot = conn.encryptedConfig;
  let rotated: IntegrationConfig | null = null;
  const ctx: IntegrationRuntimeContext = {
    authMode: conn.authMode,
    config: cfg,
    setConfig(next) {
      rotated = next;
    },
  };
  const scope = currentGoogleGrantedScope(ctx);
  if (!hasGoogleGmailMailboxScope(scope)) {
    throw new Error(
      "This Google connection was authorized without the Gmail scope. Reconnect it with the Gmail product selected.",
    );
  }
  await ensureFreshGoogleToken(ctx);
  const token = currentGoogleAccessToken(ctx);
  let encryptedConfigSnapshot = credentialSnapshot;
  if (rotated) {
    const persisted = await persistConnectionConfigIfCurrent({
      connectionId: conn.id,
      companyId: conn.companyId,
      previousEncryptedConfig: credentialSnapshot,
      config: rotated,
    });
    if (!persisted) {
      throw new Error("The Google Connection changed while its token refreshed. Try again.");
    }
    encryptedConfigSnapshot = persisted;
  }
  return { token, encryptedConfigSnapshot };
}

export async function freshGmailAccessToken(conn: IntegrationConnection): Promise<string> {
  return (await freshGmailCredential(conn)).token;
}

/** Resolve the account's connection and return a fresh access token. */
export async function accessTokenForAccount(account: MailAccount): Promise<string> {
  const conn = await getConnection(account.companyId, account.connectionId);
  if (!conn) {
    throw new Error(
      "The Google connection behind this mailbox was deleted. Remove the mailbox and connect it again.",
    );
  }
  return freshGmailAccessToken(conn);
}

/**
 * Connect a mailbox: prove the Connection can actually reach a mailbox, read
 * the address off it, and create the row. The first heartbeat pass performs
 * the backfill.
 *
 * The address is read from the provider rather than taken from the caller on
 * purpose — it is what every later comparison ("did we send this?", "is this
 * a reply to us?") is made against, and a mailbox labelled with an address it
 * does not actually own would get those wrong in both directions.
 */
export async function createMailAccount(args: {
  companyId: string;
  connectionId: string;
  createdByUserId: string | null;
  /** Deterministic race-test seam; production callers omit it. */
  beforePersist?: () => Promise<void>;
}): Promise<MailAccount> {
  const repo = AppDataSource.getRepository(MailAccount);
  const existing = await repo.findOneBy({ connectionId: args.connectionId });
  if (existing) {
    throw new Error("That connection is already linked to a mailbox.");
  }
  const conn = await getConnection(args.companyId, args.connectionId);
  if (!conn) throw new Error("Connection not found");
  const provider = mailProviderForConnection(conn.provider);

  let address: string;
  let encryptedConfigSnapshot: string;
  if (provider === "imap") {
    // An app password does not rotate, so there is no token to refresh and
    // nothing to write back — the snapshot is simply what is on the row.
    const config = parseImapConnectionConfig(
      decryptConnectionConfig(conn) as Record<string, unknown>,
    );
    address = config.address;
    encryptedConfigSnapshot = conn.encryptedConfig;
  } else {
    const credential = await freshGmailCredential(conn);
    address = (await getProfile(credential.token)).emailAddress;
    encryptedConfigSnapshot = credential.encryptedConfigSnapshot;
  }

  return withConnectionCredentialMutation(args.connectionId, () =>
    AppDataSource.transaction(async (manager) => {
      const currentConnection = await claimConnectionForCredentialWrite(manager, {
        companyId: args.companyId,
        connectionId: args.connectionId,
        expectedEncryptedConfig: encryptedConfigSnapshot,
      });
      if (!currentConnection) {
        throw new Error(
          "The Connection changed while the mailbox was being linked. Try again.",
        );
      }
      await args.beforePersist?.();
      const txRepo = manager.getRepository(MailAccount);
      if (await txRepo.findOneBy({ connectionId: args.connectionId })) {
        throw new Error("That connection is already linked to a mailbox.");
      }
      const account = txRepo.create({
        companyId: args.companyId,
        connectionId: args.connectionId,
        provider,
        address,
        status: "active",
        statusMessage: "",
        historyId: "",
        syncCursor: "",
        lastSyncAt: null,
        syncState: "idle",
        syncAttemptId: null,
        syncStartedAt: null,
        syncFinishedAt: null,
        backfilledAt: null,
        createdByUserId: args.createdByUserId,
      });
      return txRepo.save(account);
    }),
  );
}

/** Delete the account and its entire local mirror. The underlying Google
 * connection is left alone — other surfaces may still use it. */
export async function deleteMailAccount(account: MailAccount): Promise<void> {
  const id = account.id;
  // Remove the coordination row first. An in-flight sync fences its final
  // commit against this row and performs one last mirror purge when it sees
  // the account disappeared, covering a Gmail response that was already on
  // the wire when Disconnect was clicked.
  await AppDataSource.getRepository(MailAccount).delete({ id });
  await purgeMailAccountMirror(id);
}

/** Remove every local row owned by a mailbox. Exported for the sync worker's
 * deletion fence: no stale response may resurrect an orphaned mirror. */
export async function purgeMailAccountMirror(id: string): Promise<void> {
  // A pooled IMAP socket outliving its mailbox would keep an authenticated
  // connection open to a server the company has just disconnected.
  await releaseImapConnection(id);
  await AppDataSource.getRepository(MailInboundAutomation).delete({ accountId: id });
  await AppDataSource.getRepository(MailMessage).delete({ accountId: id });
  await AppDataSource.getRepository(MailThread).delete({ accountId: id });
  await AppDataSource.getRepository(MailLabel).delete({ accountId: id });
  await AppDataSource.getRepository(MailRule).delete({ accountId: id });
  await AppDataSource.getRepository(MailHandover).delete({ accountId: id });
  await AppDataSource.getRepository(MailChatMessage).delete({ accountId: id });
  await AppDataSource.getRepository(MailDraftSendBatch).delete({ accountId: id });
  await AppDataSource.getRepository(MailSavedSearch).delete({ accountId: id });
  await AppDataSource.getRepository(EmployeeMailAccountGrant).delete({
    accountId: id,
  });
}

export type MailAccountDTO = {
  id: string;
  connectionId: string;
  /** Which backend drives this mailbox — the UI words a few things per-provider. */
  provider: MailAccount["provider"];
  address: string;
  status: string;
  statusMessage: string;
  lastSyncAt: string | null;
  syncState: MailAccount["syncState"];
  syncAttemptId: string | null;
  syncStartedAt: string | null;
  syncFinishedAt: string | null;
  backfilledAt: string | null;
  backfilledCount: number;
  /** AI triage of newly-arrived mail — on unless a Member turned it off. */
  aiAnalysisEnabled: boolean;
  /** Null means "whichever granted employee is best placed", resolved per message. */
  aiAnalysisEmployeeId: string | null;
  /** Null inherits the employee's active model. */
  aiAnalysisModelId: string | null;
  createdAt: string;
};

export function serializeMailAccount(a: MailAccount): MailAccountDTO {
  return {
    id: a.id,
    connectionId: a.connectionId,
    provider: a.provider,
    address: a.address,
    status: a.status,
    statusMessage: a.statusMessage,
    lastSyncAt: a.lastSyncAt ? a.lastSyncAt.toISOString() : null,
    syncState: a.syncState,
    syncAttemptId: a.syncAttemptId,
    syncStartedAt: a.syncStartedAt ? a.syncStartedAt.toISOString() : null,
    syncFinishedAt: a.syncFinishedAt ? a.syncFinishedAt.toISOString() : null,
    backfilledAt: a.backfilledAt ? a.backfilledAt.toISOString() : null,
    backfilledCount: a.backfilledCount,
    aiAnalysisEnabled: a.aiAnalysisEnabled,
    aiAnalysisEmployeeId: a.aiAnalysisEmployeeId,
    aiAnalysisModelId: a.aiAnalysisModelId,
    createdAt: a.createdAt.toISOString(),
  };
}
