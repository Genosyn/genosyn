import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailThread } from "../../db/entities/MailThread.js";

/**
 * The company-scoped reads every Email route starts from. A mailbox or thread
 * id from the URL is only ever resolved together with the company in the same
 * URL, so an id from another company reads as "not found", never as a row.
 */

export async function loadAccount(cid: string, accountId: string): Promise<MailAccount | null> {
  return AppDataSource.getRepository(MailAccount).findOneBy({
    id: accountId,
    companyId: cid,
  });
}

export async function loadThread(
  cid: string,
  threadId: string,
): Promise<{ thread: MailThread; account: MailAccount } | null> {
  const thread = await AppDataSource.getRepository(MailThread).findOneBy({
    id: threadId,
    companyId: cid,
  });
  if (!thread) return null;
  const account = await loadAccount(cid, thread.accountId);
  if (!account) return null;
  return { thread, account };
}
