import assert from "node:assert/strict";
import { test } from "node:test";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import type { MailboxMessage } from "./mailbox/types.js";
import { readMailMessageForAgent } from "./agentReads.js";

const account = Object.assign(new MailAccount(), { id: "mailbox", companyId: "company" });
function message(bodyText: string) {
  return Object.assign(new MailMessage(), {
    id: "local-message",
    companyId: account.companyId,
    accountId: account.id,
    gmailMessageId: "remote-message",
    gmailDraftId: "",
    labelIds: " INBOX ",
    bodyText,
    snippet: "snippet",
    attachmentsJson: "[]",
    sentAt: null,
    fromEmail: "writer@example.test",
    fromName: "",
    subject: "Long email",
    toEmails: "reader@example.test",
    ccEmails: "",
  });
}
function upstream(bodyText: string): MailboxMessage {
  return {
    ref: "remote-message",
    threadRef: "thread",
    labelIds: ["INBOX"],
    headers: [],
    snippet: "snippet",
    bodyText,
    bodyHtml: "",
    attachments: [],
    sentAt: null,
    sizeEstimate: bodyText.length,
    hasBodies: true,
    location: "",
  };
}

test("explicit upstream reading recovers body beyond the mirror cap in bounded chunks", async () => {
  const full = `New reply.\nOn Monday, Pat wrote:\n${"older history\n".repeat(50_000)}The final paragraph.`;
  const local = message(`${full.slice(0, 512 * 1024)}\n… [truncated]`);
  let fetched = 0;
  const mailbox = {
    getMessage: async (ref: string) => {
      assert.equal(ref, local.gmailMessageId);
      fetched++;
      return upstream(full);
    },
  };
  const mirror = await readMailMessageForAgent(account, local, {}, mailbox);
  assert.equal(fetched, 0);
  assert.equal(mirror.bodyCoverage.sourceComplete, false);
  let recovered = "";
  let offset: number | null = 0;
  let version: string | undefined;
  while (offset !== null) {
    const read = await readMailMessageForAgent(
      account,
      local,
      { source: "mailbox", includeQuoted: true, bodyOffset: offset, maxBodyChars: 20_000 },
      mailbox,
    );
    assert.ok(read.bodyText.length <= 20_000);
    assert.equal(read.bodyCoverage.sourceComplete, true);
    assert.equal(read.bodySource, "mailbox");
    assert.ok("bodyVersion" in read);
    if (version) assert.equal(read.bodyVersion, version);
    version = read.bodyVersion;
    recovered += read.bodyText;
    offset = read.bodyCoverage.nextOffset;
  }
  assert.equal(recovered, full);
  assert.match(local.bodyText, /\[truncated\]$/);
  assert.ok(fetched > 1);
});

test("upstream absence is an error and never silently becomes complete snippet coverage", async () => {
  const local = message("");
  await assert.rejects(
    readMailMessageForAgent(
      account,
      local,
      { source: "mailbox" },
      {
        getMessage: async () => ({ ...upstream(""), hasBodies: false }),
      },
    ),
    /did not return a full body/,
  );
  await assert.rejects(
    readMailMessageForAgent(
      account,
      local,
      { source: "mailbox" },
      {
        getMessage: async () => {
          throw new Error("Message no longer exists");
        },
      },
    ),
    /Message no longer exists/,
  );
  assert.equal((await readMailMessageForAgent(account, local)).bodyCoverage.sourceComplete, false);
});

test("upstream reads reject mismatched mailbox or message identity", async () => {
  let called = false;
  const mailbox = {
    getMessage: async () => {
      called = true;
      return { ...upstream("body"), ref: "other-message" };
    },
  };
  await assert.rejects(
    readMailMessageForAgent(
      account,
      { ...message("body"), companyId: "other-company" },
      { source: "mailbox" },
      mailbox,
    ),
    /does not belong/,
  );
  assert.equal(called, false);
  await assert.rejects(
    readMailMessageForAgent(account, message("body"), { source: "mailbox" }, mailbox),
    /different message/,
  );
});
