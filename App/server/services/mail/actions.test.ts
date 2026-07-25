import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { replyAllRecipients } from "./actions.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_reply_test";
const SELF = "owner@example.com";

async function createThreadWithMessage(input: {
  fromName: string;
  fromEmail: string;
  toEmails: string;
  ccEmails?: string;
}): Promise<{ account: MailAccount; thread: MailThread }> {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: "connection_mail_reply_test",
    address: SELF,
  });
  const thread = await insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: account.id,
    gmailThreadId: "gmail_thread_reply_test",
    subject: "Login access",
  });
  await insert(MailMessage, {
    companyId: COMPANY_ID,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "gmail_message_reply_test",
    gmailThreadId: thread.gmailThreadId,
    fromName: input.fromName,
    fromEmail: input.fromEmail,
    toEmails: input.toEmails,
    ccEmails: input.ccEmails ?? "",
    subject: thread.subject,
    labelIds: " INBOX ",
    sentAt: new Date("2026-07-25T10:00:00Z"),
  });
  return { account, thread };
}

describe("replyAllRecipients", () => {
  test("uses the sender email when their display name contains a comma", async () => {
    const { account, thread } = await createThreadWithMessage({
      fromName: "Ruhbaum, Thomas",
      fromEmail: "thomas@example.com",
      toEmails: SELF,
    });

    assert.deepEqual(await replyAllRecipients(account, thread), {
      to: "thomas@example.com",
      cc: "",
    });
  });

  test("keeps quoted comma display names together in reply-all recipients", async () => {
    const { account, thread } = await createThreadWithMessage({
      fromName: "Owner",
      fromEmail: SELF,
      toEmails: `"Ruhbaum, Thomas" <thomas@example.com>, Other <other@example.com>`,
      ccEmails: `"Doe, Jane" <jane@example.com>, ${SELF}`,
    });

    assert.deepEqual(await replyAllRecipients(account, thread), {
      to: "thomas@example.com",
      cc: "other@example.com, jane@example.com",
    });
  });
});
