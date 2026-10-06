import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { PipelineRun } from "../../db/entities/PipelineRun.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import { dispatchEmailReceived } from "./events.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_pipeline_events_test";

describe("email received payload", () => {
  test("lists a quoted name holding a comma or a quote as one recipient, as written", async () => {
    const account = await insert(MailAccount, {
      companyId: COMPANY_ID,
      connectionId: testId("connection"),
      address: "owner@example.com",
    });
    await insert(Pipeline, {
      companyId: COMPANY_ID,
      name: "Inbound email",
      slug: "inbound-email",
      enabled: true,
      graphJson: JSON.stringify({
        nodes: [{ id: "email-trigger", type: "trigger.emailReceived", x: 0, y: 0, config: {} }],
        edges: [],
      }),
    });
    const message = await insert(MailMessage, {
      companyId: COMPANY_ID,
      accountId: account.id,
      threadId: testId("thread"),
      gmailMessageId: testId("message"),
      gmailThreadId: testId("provider-thread"),
      toEmails: '"Doe, Zoë" <doe@example.com>, "Åsa \\"Q" <q@example.com>, plain@example.com',
      ccEmails: 'Bob <bob@example.com>, "Lee, Ann" <ann@example.com>',
    });

    await dispatchEmailReceived(message.id, { failOnRejected: true });

    const runs = await AppDataSource.getRepository(PipelineRun).find();
    assert.equal(runs.length, 1);
    const payload = JSON.parse(runs[0].inputJson) as { message: { to: string[]; cc: string[] } };
    // Entries keep their names, as before: Pipeline steps read them as written.
    assert.deepEqual(payload.message.to, [
      '"Doe, Zoë" <doe@example.com>',
      '"Åsa \\"Q" <q@example.com>',
      "plain@example.com",
    ]);
    assert.deepEqual(payload.message.cc, ["Bob <bob@example.com>", '"Lee, Ann" <ann@example.com>']);
  });
});
