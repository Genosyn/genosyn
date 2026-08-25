import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import {
  EmployeeMailAccountGrant,
  type MailAccessLevel,
} from "../../db/entities/EmployeeMailAccountGrant.js";
import { MailAccount } from "../../db/entities/MailAccount.js";
import { MailInboundAnalysis } from "../../db/entities/MailInboundAnalysis.js";
import { MailInboundAutomation } from "../../db/entities/MailInboundAutomation.js";
import { MailMessage } from "../../db/entities/MailMessage.js";
import { MailRule } from "../../db/entities/MailRule.js";
import { MailThread } from "../../db/entities/MailThread.js";
import { encryptSecret } from "../../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { analyzeInboundMessage } from "./analysis.js";
import { enqueueInboundAutomation, waitForMailAutomation } from "./automationQueue.js";
import { runRulesForNewMessage } from "./rules.js";

/**
 * AI triage as the inbound automation chain actually runs it.
 *
 * The production runner (`runDefaultEffects`) is module-private, so the tests
 * that need to observe its *shape* drive the real thing end to end —
 * `enqueueInboundAutomation(message)` with no options — and read the
 * consequences out of the database. A mailbox with no Pipelines, and rules
 * whose only action is the match counter, keeps that honest without a single
 * Gmail call.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const COMPANY_ID = "co_mail_automation_analysis_test";

async function mailbox(suffix: string, overrides: Partial<MailAccount> = {}): Promise<MailAccount> {
  return insert(MailAccount, {
    companyId: COMPANY_ID,
    // Deliberately unresolvable: the unsubscribe probe inside the analysis
    // facts asks for a Google connection, fails, and answers "no" — no socket.
    connectionId: `connection-${suffix}`,
    address: `${suffix}@example.com`,
    status: "active",
    aiAnalysisEnabled: true,
    ...overrides,
  });
}

async function inboundMessage(
  account: MailAccount,
  suffix: string,
  overrides: Partial<MailMessage> = {},
): Promise<MailMessage> {
  const thread = await insert(MailThread, {
    companyId: account.companyId,
    accountId: account.id,
    gmailThreadId: `gmail-thread-${suffix}`,
    subject: `Quote for twelve chairs (${suffix})`,
  });
  return insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: `gmail-message-${suffix}`,
    gmailThreadId: thread.gmailThreadId,
    fromName: "Dana Sender",
    fromEmail: "sender@example.com",
    toEmails: account.address,
    subject: `Quote for twelve chairs (${suffix})`,
    bodyText: "Please send a quote for twelve chairs.",
    ...overrides,
  });
}

/**
 * A rule that matches the fixture message and does nothing else. `matchCount`
 * is then a durable, Gmail-free record that the rules step of the chain really
 * ran — every real rule action talks to Gmail or starts an employee.
 */
async function matchingRule(
  account: MailAccount,
  overrides: Partial<MailRule> = {},
): Promise<MailRule> {
  return insert(MailRule, {
    companyId: account.companyId,
    accountId: account.id,
    name: "Watch the sender",
    enabled: true,
    position: 0,
    conditionsJson: JSON.stringify({ from: "sender@example.com" }),
    actionsJson: "[]",
    ...overrides,
  });
}

async function reader(
  account: MailAccount,
  suffix: string,
  model: Partial<AIModel> = {},
  accessLevel: MailAccessLevel = "draft",
): Promise<{ employee: AIEmployee; model: AIModel }> {
  const employee = await insert(AIEmployee, {
    companyId: account.companyId,
    name: `Jamie ${suffix}`,
    slug: `jamie-${suffix}`,
    role: "Inbox manager",
    soulBody: "Triage cautiously.",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: employee.id,
    accountId: account.id,
    accessLevel,
  });
  const saved = await insert(AIModel, {
    employeeId: employee.id,
    provider: "openai",
    model: "gpt-test",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "test-ciphertext" }),
    connectedAt: new Date("2026-08-14T09:00:00Z"),
    contextWindow: null,
    contextWindowSource: null,
    ...model,
  });
  return { employee, model: saved };
}

async function automation(gmailMessageId: string): Promise<MailInboundAutomation> {
  return AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({ gmailMessageId });
}

async function analysisFor(messageId: string): Promise<MailInboundAnalysis | null> {
  return AppDataSource.getRepository(MailInboundAnalysis).findOneBy({ messageId });
}

async function analysisCount(): Promise<number> {
  return AppDataSource.getRepository(MailInboundAnalysis).count();
}

async function matchCount(ruleId: string): Promise<number> {
  return (await AppDataSource.getRepository(MailRule).findOneByOrFail({ id: ruleId })).matchCount;
}

function sendSse(response: ServerResponse, payload: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end("data: [DONE]\n\n");
}

describe("inbound automation with AI analysis", () => {
  test("a stubbed effect runner still drives one delivery and analyses nothing", async () => {
    const account = await mailbox("stubbed");
    const message = await inboundMessage(account, "stubbed");
    await reader(account, "stubbed");
    const seen: Array<{ accountId: string; messageId: string }> = [];

    await enqueueInboundAutomation(message, {
      runEffects: async (effectAccount, effectMessage, _assertRunnable, beforeEffect) => {
        await beforeEffect();
        seen.push({ accountId: effectAccount.id, messageId: effectMessage.id });
      },
    });
    await waitForMailAutomation(account.id);

    const rows = await AppDataSource.getRepository(MailInboundAutomation).find({
      where: { accountId: account.id },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "succeeded");
    assert.equal(rows[0].errorMessage, "");
    assert.ok(rows[0].startedAt);
    assert.ok(rows[0].finishedAt);
    assert.deepEqual(seen, [{ accountId: account.id, messageId: message.id }]);
    // The seam replaces the whole default chain, analysis included, so every
    // other test here has to reach analysis by a route that really runs it.
    assert.equal(await analysisCount(), 0);
  });

  test("a mailbox with analysis switched off writes no row and still runs its rules", async () => {
    const account = await mailbox("disabled", { aiAnalysisEnabled: false });
    const message = await inboundMessage(account, "disabled");
    const rule = await matchingRule(account);
    // A reader is available and its model points nowhere reachable: if the
    // toggle were ignored, the attempt would leave a failed analysis row.
    await reader(account, "disabled", {
      provider: "custom",
      authMode: "customEndpoint",
      model: "unreachable",
      configJson: JSON.stringify({
        baseURLEncrypted: encryptSecret("http://127.0.0.1:1/v1"),
        modelId: "unreachable",
      }),
    });

    await enqueueInboundAutomation(message);
    await waitForMailAutomation(account.id);

    assert.equal(await analysisCount(), 0);
    assert.equal(await matchCount(rule.id), 1);
    const row = await automation(message.gmailMessageId);
    assert.equal(row.status, "succeeded");
    assert.equal(row.errorMessage, "");
  });

  test("an analysis that throws outright still lets the automation finish", async () => {
    // The only ownership mismatch the queue can hand the analysis service is a
    // message row whose companyId drifted from its mailbox — that is the one
    // reachable way to make `analyzeInboundMessage` throw rather than record a
    // failure, which is exactly what the chain's catch exists for.
    const account = await mailbox("throwing");
    const message = await inboundMessage(account, "throwing", {
      companyId: "co_mail_automation_analysis_other",
    });

    await enqueueInboundAutomation(message);
    await waitForMailAutomation(account.id);

    const row = await automation(message.gmailMessageId);
    assert.equal(row.status, "succeeded");
    assert.equal(row.errorMessage, "");
    assert.ok(row.finishedAt);
    assert.equal(await analysisCount(), 0);
  });

  test("a mailbox whose model is down records the failure and still runs its rules", async () => {
    const account = await mailbox("model-down");
    const message = await inboundMessage(account, "model-down");
    const rule = await matchingRule(account);
    await reader(account, "model-down");
    const steps: string[] = [];

    // `runDefaultEffects` is module-private, so this drives the same chain in
    // the same order with the model stubbed out: triage first, unfenced, then
    // the rules — and a triage failure must cost only its own row.
    await enqueueInboundAutomation(message, {
      runEffects: async (effectAccount, effectMessage, assertRunnable, beforeEffect) => {
        await assertRunnable();
        await analyzeInboundMessage(effectAccount, effectMessage, {
          runRestricted: async () => {
            steps.push("analysis");
            return { status: "error", error: "The AI Model is unavailable." };
          },
        }).catch((error) => {
          steps.push(`analysis-threw:${String(error)}`);
        });
        await assertRunnable();
        await runRulesForNewMessage(effectAccount, effectMessage.id, assertRunnable, async () => {
          steps.push("rule-effect");
          await beforeEffect();
        });
      },
    });
    await waitForMailAutomation(account.id);

    const analysis = await analysisFor(message.id);
    assert.ok(analysis);
    assert.equal(analysis.status, "failed");
    assert.equal(analysis.errorMessage, "The AI Model is unavailable.");
    assert.equal(analysis.category, "");
    assert.equal(analysis.summary, "");
    assert.equal(analysis.actionsJson, "[]");
    assert.ok(analysis.finishedAt);

    // The model went down and the rest of the chain ran anyway.
    assert.deepEqual(steps, ["analysis", "rule-effect"]);
    assert.equal(await matchCount(rule.id), 1);
    const row = await automation(message.gmailMessageId);
    assert.equal(row.status, "succeeded");
    assert.equal(row.errorMessage, "");
  });

  test("a mailbox paused while the model is reading requeues instead of failing", async () => {
    const account = await mailbox("paused-mid-read");
    const message = await inboundMessage(account, "paused-mid-read");
    const rule = await matchingRule(account);
    let turns = 0;

    // A model on loopback, so the real chain runs the real analysis and the
    // pause lands while the read is genuinely in flight.
    const server = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      turns += 1;
      if (turns === 1) {
        await AppDataSource.getRepository(MailAccount).update(
          { id: account.id },
          { status: "paused" },
        );
        sendSse(response, {
          id: "analysis-turn-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "mail-analysis-test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_analysis",
                    type: "function",
                    function: {
                      name: "submit_email_analysis",
                      arguments: JSON.stringify({
                        category: "quote_request",
                        summary: "The sender wants a price for twelve chairs.",
                        actions: [],
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        });
        return;
      }
      sendSse(response, {
        id: "analysis-turn-2",
        object: "chat.completion.chunk",
        created: 2,
        model: "mail-analysis-test",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }],
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const previousAllowlist = [...config.security.outboundPrivateHostAllowlist];
    config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");

    try {
      await reader(account, "paused-mid-read", {
        provider: "custom",
        model: "mail-analysis-test",
        authMode: "customEndpoint",
        configJson: JSON.stringify({
          baseURLEncrypted: encryptSecret(`http://127.0.0.1:${address.port}/v1`),
          modelId: "mail-analysis-test",
        }),
      });

      await enqueueInboundAutomation(message);
      await waitForMailAutomation(account.id);

      // Triage is not fenced by `beforeEffect`, so it was allowed to land.
      const analysis = await analysisFor(message.id);
      assert.ok(analysis);
      assert.equal(analysis.status, "succeeded");
      assert.equal(analysis.category, "quote_request");
      assert.equal(analysis.summary, "The sender wants a price for twelve chairs.");
      assert.equal(analysis.actionsJson, "[]");

      // Nothing past it started, and the delivery went back on the queue for
      // Resume rather than becoming a permanent failure.
      assert.equal(await matchCount(rule.id), 0);
      const row = await automation(message.gmailMessageId);
      assert.equal(row.status, "queued");
      assert.equal(row.startedAt, null);
      assert.equal(row.finishedAt, null);
      assert.equal(row.errorMessage, "");
    } finally {
      config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
