import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import type { AIModel } from "../../db/entities/AIModel.js";
import { AIModelWait } from "../../db/entities/AIModelWait.js";
import { PhoneCall } from "../../db/entities/PhoneCall.js";
import { PhoneMessage } from "../../db/entities/PhoneMessage.js";
import type { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { jsonResponse, phoneFixture, stubTwilio } from "../../test/phoneFixtures.js";
import { modelUnavailability } from "../agent/modelOutage.js";
import type { EmployeeAgentResult, RestrictedEmployeeAgentParams } from "../agent/runEmployee.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  loadModelOutages,
  recordModelFailure,
  resetModelAvailabilityForTests,
  setModelCheckForTests,
} from "../modelAvailability.js";
import { resetModelWaitsForTests, settleModelWaitsForTests } from "../modelWaits.js";
import { getActiveModel } from "../models.js";
import { placeStanddown, refreshStanddowns, stopStanddowns } from "../standdowns.js";
import {
  answerIncomingCall,
  connectOutboundCall,
  handleSpeech,
  readTranscript,
} from "./calls.js";
import type { PhoneTurnRunner } from "./conversation.js";
import {
  TEXT_REPLY_WAIT_MS,
  handleFreshInboundText,
  setTextReplyRunnerForTests,
  settleTextReplies,
} from "./textReplies.js";
import { recordInboundText, setFreshInboundTextHandler } from "./texts.js";

/**
 * A Phone number while its AI Employee's AI Model is unavailable. A text that
 * wants an automatic reply is kept and its reply waits, to be written once the
 * model is back under every rule a fresh text meets. A live call cannot wait,
 * so the employee says so briefly and takes a message — no model needed — and,
 * when the number replies to texts on its own, a follow-up text waits for the
 * model. Twilio and the model are stand-ins; the phone services, the wait
 * ledger and the breaker are real.
 */

const BASE = "https://genosyn.example.test";
const CALLER = "+15550107777";

let sends: Array<{ to: string | null; body: string | null }>;
let twilio: ReturnType<typeof stubTwilio>;
let turns: RestrictedEmployeeAgentParams[];
let play: (params: RestrictedEmployeeAgentParams) => Promise<EmployeeAgentResult>;

before(initTestDb);
beforeEach(async () => {
  resetModelAvailabilityForTests();
  resetModelWaitsForTests();
  await resetTestDb();
  await refreshStanddowns();
  sends = [];
  turns = [];
  play = async () => ({ status: "ok", finalText: "Thanks — we open at eight on Monday.", steps: 1 });
  twilio = stubTwilio((_url, init) => {
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    sends.push({ to: body.get("To"), body: body.get("Body") });
    return jsonResponse(201, { sid: `SM-out-${sends.length}`, status: "queued" });
  });
  setTextReplyRunnerForTests(async (params) => {
    turns.push(params);
    return play(params);
  });
  setFreshInboundTextHandler(handleFreshInboundText);
});
afterEach(async () => {
  await settleTextReplies();
  twilio.restore();
  setTextReplyRunnerForTests(null);
  setFreshInboundTextHandler(null);
  resetModelWaitsForTests();
  resetModelAvailabilityForTests();
  stopStanddowns();
});
after(closeTestDb);

const overloaded = async (): Promise<EmployeeAgentResult> => ({
  status: "error",
  error: "The AI Model answered with a server error (HTTP 529).",
  unavailable: modelUnavailability("overloaded", { status: 529, code: "overloaded_error" }),
});

async function modelOf(employeeId: string): Promise<AIModel> {
  const model = await getActiveModel(employeeId);
  assert.ok(model);
  return model;
}

function down(model: AIModel): void {
  recordModelFailure(
    model,
    modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true }),
  );
}

async function back(model: AIModel): Promise<void> {
  setModelCheckForTests(async () => ({ kind: "available" }));
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
}

let sid = 0;
async function textIn(number: PhoneNumber, body: string, from = CALLER): Promise<PhoneMessage> {
  sid += 1;
  const { message } = await recordInboundText(number, {
    sid: `SM-in-${sid}`,
    from,
    to: number.e164,
    body,
    media: [],
    occurredAt: new Date(Date.now() + sid),
  });
  await settleTextReplies();
  return message;
}

async function settle(now?: () => Date): Promise<void> {
  await settleModelWaitsForTests(now);
  await settleTextReplies();
}

async function waits(): Promise<AIModelWait[]> {
  return AppDataSource.getRepository(AIModelWait).find();
}

async function replies(): Promise<PhoneMessage[]> {
  return AppDataSource.getRepository(PhoneMessage).findBy({ direction: "outbound" });
}

describe("automatic text replies while the AI Model is unavailable", () => {
  test("a text is kept and its reply waits, then is sent once when the model is back", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    await textIn(number, "Are you open on Monday?");
    assert.equal(turns.length, 0, "nothing is sent to a model that is down");
    assert.equal(sends.length, 0, "and no text goes out — no error, no apology");
    const [wait, ...more] = await waits();
    assert.equal(more.length, 0);
    assert.equal(wait.kind, "phone_text_reply");

    await settle();
    assert.equal(sends.length, 0, "still down");

    await back(model);
    await settle();
    assert.deepEqual(sends, [{ to: CALLER, body: "Thanks — we open at eight on Monday." }]);
    const [reply] = await replies();
    assert.equal(reply.autoReply, true, "it counts toward the hourly cap and the daily limit");
    const [only] = turns;
    assert.ok(!only.system.includes("SECRET SOUL"), "a stranger's turn never sees the Soul");
    assert.deepEqual(
      only.tools.map((tool) => tool.name),
      ["skip_reply"],
    );
    assert.equal((await waits()).length, 0);
    await settle();
    assert.equal(sends.length, 1, "sent exactly once");
  });

  test("an outage in the middle of the turn waits too", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" });
    play = overloaded;
    await textIn(number, "Are you open on Monday?");
    assert.equal(turns.length, 1);
    assert.equal(sends.length, 0);
    assert.equal((await waits()).length, 1);
    play = async () => ({ status: "ok", finalText: "Yes, from eight.", steps: 1 });
    await back(await modelOf(employee.id));
    await settle();
    assert.deepEqual(sends.map((s) => s.body), ["Yes, from eight."]);
  });

  test("several texts that waited are answered once, together", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    await textIn(number, "Are you open on Monday?");
    await textIn(number, "And do you take walk-ins?");
    assert.equal((await waits()).length, 2);
    await back(model);
    await settle();
    assert.equal(sends.length, 1);
    assert.ok(JSON.stringify(turns[0].messages).includes("walk-ins"));
    assert.ok(JSON.stringify(turns[0].messages).includes("open on Monday"));
  });

  test("a STOP sent while it waited means no reply at all", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    await textIn(number, "Are you open on Monday?");
    await textIn(number, "STOP");
    await back(model);
    await settle();
    assert.equal(sends.length, 0);
    assert.equal(turns.length, 0);
  });

  test("a Standdown placed during the outage holds: no text goes out when the model is back", async () => {
    const { number, employee, company } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    await textIn(number, "Are you open on Monday?");
    await placeStanddown({ companyId: company.id, scope: "company", reason: "Phone audit." });
    await back(model);
    await settle();
    assert.equal(sends.length, 0);
    assert.equal(turns.length, 0);
  });

  test("the number's daily limit is checked when the reply is sent, and a refusal leaves nothing waiting", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply", dailyTextLimit: 1 });
    const model = await modelOf(employee.id);
    down(model);
    await textIn(number, "Are you open on Monday?");
    await insert(PhoneMessage, {
      companyId: number.companyId,
      phoneNumberId: number.id,
      employeeId: employee.id,
      direction: "outbound",
      fromNumber: number.e164,
      toNumber: "+15550108888",
      providerSid: "SM-earlier",
      status: "delivered",
      occurredAt: new Date(),
      autoReply: true,
      body: "Earlier reply to someone else.",
    });
    await back(model);
    await settle();
    assert.equal(sends.length, 0, "the day's limit holds for a reply that waited");
    assert.equal((await waits()).length, 0);
  });

  test("anything texted to them meanwhile has answered: no late reply", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    const asked = await textIn(number, "Are you open on Monday?");
    await insert(PhoneMessage, {
      companyId: number.companyId,
      phoneNumberId: number.id,
      employeeId: employee.id,
      direction: "outbound",
      fromNumber: number.e164,
      toNumber: CALLER,
      providerSid: "SM-member",
      status: "delivered",
      occurredAt: new Date(asked.occurredAt.getTime() + 1_000),
      sentByUserId: "member-1",
      body: "Hi! Yes, we open at eight.",
    });
    await back(model);
    await settle();
    assert.equal(sends.length, 0);
  });

  test("a reply a day late is given up", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    await textIn(number, "Are you open on Monday?");
    await back(model);
    await settle(() => new Date(Date.now() + TEXT_REPLY_WAIT_MS + 60_000));
    assert.equal(sends.length, 0);
    assert.equal((await waits()).length, 0);
  });

  test("a restart during the outage: the reply still waits after boot and is sent once when the model is back", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    await flushModelAvailabilityWrites();
    await textIn(number, "Are you open on Monday?");
    resetModelAvailabilityForTests();
    resetModelWaitsForTests();
    await loadModelOutages();
    await settle();
    assert.equal(sends.length, 0);
    await back(model);
    await settle();
    assert.equal(sends.length, 1);
  });
});

describe("a live call while the AI Model is unavailable", () => {
  async function callIn(number: PhoneNumber, callSid = "CA-outage") {
    const xml = await answerIncomingCall(
      number,
      { CallSid: callSid, From: CALLER, To: number.e164 },
      BASE,
    );
    const call = await AppDataSource.getRepository(PhoneCall).findOneByOrFail({
      providerSid: callSid,
    });
    return { xml, call };
  }

  test("is answered with a short apology and an offer to take a message — no model needed", async () => {
    const { number, employee } = await phoneFixture();
    down(await modelOf(employee.id));
    const { xml, call } = await callIn(number);
    assert.match(xml, /can&apos;t take questions right now/);
    assert.match(xml, /leave a short message/);
    assert.match(xml, /phase=message/);
    assert.equal(call.handling, "message");
    assert.equal(turns.length, 0);
  });

  test("the caller's message is kept in the transcript and the call ends politely", async () => {
    const { number, employee } = await phoneFixture();
    down(await modelOf(employee.id));
    const { call } = await callIn(number);
    const xml = await handleSpeech({
      call,
      number,
      params: { SpeechResult: "Please call me back about moving my appointment." },
      phase: "message",
      base: BASE,
    });
    assert.match(xml, /passed your message on/);
    assert.match(xml, /<Hangup\/>/);
    const ended = await AppDataSource.getRepository(PhoneCall).findOneByOrFail({ id: call.id });
    assert.equal(ended.handling, "message");
    assert.match(ended.endReason, /Took a message/);
    assert.ok(
      readTranscript(ended).some(
        (turn) => turn.speaker === "caller" && /moving my appointment/.test(turn.text),
      ),
    );
    assert.equal(
      (await waits()).length,
      0,
      "a number that does not reply to texts sends no follow-up",
    );
  });

  test("a number that replies to texts follows the call up by text once the model is back", async () => {
    const { number, employee } = await phoneFixture({
      textMode: "reply",
      instructions: "You answer for Acme Dental. Offer to book appointments.",
    });
    const model = await modelOf(employee.id);
    down(model);
    const { call } = await callIn(number);
    await handleSpeech({
      call,
      number,
      params: { SpeechResult: "Please call me back about moving my appointment." },
      phase: "message",
      base: BASE,
    });
    const [wait] = await waits();
    assert.equal(wait.kind, "phone_call_follow_up");
    assert.equal(wait.targetId, call.id);

    play = async () => ({
      status: "ok",
      finalText: "Hi, it's Ava from Acme Dental following up on your call — happy to move your appointment. What day suits you?",
      steps: 1,
    });
    await settle();
    assert.equal(sends.length, 0, "still down");
    await back(model);
    await settle();
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, CALLER);
    const [only] = turns;
    assert.deepEqual(
      only.tools.map((tool) => tool.name),
      ["skip_reply"],
      "a restricted turn: the caller is a stranger",
    );
    assert.ok(only.system.includes("Offer to book appointments."));
    assert.ok(only.system.includes("following up on that call"));
    assert.ok(!only.system.includes("SECRET SOUL"));
    assert.ok(JSON.stringify(only.messages).includes("moving my appointment"));
    const [reply] = await replies();
    assert.equal(reply.autoReply, true);
    await settle();
    assert.equal(sends.length, 1, "followed up exactly once");
  });

  test("no follow-up once the caller has texted since — their text is answered as a text", async () => {
    const { number, employee } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    const { call } = await callIn(number);
    await handleSpeech({ call, number, params: { SpeechResult: "" }, phase: "message", base: BASE });
    await textIn(number, "Hi, I called earlier — are you open Monday?");
    await back(model);
    await settle();
    assert.equal(sends.length, 1, "one text: the reply to their text, not a second follow-up");
    assert.ok(JSON.stringify(turns[0].messages).includes("are you open Monday"));
  });

  test("a Standdown placed before the model is back means no follow-up", async () => {
    const { number, employee, company } = await phoneFixture({ textMode: "reply" });
    const model = await modelOf(employee.id);
    down(model);
    const { call } = await callIn(number);
    await handleSpeech({
      call,
      number,
      params: { SpeechResult: "Call me back please." },
      phase: "message",
      base: BASE,
    });
    await placeStanddown({ companyId: company.id, scope: "company", reason: "Phone audit." });
    await back(model);
    await settle();
    assert.equal(sends.length, 0);
  });

  test("an AI Model that goes down mid-call: the caller is told and offered to leave a message", async () => {
    const { number } = await phoneFixture();
    const { call } = await callIn(number);
    assert.equal(call.handling, "employee", "the model was up when the call came in");
    const outageRunner: PhoneTurnRunner = async () => overloaded();
    const xml = await handleSpeech({
      call,
      number,
      params: { SpeechResult: "Can I book a cleaning?" },
      phase: null,
      base: BASE,
      runRestricted: outageRunner,
    });
    assert.match(xml, /can&apos;t answer properly right now/);
    assert.match(xml, /phase=message/);
    assert.doesNotMatch(xml, /HTTP 529/, "never the model's error, spoken");
    const fresh = await AppDataSource.getRepository(PhoneCall).findOneByOrFail({ id: call.id });
    assert.equal(fresh.handling, "message");
    assert.equal(fresh.errorMessage, "");
  });

  test("a call the employee placed, answered while its model is down: it says who it is and goes", async () => {
    const { number, employee, company } = await phoneFixture();
    down(await modelOf(employee.id));
    const call = await insert(PhoneCall, {
      companyId: company.id,
      phoneNumberId: number.id,
      employeeId: employee.id,
      direction: "outbound",
      fromNumber: number.e164,
      toNumber: CALLER,
      providerSid: "CA-out",
      status: "ringing",
      handling: "employee",
      transcriptJson: "[]",
      brief: "Confirm tomorrow's appointment.",
    });
    const xml = await connectOutboundCall(call, number, BASE);
    assert.match(xml, /AI assistant calling from Acme Dental/);
    assert.match(xml, /can&apos;t talk right now/);
    assert.match(xml, /<Hangup\/>/);
    assert.equal((await waits()).length, 0, "no follow-up on a call the employee placed");
  });
});
