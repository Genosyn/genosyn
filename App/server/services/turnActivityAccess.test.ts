import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import type { ChatActivityEvent } from "../../shared/chatActivity.js";
import {
  activityEventFor,
  stepsOnlyActivityEvent,
  turnActivityAccess,
  withheldReason,
  type TurnAudience,
  type TurnAuthority,
  type TurnViewer,
} from "../../shared/turnActivityAccess.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ChannelTurn } from "../db/entities/ChannelTurn.js";
import { Company } from "../db/entities/Company.js";
import { ConversationActivityEvent } from "../db/entities/ConversationActivityEvent.js";
import { Customer } from "../db/entities/Customer.js";
import { CustomerChannel } from "../db/entities/CustomerChannel.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { agentRuntime } from "./agent/runtime.js";
import {
  clearChatSurfaceAdapterOverridesForTests,
  setChatSurfaceAdapterForTests,
} from "./chatSurfaces/adapters.js";
import { handleInboundTurn } from "./chatSurfaces/inbound.js";
import type { ChatSurfaceAdapter, InboundChatTurn } from "./chatSurfaces/types.js";
import { settleCustomerChannelReplies } from "./customerChannels/replies.js";
import { setCustomerChannelRunnerForTests } from "./customerChannels/turns.js";
import { encryptConnectionConfig } from "./integrations.js";

/**
 * Who sees how an AI turn came to be, beyond its reply
 * (`shared/turnActivityAccess.ts`), and the room's view of a step.
 *
 * In a room several people read one reply without holding one access, so the
 * Member whose authority a turn ran under sees everything, the rest of the
 * room the steps without what they read or returned, and where people
 * outside the company can read — a Slack Connect channel, a customer channel
 * — nothing but the reply at all.
 */

const ruth = "user-ruth";
const sam = "user-sam";
const member = (userId: string): TurnViewer => ({ kind: "member", userId });

function access(audience: TurnAudience, authority: TurnAuthority, viewer: TurnViewer) {
  return turnActivityAccess({ audience, authority, viewer });
}

function event(kind: ChatActivityEvent["kind"], extra: Partial<ChatActivityEvent> = {}) {
  return {
    ordinal: 1,
    attempt: 1,
    kind,
    name: "",
    callId: "",
    summary: "",
    detail: null,
    isError: false,
    at: "2026-10-30T10:00:00.000Z",
    ...extra,
  } satisfies ChatActivityEvent;
}

describe("who may see a turn's steps", () => {
  test("in a room only the company reads, the asker sees everything and the room the steps", () => {
    const asked: TurnAuthority = { kind: "member", userId: ruth };
    assert.equal(access("internal", asked, member(ruth)), "full");
    assert.equal(access("internal", asked, member(sam)), "steps");
  });

  test("an AI Employee's own work shows in full to any Member, as its Run transcripts do", () => {
    assert.equal(access("internal", { kind: "employee" }, member(sam)), "full");
    // Nobody's authority reached no company data in the first place.
    assert.equal(access("internal", { kind: "untrusted" }, member(sam)), "full");
  });

  test("where people outside the company can read, nobody sees anything beyond the reply", () => {
    for (const audience of ["shared", "unknown"] as const) {
      for (const authority of [
        { kind: "member", userId: ruth },
        { kind: "employee" },
        { kind: "untrusted" },
      ] as TurnAuthority[]) {
        assert.equal(access(audience, authority, member(ruth)), "none", `${audience}`);
      }
    }
  });

  test("an AI Employee reading the room, or anyone outside the company, reads replies only", () => {
    const authority: TurnAuthority = { kind: "employee" };
    assert.equal(access("internal", authority, { kind: "employee", employeeId: "e1" }), "none");
    assert.equal(access("internal", authority, { kind: "outside" }), "none");
  });
});

describe("the room's view of a step", () => {
  test("a tool call loses its arguments, and its label no longer names them", () => {
    const shown = stepsOnlyActivityEvent(
      event("tool_use", {
        name: "search_mail",
        callId: "c1",
        summary: "Searching email for · “salary review John”",
        detail: { input: { query: "salary review John" }, worker: null },
      }),
    );
    assert.equal(shown.summary, "Searching email");
    assert.equal((shown.detail as { input: unknown }).input, null);
    assert.equal(withheldReason(shown.detail), "steps");
    assert.doesNotMatch(JSON.stringify(shown), /salary/);
    assert.equal(shown.callId, "c1", "it still pairs with its result");
  });

  test("a result keeps its status and timing, never what it returned or what it was about", () => {
    const failed = stepsOnlyActivityEvent(
      event("tool_result", {
        name: "get_mail_message",
        callId: "c1",
        isError: true,
        summary: "Read an email · failed: mailbox q3-salaries is locked",
        detail: {
          output: "mailbox q3-salaries is locked",
          durationMs: 1200,
          hint: "“Q3 salaries” · from cfo@acme.com",
          worker: null,
        },
      }),
    );
    assert.equal(failed.summary, "Read an email · failed");
    assert.deepEqual(failed.detail, {
      output: null,
      durationMs: 1200,
      worker: null,
      withheld: "steps",
    });
    assert.equal(failed.isError, true);
    const held = stepsOnlyActivityEvent(
      event("tool_result", {
        name: "send_mail",
        detail: { output: "pending_approval", durationMs: 40, approval: { id: "ap-1" } },
      }),
    );
    assert.equal(held.summary, "Sent an email · waiting for approval");
    assert.deepEqual((held.detail as { approval: unknown }).approval, { id: "ap-1" });
  });

  test("a thought is shown to have happened, not what was thought", () => {
    const shown = stepsOnlyActivityEvent(
      event("reasoning", {
        summary: "Comparing John's salary",
        detail: { text: "Comparing John's salary to the band", block: "b1" },
      }),
    );
    assert.equal(shown.summary, "");
    assert.deepEqual(shown.detail, { text: "", block: "b1", withheld: "steps" });
  });

  test("a milestone keeps how far along it is, not what the employee said it was doing", () => {
    const shown = stepsOnlyActivityEvent(
      event("progress", {
        summary: "40% · Reviewing John's salary",
        detail: { percent: 40, label: "Reviewing John's salary" },
      }),
    );
    assert.equal(shown.summary, "40%");
    assert.deepEqual(shown.detail, { percent: 40, label: "In progress", withheld: "steps" });
  });

  test("waits, notices, starts, stops and the finish are the server's own words, kept as they are", () => {
    for (const kept of [
      event("waiting", { name: "model_unavailable", summary: "The AI Model is unavailable" }),
      event("notice", { name: "compact", summary: "Compacted older parts" }),
      event("turn_started", { summary: "Started working" }),
      event("stopped", { summary: "Stopped by Sam" }),
      event("turn_finished", { summary: "Worked for 4s" }),
    ]) {
      assert.deepEqual(stepsOnlyActivityEvent(kept), kept);
    }
  });

  test("an event is shown as access allows: whole, the room's view, or not at all", () => {
    const step = event("tool_use", { name: "bash", detail: { input: { command: "ls" } } });
    assert.deepEqual(activityEventFor(step, "full"), step);
    assert.equal((activityEventFor(step, "steps")?.detail as { input: unknown }).input, null);
    assert.equal(activityEventFor(step, "none"), null);
  });
});

describe("where people outside the company read, a turn records nothing beyond its reply", () => {
  let company: Company;
  let employee: AIEmployee;
  let connection: IntegrationConnection;
  const sent: string[] = [];
  const slack: ChatSurfaceAdapter = {
    provider: "slack",
    transport: "socket",
    textLimit: 3800,
    requiresPublicUrl: false,
    async send({ text }) {
      sent.push(text);
      return { externalMessageId: `C0SHARED:9.${sent.length}` };
    },
  };

  before(initTestDb);
  after(async () => {
    clearChatSurfaceAdapterOverridesForTests();
    setCustomerChannelRunnerForTests(null);
    await closeTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    sent.length = 0;
    setChatSurfaceAdapterForTests("slack", slack);
    company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner-1" });
    employee = await insert(AIEmployee, {
      companyId: company.id,
      name: "Sam Support",
      slug: "sam",
      role: "Support",
      soulBody: "",
    });
    await insertEmployeeModel({
      employeeId: employee.id,
      provider: "anthropic",
      model: "claude-sonnet-4",
      authMode: "apikey",
      configJson: JSON.stringify({ apiKeyEncrypted: "sealed-test-key" }),
      isActive: true,
    });
    connection = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "slack",
      label: "Company Slack",
      authMode: "apikey",
      encryptedConfig: encryptConnectionConfig(
        { botToken: "xoxb-test", botUserId: "U0BOT", teamId: "T0OURS" },
        company.id,
      ),
      accountHint: "",
      status: "connected",
      statusMessage: "",
    });
    await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: connection.id });
  });
  afterEach(async () => {
    await settleCustomerChannelReplies();
  });

  function slackTurn(over: Partial<InboundChatTurn>): InboundChatTurn {
    return {
      provider: "slack",
      connectionId: connection.id,
      companyId: company.id,
      externalKey: "C0SHARED:1.1",
      externalUserId: "U0DANA",
      externalUserLabel: "Dana",
      threadTitle: null,
      text: "what changed in the last release?",
      group: true,
      externalMessageId: "C0SHARED:1.1",
      replyTo: { channel: "C0SHARED", thread_ts: "1.1" },
      externalChannelId: "C0SHARED",
      externalThreadId: "1.1",
      ...over,
    };
  }

  async function nothingRecorded(): Promise<void> {
    assert.equal(await AppDataSource.getRepository(ConversationActivityEvent).count(), 0);
    assert.equal(await AppDataSource.getRepository(ChannelTurn).count(), 0);
  }

  test("a Slack Connect channel: the reply goes out, and not one step is kept", async (t) => {
    t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
      params.callbacks?.onToolUse?.("search_mail", { query: "release notes" }, "c1");
      params.callbacks?.onToolResult?.("search_mail", { content: "{}" }, "c1");
      params.callbacks?.onText?.("Exports got faster.");
      return { finalText: "Exports got faster.", steps: 1, stopReason: "end_turn" };
    });
    await handleInboundTurn(slackTurn({ externallyShared: true }));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /Exports got faster\./);
    assert.match(sent[0], /shared with another organization/);
    await nothingRecorded();
  });

  test("a customer channel: the customer gets an answer, and not one step is kept", async () => {
    const customer = await insert(Customer, { companyId: company.id, name: "Acme Corp", slug: "acme-corp" });
    await insert(CustomerChannel, {
      companyId: company.id,
      provider: "slack",
      connectionId: connection.id,
      externalChannelId: "C0ACME",
      name: "acme-shared",
      shared: true,
      customerId: customer.id,
      employeeId: employee.id,
      replyMode: "mentions",
      instructions: "You support Acme on the Widget API.",
    });
    setCustomerChannelRunnerForTests(async () => ({
      status: "ok",
      finalText: "The limit is 100 requests a minute.",
      steps: 1,
    }));
    const base = slackTurn({
      externalKey: "C0ACME:2.1",
      externalMessageId: "C0ACME:2.1",
      replyTo: { channel: "C0ACME", thread_ts: "2.1" },
      externalChannelId: "C0ACME",
      externalThreadId: "2.1",
      sentAt: new Date(),
      outsideWorkspace: true,
      text: "What are the API rate limits?",
    });
    await handleInboundTurn({ ...base, overheard: true, mentionsEmployee: true });
    await handleInboundTurn(base);
    await settleCustomerChannelReplies();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /100 requests a minute/);
    await nothingRecorded();
  });
});
