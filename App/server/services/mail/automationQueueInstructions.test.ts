import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../../config.js";
import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { AIModel } from "../../db/entities/AIModel.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
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
import { FakeMailbox } from "../../test/fakeMailbox.js";
import { agentRuntime } from "../agent/runtime.js";
import { refreshStanddowns } from "../standdowns.js";
import {
  analyzeInboundMessage,
  type MailAnalysisFacts,
  type MailAnalysisOptions,
} from "./analysis.js";
import {
  applyAutomaticAnalysisActions,
  parseAutoActions,
  type MailAutomaticActionFences,
} from "./analysisAutomation.js";
import {
  enqueueInboundAutomation,
  runDefaultMailEffects,
  runMailAutomationQueuePass,
  waitForMailAutomation,
} from "./automationQueue.js";
import { runRulesForNewMessage } from "./rules.js";
import { labelIdsToColumn } from "./store.js";

/**
 * The instructions as the inbound queue runs them: the arrival read records
 * the steps, the queue carries them out behind its own fences, and only then
 * do the rules and Pipelines run. The model and the mail server are stand-ins;
 * the queue, the services and the database are real.
 */

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  await refreshStanddowns();
});
after(closeTestDb);

const COMPANY_ID = "co_mail_queue_instructions_test";

type World = {
  account: MailAccount;
  reader: AIEmployee;
  thread: MailThread;
  message: MailMessage;
  mailbox: FakeMailbox;
  unsubscribes: string[];
  steps: string[];
};

async function world(
  options: { accessLevel?: MailAccessLevel; account?: Partial<MailAccount> } = {},
): Promise<World> {
  const account = await insert(MailAccount, {
    companyId: COMPANY_ID,
    connectionId: `connection_${randomUUID()}`,
    address: "owner@example.com",
    status: "active",
    aiAnalysisEnabled: true,
    ...options.account,
  });
  const reader = await insert(AIEmployee, {
    companyId: COMPANY_ID,
    name: "Jamie Mallers",
    slug: `jamie-${randomUUID()}`,
    role: "Inbox manager",
  });
  await insert(EmployeeMailAccountGrant, {
    employeeId: reader.id,
    accountId: account.id,
    accessLevel: options.accessLevel ?? "draft",
  });
  await insert(AIModel, {
    employeeId: reader.id,
    provider: "openai",
    model: "gpt-test",
    authMode: "apikey",
    isActive: true,
    configJson: JSON.stringify({ apiKeyEncrypted: "test-ciphertext" }),
    connectedAt: new Date(),
  });
  const suffix = randomUUID();
  const labels = ["INBOX", "UNREAD"];
  const thread = await insert(MailThread, {
    companyId: COMPANY_ID,
    accountId: account.id,
    gmailThreadId: `thread-${suffix}`,
    subject: "Spring sale",
    labelIds: labelIdsToColumn(labels),
    unread: true,
    messageCount: 1,
  });
  const message = await insert(MailMessage, {
    companyId: COMPANY_ID,
    accountId: account.id,
    threadId: thread.id,
    gmailMessageId: `message-${suffix}`,
    gmailThreadId: thread.gmailThreadId,
    fromName: "Shop",
    fromEmail: "news@shop.example",
    toEmails: account.address,
    subject: "Spring sale",
    bodyText: "Everything is 40% off.",
    labelIds: labelIdsToColumn(labels),
  });
  const mailbox = new FakeMailbox();
  mailbox.seed({ ref: message.gmailMessageId, threadRef: thread.gmailThreadId, labelIds: labels });
  return { account, reader, thread, message, mailbox, unsubscribes: [], steps: [] };
}

const NEWSLETTER_FACTS: MailAnalysisFacts = {
  unsubscribeAvailable: true,
  unsubscribeHost: "lists.shop.example",
  handoverCandidates: [],
  canDraft: true,
  threadSubject: "Spring sale",
  replyTo: "news@shop.example",
};

/** The real read and the real step runner, with the model and mail server stood in. */
function effects(
  w: World,
  submission: Record<string, unknown>,
  extra: {
    afterRead?: () => Promise<void>;
    facts?: Partial<MailAnalysisFacts>;
  } = {},
) {
  return {
    reconcileDefaults: async () => {},
    analyzeInbound: async (
      account: MailAccount,
      message: MailMessage,
      _dependencies?: unknown,
      options?: MailAnalysisOptions,
    ) => {
      w.steps.push(options?.arrival ? "read:arrival" : "read:manual");
      const row = await analyzeInboundMessage(
        account,
        message,
        {
          gatherFacts: async () => ({ ...NEWSLETTER_FACTS, ...extra.facts }),
          runRestricted: async (params) => {
            await params.tools[0].run(submission);
            return { status: "ok", finalText: "", steps: 1 };
          },
        },
        options,
      );
      await extra.afterRead?.();
      return row;
    },
    applyInstructions: async (
      account: MailAccount,
      message: MailMessage,
      analysisId: string,
      fences?: MailAutomaticActionFences,
    ) => {
      w.steps.push("instructions");
      return applyAutomaticAnalysisActions(account, message, analysisId, fences, {
        mailbox: async () => w.mailbox,
        unsubscribe: async (_account, unsubscribed) => {
          w.unsubscribes.push(unsubscribed.id);
          return { host: "lists.shop.example", status: 200 };
        },
      });
    },
    applyRules: async (
      account: MailAccount,
      messageId: string,
      assertWritable?: () => void | Promise<void>,
      beforeEffect?: () => void | Promise<void>,
    ) => {
      w.steps.push("rules");
      await runRulesForNewMessage(account, messageId, assertWritable, beforeEffect, {
        unsubscribe: async () => {
          w.unsubscribes.push(`rule:${messageId}`);
          return { host: "lists.shop.example", status: 200 };
        },
      });
    },
    dispatchReceived: async () => {
      w.steps.push("pipelines");
    },
  };
}

const MARKETING = {
  category: "marketing",
  summary: "A shop newsletter.",
  actions: [{ kind: "thread_action", label: "Archive", action: "archive" }],
  automaticActions: [
    { instruction: 1, action: "unsubscribe", reason: "A store newsletter." },
    { instruction: 2, action: "star", reason: "It asks for a reply about an order." },
  ],
};

async function analysisOf(message: MailMessage): Promise<MailInboundAnalysis> {
  return AppDataSource.getRepository(MailInboundAnalysis).findOneByOrFail({
    messageId: message.id,
  });
}

async function delivery(message: MailMessage): Promise<MailInboundAutomation> {
  return AppDataSource.getRepository(MailInboundAutomation).findOneByOrFail({
    messageId: message.id,
  });
}

describe("instructions on newly arrived mail, through the inbound queue", () => {
  test("the default instructions unsubscribe and star a new email, before the rules run", async () => {
    const w = await world();
    await enqueueInboundAutomation(w.message, { defaultEffects: effects(w, MARKETING) });
    await waitForMailAutomation(w.account.id);

    assert.deepEqual(w.steps, ["read:arrival", "instructions", "rules", "pipelines"]);
    assert.equal((await delivery(w.message)).status, "succeeded");
    assert.deepEqual(w.unsubscribes, [w.message.id]);
    assert.deepEqual(
      w.mailbox.calls.filter((call) => call.method === "setFlagged").map((call) => call.args),
      [[w.thread.gmailThreadId, true]],
    );
    const analysis = await analysisOf(w.message);
    assert.deepEqual(
      parseAutoActions(analysis.autoActionsJson).map((step) => [step.action, step.status]),
      [
        ["unsubscribe", "done"],
        ["star", "done"],
      ],
    );
    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      action: "mail.analysis.automatic",
    });
    assert.equal(audits.length, 2);
    assert.ok(audits.every((row) => row.actorEmployeeId === w.reader.id));
  });

  test("a rule that would unsubscribe again stands down for the same message", async () => {
    const w = await world();
    const rule = await insert(MailRule, {
      companyId: COMPANY_ID,
      accountId: w.account.id,
      name: "Unsubscribe from the shop",
      enabled: true,
      position: 0,
      conditionsJson: JSON.stringify({ from: "shop.example" }),
      actionsJson: JSON.stringify([{ type: "unsubscribe" }]),
    });
    await enqueueInboundAutomation(w.message, { defaultEffects: effects(w, MARKETING) });
    await waitForMailAutomation(w.account.id);

    assert.deepEqual(w.unsubscribes, [w.message.id], "the sender is asked exactly once");
    const ruleAudit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "mail.rule.unsubscribe",
      targetId: rule.id,
    });
    assert.equal(
      (JSON.parse(ruleAudit.metadataJson) as Record<string, unknown>).skipped,
      "already_unsubscribed_by_instructions",
    );
  });

  test("a rule still unsubscribes when the instructions did not", async () => {
    const w = await world({ account: { aiAnalysisInstructions: "" } });
    await insert(MailRule, {
      companyId: COMPANY_ID,
      accountId: w.account.id,
      name: "Unsubscribe from the shop",
      enabled: true,
      position: 0,
      conditionsJson: JSON.stringify({ from: "shop.example" }),
      actionsJson: JSON.stringify([{ type: "unsubscribe" }]),
    });
    await enqueueInboundAutomation(w.message, { defaultEffects: effects(w, MARKETING) });
    await waitForMailAutomation(w.account.id);

    assert.deepEqual(w.unsubscribes, [`rule:${w.message.id}`]);
    assert.equal((await analysisOf(w.message)).autoActionsJson, "[]");
  });

  test("a reader on Read access changes nothing, and the rest of the chain still runs", async () => {
    const w = await world({ accessLevel: "read" });
    await enqueueInboundAutomation(w.message, {
      defaultEffects: effects(w, MARKETING, { facts: { canDraft: false } }),
    });
    await waitForMailAutomation(w.account.id);

    assert.equal((await analysisOf(w.message)).autoActionsJson, "[]");
    assert.equal(w.mailbox.calls.length, 0);
    assert.deepEqual(w.unsubscribes, []);
    assert.deepEqual(w.steps, ["read:arrival", "instructions", "rules", "pipelines"]);
  });

  test("a mailbox paused right after the read requeues the email, and Resume carries the steps out once", async () => {
    const w = await world();
    let reads = 0;
    const options = {
      defaultEffects: effects(w, MARKETING, {
        afterRead: async () => {
          reads += 1;
          if (reads === 1) {
            await AppDataSource.getRepository(MailAccount).update(
              { id: w.account.id },
              { status: "paused" },
            );
          }
        },
      }),
    };
    await enqueueInboundAutomation(w.message, options);
    await waitForMailAutomation(w.account.id);

    // Nothing touched the mailbox or the sender, the email shows why, and it
    // waits for Resume.
    assert.equal(w.mailbox.calls.length, 0);
    assert.deepEqual(w.unsubscribes, []);
    const queued = await delivery(w.message);
    assert.equal(queued.status, "queued");
    assert.deepEqual(w.steps, ["read:arrival", "instructions"]);
    assert.deepEqual(
      parseAutoActions((await analysisOf(w.message)).autoActionsJson).map((step) => [
        step.status,
        step.detail,
      ]),
      [
        ["skipped", "The mailbox was paused or disconnected before this ran."],
        ["skipped", "The mailbox was paused or disconnected before this ran."],
      ],
    );

    await AppDataSource.getRepository(MailAccount).update({ id: w.account.id }, { status: "active" });
    await runMailAutomationQueuePass(options);
    await waitForMailAutomation(w.account.id);

    assert.equal((await delivery(w.message)).status, "succeeded");
    assert.deepEqual(w.unsubscribes, [w.message.id]);
    assert.deepEqual(
      parseAutoActions((await analysisOf(w.message)).autoActionsJson).map((step) => step.status),
      ["done", "done"],
    );
    assert.equal(
      w.mailbox.calls.filter((call) => call.method === "setFlagged").length,
      1,
      "the star was applied once, after Resume",
    );
  });

  test("a mailbox paused between two steps keeps the first, skips the second, and never replays them", async () => {
    const w = await world();
    const options = { defaultEffects: effects(w, MARKETING) };
    options.defaultEffects.applyInstructions = async (account, message, analysisId, fences) => {
      w.steps.push("instructions");
      return applyAutomaticAnalysisActions(account, message, analysisId, fences, {
        mailbox: async () => w.mailbox,
        unsubscribe: async (_account, unsubscribed) => {
          w.unsubscribes.push(unsubscribed.id);
          // The Member presses Pause while the first step is in flight.
          await AppDataSource.getRepository(MailAccount).update(
            { id: w.account.id },
            { status: "paused" },
          );
          return { host: "lists.shop.example", status: 200 };
        },
      });
    };
    await enqueueInboundAutomation(w.message, options);
    await waitForMailAutomation(w.account.id);

    const failed = await delivery(w.message);
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorMessage, "Mailbox was paused after automation started");
    assert.deepEqual(
      parseAutoActions((await analysisOf(w.message)).autoActionsJson).map((step) => [
        step.action,
        step.status,
      ]),
      [
        ["unsubscribe", "done"],
        ["star", "skipped"],
      ],
    );
    assert.equal(w.mailbox.calls.length, 0, "the star never reached the mail server");
    assert.deepEqual(w.steps, ["read:arrival", "instructions"], "no rule ran on a paused mailbox");

    await AppDataSource.getRepository(MailAccount).update({ id: w.account.id }, { status: "active" });
    await runMailAutomationQueuePass(options);
    await waitForMailAutomation(w.account.id);
    assert.deepEqual(w.unsubscribes, [w.message.id], "a failed delivery is never replayed");
  });
});

describe("the chain around the steps", () => {
  const always = async () => {};

  test("a step that breaks on its own still lets the rules and Pipelines run", async () => {
    const w = await world();
    const steps: string[] = [];
    await runDefaultMailEffects(w.account, w.message, always, always, {
      reconcileDefaults: async () => {},
      analyzeInbound: async () => {
        steps.push("read");
        return insert(MailInboundAnalysis, {
          companyId: COMPANY_ID,
          accountId: w.account.id,
          threadId: w.thread.id,
          messageId: w.message.id,
          status: "succeeded",
          employeeId: w.reader.id,
        });
      },
      applyInstructions: async () => {
        steps.push("instructions");
        throw new Error("database hiccup");
      },
      applyRules: async () => {
        steps.push("rules");
      },
      dispatchReceived: async () => {
        steps.push("pipelines");
      },
    });
    assert.deepEqual(steps, ["read", "instructions", "rules", "pipelines"]);
  });

  test("a pause reported by a step stops the chain before the rules", async () => {
    const w = await world();
    const steps: string[] = [];
    let paused = false;
    const assertRunnable = async () => {
      if (paused) throw new Error("paused");
    };
    await assert.rejects(
      runDefaultMailEffects(w.account, w.message, assertRunnable, assertRunnable, {
        reconcileDefaults: async () => {},
        analyzeInbound: async () =>
          insert(MailInboundAnalysis, {
            companyId: COMPANY_ID,
            accountId: w.account.id,
            threadId: w.thread.id,
            messageId: w.message.id,
            status: "succeeded",
            employeeId: w.reader.id,
          }),
        applyInstructions: async () => {
          paused = true;
          throw new Error("paused");
        },
        applyRules: async () => {
          steps.push("rules");
        },
        dispatchReceived: async () => {
          steps.push("pipelines");
        },
      }),
      /paused/,
    );
    assert.deepEqual(steps, []);
  });

  test("no read, no steps: analysis off or a failed read never reaches the step runner", async () => {
    const w = await world();
    const steps: string[] = [];
    for (const analyzeInbound of [
      async () => null,
      async () => {
        throw new Error("model down");
      },
    ]) {
      await runDefaultMailEffects(w.account, w.message, always, always, {
        reconcileDefaults: async () => {},
        analyzeInbound,
        applyInstructions: async () => {
          steps.push("instructions");
          return [];
        },
        applyRules: async () => {
          steps.push("rules");
        },
        dispatchReceived: async () => {
          steps.push("pipelines");
        },
      });
    }
    assert.deepEqual(steps, ["rules", "pipelines", "rules", "pipelines"]);
  });

  test("the queue asks for an arrival read; nothing else does", async () => {
    const w = await world();
    const seen: Array<MailAnalysisOptions | undefined> = [];
    await runDefaultMailEffects(w.account, w.message, always, always, {
      reconcileDefaults: async () => {},
      analyzeInbound: async (_account, _message, _deps, options) => {
        seen.push(options);
        return null;
      },
      applyRules: async () => {},
      dispatchReceived: async () => {},
    });
    assert.deepEqual(seen, [{ arrival: true }]);
  });

  test("a blocked sender gets no read and no steps", async () => {
    const w = await world();
    await insert(MailRule, {
      companyId: COMPANY_ID,
      accountId: w.account.id,
      name: "Blocked sender",
      enabled: true,
      position: 0,
      conditionsJson: JSON.stringify({ fromExact: "news@shop.example" }),
      actionsJson: JSON.stringify([{ type: "spam" }]),
    });
    const steps: string[] = [];
    await runDefaultMailEffects(w.account, w.message, always, always, {
      reconcileDefaults: async () => {},
      analyzeInbound: async () => {
        steps.push("read");
        return null;
      },
      applyInstructions: async () => {
        steps.push("instructions");
        return [];
      },
      applyRules: async () => {
        steps.push("rules");
      },
      dispatchReceived: async () => {
        steps.push("pipelines");
      },
    });
    assert.deepEqual(steps, ["rules"]);
  });
});

function sendSse(response: ServerResponse, payload: Record<string, unknown>): void {
  response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
  response.end("data: [DONE]\n\n");
}

describe("through the real model runtime", () => {
  test("a model's automatic step crosses the real runtime and is carried out on arrival", async (t) => {
    const run = agentRuntime.run;
    // The real runtime, given room for a cold start apart from the email's own deadline.
    t.mock.method(agentRuntime, "run", (input: Parameters<typeof run>[0]) =>
      run({ ...input, signal: AbortSignal.timeout(180_000) }),
    );
    const w = await world();
    const requests: string[] = [];
    let turns = 0;
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(body);
      turns += 1;
      if (turns === 1) {
        sendSse(response, {
          id: "instructions-turn-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "mail-instructions-test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "call_instructions",
                    type: "function",
                    function: {
                      name: "genosyn_submit_email_analysis",
                      arguments: JSON.stringify(MARKETING),
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
        id: "instructions-turn-2",
        object: "chat.completion.chunk",
        created: 2,
        model: "mail-instructions-test",
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
      await AppDataSource.getRepository(AIModel).update(
        { employeeId: w.reader.id },
        {
          provider: "custom",
          authMode: "customEndpoint",
          model: "mail-instructions-test",
          configJson: JSON.stringify({
            baseURLEncrypted: encryptSecret(`http://127.0.0.1:${address.port}/v1`),
            modelId: "mail-instructions-test",
          }),
        },
      );

      await enqueueInboundAutomation(w.message, {
        defaultEffects: {
          reconcileDefaults: async () => {},
          // The real read on the real runtime; only the mailbox facts are fixed,
          // because there is no Gmail here to sign the unsubscribe header.
          analyzeInbound: (account, message, _dependencies, options) =>
            analyzeInboundMessage(
              account,
              message,
              { gatherFacts: async () => NEWSLETTER_FACTS },
              options,
            ),
          applyInstructions: (account, message, analysisId, fences) =>
            applyAutomaticAnalysisActions(account, message, analysisId, fences, {
              mailbox: async () => w.mailbox,
              unsubscribe: async (_account, unsubscribed) => {
                w.unsubscribes.push(unsubscribed.id);
                return { host: "lists.shop.example", status: 200 };
              },
            }),
          applyRules: async () => {},
          dispatchReceived: async () => {},
        },
      });
      await waitForMailAutomation(w.account.id, 180_000);

      // The model was shown the owner's numbered instructions and the steps field.
      const first = requests[0] ?? "";
      assert.ok(first.includes("1. Unsubscribe me automatically from marketing emails."));
      assert.ok(first.includes("2. Star emails that need my response and look important."));
      assert.ok(first.includes("automaticActions"));

      const analysis = await analysisOf(w.message);
      assert.equal(analysis.status, "succeeded", analysis.errorMessage);
      assert.deepEqual(
        parseAutoActions(analysis.autoActionsJson).map((step) => [step.action, step.status]),
        [
          ["unsubscribe", "done"],
          ["star", "done"],
        ],
      );
      assert.deepEqual(w.unsubscribes, [w.message.id]);
      assert.equal(w.mailbox.calls.filter((call) => call.method === "setFlagged").length, 1);
      assert.equal((await delivery(w.message)).status, "succeeded");
    } finally {
      config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...previousAllowlist);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
