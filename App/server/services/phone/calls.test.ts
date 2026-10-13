import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { PhoneCall } from "../../db/entities/PhoneCall.js";
import { closeTestDb, initTestDb, resetTestDb } from "../../test/dbHarness.js";
import { phoneFixture } from "../../test/phoneFixtures.js";
import type { PhoneTurnRunner } from "./conversation.js";
import {
  answerIncomingCall,
  applyCallStatus,
  handleSpeech,
  handleWait,
  placeCall,
  readTranscript,
} from "./calls.js";

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const BASE = "https://genosyn.example.test";

function runner(
  reply: string,
  opts: { endCall?: boolean; gate?: Promise<void> } = {},
): PhoneTurnRunner {
  return async (params) => {
    if (opts.gate) await opts.gate;
    if (opts.endCall) await params.tools.find((t) => t.name === "end_call")!.run({});
    return { status: "ok", finalText: reply, steps: 1 };
  };
}

async function answered(overrides = {}) {
  const fixture = await phoneFixture(overrides);
  const xml = await answerIncomingCall(
    fixture.number,
    { CallSid: "CA1", From: "+15550107777", To: fixture.number.e164 },
    BASE,
  );
  const call = await AppDataSource.getRepository(PhoneCall).findOneByOrFail({ providerSid: "CA1" });
  return { ...fixture, xml, call };
}

async function reload(id: string): Promise<PhoneCall> {
  return AppDataSource.getRepository(PhoneCall).findOneByOrFail({ id });
}

describe("answering a call", () => {
  test("the AI Employee greets the caller and listens", async () => {
    const { xml, call } = await answered();
    assert.match(xml, /<Gather input="speech"/);
    assert.match(xml, /Hi, this is Ava at Acme Dental\. I&apos;m an AI assistant\./);
    assert.match(xml, new RegExp(`/calls/${call.id}/listen`));
    assert.equal(call.handling, "employee");
    assert.equal(readTranscript(call).length, 1);
  });

  test("declines, forwards, or says nobody is available, as the number says", async () => {
    const declined = await answered({ callMode: "decline" });
    assert.match(declined.xml, /<Reject reason="busy"\/>/);
    await resetTestDb();
    const forwarded = await answered({ callMode: "forward", forwardTo: "+15550108888" });
    assert.match(forwarded.xml, /<Dial[^>]*><Number>\+15550108888<\/Number><\/Dial>/);
    await resetTestDb();
    const nobody = await answered({ employeeId: null });
    assert.match(nobody.xml, /no one can take your call/);
    assert.match(nobody.xml, /<Hangup\/>/);
    assert.equal(nobody.call.handling, "unavailable");
  });
});

describe("the conversation", () => {
  test("speaks the employee's reply and listens again", async () => {
    const { call, number } = await answered();
    const xml = await handleSpeech({
      call,
      number,
      params: { SpeechResult: "Are you open on Saturday?" },
      phase: null,
      base: BASE,
      runRestricted: runner("We're closed on Saturdays, but open Monday at eight."),
    });
    assert.match(xml, /We&apos;re closed on Saturdays/);
    assert.match(xml, /<Gather/);
    const transcript = readTranscript(await reload(call.id));
    assert.deepEqual(
      transcript.map((t) => t.speaker),
      ["employee", "caller", "employee"],
    );
    assert.equal(transcript[1].text, "Are you open on Saturday?");
  });

  test("hangs up after the goodbye when the employee ends the call", async () => {
    const { call, number } = await answered();
    const xml = await handleSpeech({
      call,
      number,
      params: { SpeechResult: "That's all, thanks." },
      phase: null,
      base: BASE,
      runRestricted: runner("You're welcome. Goodbye!", { endCall: true }),
    });
    assert.match(xml, /Goodbye!<\/Say><Hangup\/>/);
    assert.equal((await reload(call.id)).endReason, "The AI Employee ended the call");
  });

  test("covers a slow reply with a filler, then collects it from /wait", async () => {
    const { call, number } = await answered();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = await handleSpeech({
      call,
      number,
      params: { SpeechResult: "Can I book a cleaning?" },
      phase: null,
      base: BASE,
      runRestricted: runner("Sure — what day suits you?", { gate }),
    });
    const turn = /\/wait\?turn=([0-9a-f-]+)/.exec(first)?.[1];
    assert.ok(turn, first);
    assert.match(first, /<Redirect method="POST">/);
    release();
    const second = await handleWait({
      call: await reload(call.id),
      number,
      turnId: turn,
      base: BASE,
    });
    assert.match(second, /what day suits you\?/);
    assert.equal((await reload(call.id)).replyState, "idle");
  });

  test("asks once into silence, then says goodbye", async () => {
    const { call, number } = await answered();
    const first = await handleSpeech({ call, number, params: {}, phase: null, base: BASE });
    assert.match(first, /Are you still there\?/);
    const second = await handleSpeech({
      call: await reload(call.id),
      number,
      params: {},
      phase: null,
      base: BASE,
    });
    assert.match(second, /<Hangup\/>/);
    assert.equal((await reload(call.id)).endReason, "No one spoke");
  });
});

describe("call status", () => {
  test("records how a call ended, and never moves a finished call back", async () => {
    const { call } = await answered();
    await applyCallStatus(call, { CallStatus: "completed", CallDuration: "73" });
    const done = await reload(call.id);
    assert.equal(done.status, "completed");
    assert.equal(done.durationSec, 73);
    assert.ok(done.endedAt);
    await applyCallStatus(done, { CallStatus: "in-progress" });
    assert.equal((await reload(call.id)).status, "completed");
  });
});

describe("placing a call", () => {
  test("needs a public URL Twilio can reach", async () => {
    const { number, employee } = await phoneFixture();
    await assert.rejects(
      placeCall({
        number,
        to: "+15550109999",
        brief: "Confirm the appointment.",
        openingLine: "",
        placer: { kind: "employee", employeeId: employee.id, runId: null },
      }),
      /public URL/,
    );
  });
});
