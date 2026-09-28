import { AppDataSource } from "../db/datasource.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import type { IntegrationConfig } from "../integrations/types.js";
import { recordAudit } from "./audit.js";
import {
  createOauthConnection,
  deleteConnection,
  updateOauthConnectionConfig,
} from "./integrations.js";
import { createMailAccount } from "./mail/accounts.js";
import { queueAccountSync } from "./mail/sync.js";

/** Shared by direct callbacks and hosted sign-in polling. A successful email
 * sign-in means the mailbox exists, not merely that credentials were saved. */
export async function completeOauth(args: {
  companyId: string;
  userId: string;
  provider: string;
  label: string;
  config: IntegrationConfig;
  accountHint: string;
  existingConnectionId?: string;
  linkMailbox?: boolean;
}) {
  const connection = args.existingConnectionId
    ? await updateOauthConnectionConfig({
        ...args,
        connectionId: args.existingConnectionId,
      })
    : await createOauthConnection(args);
  if (!connection) throw new Error("The Connection was deleted while sign-in was open.");

  let mailboxAddress: string | null = null;
  let createdMailbox: MailAccount | null = null;
  try {
    if (args.linkMailbox) {
      const existing = await AppDataSource.getRepository(MailAccount).findOneBy({
        companyId: args.companyId,
        connectionId: connection.id,
      });
      const mailbox =
        existing ??
        (await createMailAccount({
          companyId: args.companyId,
          connectionId: connection.id,
          createdByUserId: args.userId,
        }));
      mailboxAddress = mailbox.address;
      if (!existing) createdMailbox = mailbox;
    }
  } catch (error) {
    // A fresh failed mailbox connect should not strand a duplicate credential
    // that makes a retry confusing. Reconnect keeps the existing row/grants.
    if (!args.existingConnectionId) {
      await deleteConnection(args.companyId, connection.id);
    }
    throw error;
  }

  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.userId,
    action: args.existingConnectionId ? "connection.reconnect" : "connection.create",
    targetType: "connection",
    targetId: connection.id,
    targetLabel: `${connection.provider} · ${connection.label}`,
    metadata: { provider: connection.provider, authMode: "oauth2" },
  });
  if (createdMailbox) {
    await recordAudit({
      companyId: args.companyId,
      actorUserId: args.userId,
      action: "mail.account.connect",
      targetType: "mail_account",
      targetId: createdMailbox.id,
      targetLabel: createdMailbox.address,
      metadata: { provider: createdMailbox.provider, via: "oauth" },
    });
    await queueAccountSync(createdMailbox.id).catch(() => {});
  }
  return { connection, mailboxAddress };
}
