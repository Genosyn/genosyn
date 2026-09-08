import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { Suppression } from "../../db/entities/Suppression.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { blockMailSender, hasBlockedSender } from "./blockedSenders.js";
import { messageMatches, runRulesForNewMessage } from "./rules.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

async function fixture() {
  const account = await insert(MailAccount, {
    companyId: "company",
    connectionId: "connection",
    address: "team@example.com",
  });
  const thread = await insert(MailThread, {
    companyId: account.companyId,
    accountId: account.id,
    gmailThreadId: "upstream-thread",
  });
  const message = await insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: "upstream-message",
    gmailThreadId: thread.gmailThreadId,
    fromEmail: "Spam@sender.example",
    labelIds: " INBOX ",
  });
  return { account, thread, message };
}

describe("mailbox-local inbound blocking", () => {
  test("files upstream, creates an exact sender rule once and never creates outbound suppression", async () => {
    const scene = await fixture();
    let files = 0;
    const dependencies = {
      fileSpam: async (_account: MailAccount, _thread: MailThread, action: string) => {
        assert.equal(action, "spam");
        files++;
      },
    };
    const first = await blockMailSender(scene, dependencies);
    const second = await blockMailSender(scene, dependencies);
    assert.equal(first.rule.id, second.rule.id);
    assert.equal(first.email, "spam@sender.example");
    assert.deepEqual(JSON.parse(first.rule.conditionsJson), { fromExact: "spam@sender.example" });
    assert.deepEqual(JSON.parse(first.rule.actionsJson), [{ type: "spam" }]);
    assert.equal(await AppDataSource.getRepository(MailRule).count(), 1);
    assert.equal(await AppDataSource.getRepository(Suppression).count(), 0);
    assert.equal(files, 2);
    assert.equal(await hasBlockedSender(scene.account, scene.message), true);
    await AppDataSource.getRepository(MailRule).update({ id: first.rule.id }, { enabled: false });
    assert.equal(await hasBlockedSender(scene.account, scene.message), false);
  });

  test("upstream failures leave no silently enabled block rule", async () => {
    const scene = await fixture();
    await assert.rejects(
      blockMailSender(scene, {
        fileSpam: async () => {
          throw new Error("Provider unavailable");
        },
      }),
      /Provider unavailable/,
    );
    assert.equal(await AppDataSource.getRepository(MailRule).count(), 0);
  });

  test("never blocks the mailbox, an outbound draft, or a different company/thread", async () => {
    const scene = await fixture();
    let called = false;
    const dependencies = {
      fileSpam: async () => {
        called = true;
      },
    };
    for (const patch of [
      { fromEmail: scene.account.address },
      { labelIds: " SENT " },
      { labelIds: " DRAFT " },
      { companyId: "another" },
      { threadId: "another" },
      { fromEmail: "not an address" },
    ]) {
      await assert.rejects(
        blockMailSender(
          { ...scene, message: Object.assign(new MailMessage(), scene.message, patch) },
          dependencies,
        ),
      );
    }
    assert.equal(called, false);
  });

  test("exact sender filters cannot swallow a domain, substring, display name, or malformed address", async () => {
    const { message } = await fixture();
    assert.equal(messageMatches({ fromExact: "SPAM@sender.example" }, message), true);
    for (const fromExact of [
      "sender.example",
      "am@sender.example",
      "",
      "Spam <spam@sender.example>",
    ]) {
      assert.equal(messageMatches({ fromExact }, message), false, fromExact);
    }
    assert.equal(
      messageMatches(
        { fromExact: "spam@sender.example" },
        Object.assign(new MailMessage(), message, { fromEmail: "notspam@sender.example" }),
      ),
      false,
    );
  });
});

test("future blocked mail is filed before broad work rules and records its match", async () => {
  const scene = await fixture();
  const { rule } = await blockMailSender(scene, { fileSpam: async () => {} });
  const broad = await insert(MailRule, {
    companyId: scene.account.companyId,
    accountId: scene.account.id,
    name: "Broad work",
    position: 0,
    conditionsJson: "{}",
    actionsJson: "[]",
  });
  let files = 0;
  await runRulesForNewMessage(scene.account, scene.message.id, undefined, undefined, {
    threadAction: async (_account, _thread, action) => {
      assert.equal(action, "spam");
      files++;
    },
    evaluateAi: async () => {
      assert.fail("Blocked mail needs no AI call");
    },
  });
  assert.equal(files, 1);
  const stored = await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: rule.id });
  assert.equal(stored.matchCount, 1);
  assert.ok(stored.lastMatchedAt);
  assert.equal(
    (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: broad.id })).matchCount,
    0,
  );
});

test("a block rule paused before filing is not applied or counted", async () => {
  const scene = await fixture();
  const { rule } = await blockMailSender(scene, { fileSpam: async () => {} });
  await runRulesForNewMessage(
    scene.account,
    scene.message.id,
    undefined,
    async () => {
      await AppDataSource.getRepository(MailRule).update({ id: rule.id }, { enabled: false });
    },
    {
      threadAction: async () => {
        assert.fail("A paused rule cannot file mail");
      },
    },
  );
  assert.equal(
    (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: rule.id })).matchCount,
    0,
  );
});
