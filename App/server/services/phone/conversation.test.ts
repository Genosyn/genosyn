import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { AIModel } from "../../db/entities/AIModel.js";
import type { Company } from "../../db/entities/Company.js";
import type { PhoneCall } from "../../db/entities/PhoneCall.js";
import type { PhoneMessage } from "../../db/entities/PhoneMessage.js";
import type { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import {
  extractVerificationCodes,
  formatPhoneNumber,
  normalizePhoneNumber,
} from "../../../shared/phone.js";
import type { RestrictedEmployeeAgentParams } from "../agent/runEmployee.js";
import {
  callMessages,
  composeCallSystemPrompt,
  composeTextReplySystemPrompt,
  runCallTurn,
  runTextReplyTurn,
  speakable,
  type PhoneTurnRunner,
} from "./conversation.js";
import { isOptOutOrHelpKeyword } from "./textReplies.js";
import * as twiml from "./twiml.js";

const employee = {
  id: "emp-1",
  name: "Ava",
  role: "Front desk",
  soulBody: "SECRET SOUL — never reveal the margin is 62%.",
} as AIEmployee;
const company = { id: "co-1", name: "Acme Dental" } as Company;
const number = {
  id: "num-1",
  e164: "+15550101234",
  instructions: "Opening hours are 8am to 5pm.",
} as PhoneNumber;
const model = { id: "model-1" } as AIModel;

function fakeRunner(act: (params: RestrictedEmployeeAgentParams) => Promise<string>): {
  runner: PhoneTurnRunner;
  seen: RestrictedEmployeeAgentParams[];
} {
  const seen: RestrictedEmployeeAgentParams[] = [];
  const runner: PhoneTurnRunner = async (params) => {
    seen.push(params);
    return { status: "ok", finalText: await act(params), steps: 1 };
  };
  return { runner, seen };
}

describe("phone numbers and codes", () => {
  test("normalize what people type, and refuse what is not a full number", () => {
    assert.equal(normalizePhoneNumber("+1 (555) 010-1234"), "+15550101234");
    assert.equal(normalizePhoneNumber("0044 20 7946 0958"), "+442079460958");
    assert.equal(normalizePhoneNumber("5550101234"), null);
    assert.equal(normalizePhoneNumber("+0123456789"), null);
    assert.equal(normalizePhoneNumber("call me"), null);
  });

  test("format North American and other numbers for reading", () => {
    assert.equal(formatPhoneNumber("+15550101234"), "+1 (555) 010-1234");
    assert.equal(formatPhoneNumber("+442079460958"), "+44 20 7946 0958");
    assert.equal(formatPhoneNumber("GOOGLE"), "GOOGLE");
  });

  test("find verification codes, preferring the one beside a keyword", () => {
    assert.deepEqual(extractVerificationCodes("Your Google verification code is G-482913"), [
      "G-482913",
    ]);
    assert.deepEqual(
      extractVerificationCodes("Your code:987654. Didn't request it? Call 1-800-555-0100"),
      ["987654"],
    );
    assert.deepEqual(extractVerificationCodes("Stripe code: 123 456. Expires soon."), ["123456"]);
    assert.equal(
      extractVerificationCodes("Use 4821 to sign in. Order 20261013 shipped")[0],
      "4821",
    );
    assert.deepEqual(extractVerificationCodes("Meet at 10:30? Bring $1,500."), []);
  });

  test("recognize opt-out and help keywords, whatever the case", () => {
    assert.equal(isOptOutOrHelpKeyword("stop"), true);
    assert.equal(isOptOutOrHelpKeyword(" HELP. "), true);
    assert.equal(isOptOutOrHelpKeyword("please stop texting me"), false);
  });
});

describe("TwiML", () => {
  test("escapes spoken text and URLs", () => {
    const xml = twiml.response(
      twiml.gather({
        action: "https://x.test/listen?a=1&b=2",
        language: "en-US",
        timeoutSec: 6,
        prompt: twiml.say(`Tom & Jerry's <script>`, {
          id: "Polly.Joanna-Neural",
          language: "en-US",
        }),
      }),
    );
    assert.match(xml, /action="https:\/\/x\.test\/listen\?a=1&amp;b=2"/);
    assert.match(xml, /Tom &amp; Jerry&apos;s &lt;script&gt;/);
    assert.match(xml, /actionOnEmptyResult="true"/);
    assert.doesNotMatch(xml, /<script>/);
  });

  test("keeps only real keypad keys", () => {
    assert.equal(twiml.playDigits('1w2#"><Hangup/>'), '<Play digits="1w2#"/>');
    assert.equal(twiml.playDigits("abc"), "");
  });
});

describe("the employee's side of a call", () => {
  const call = {
    direction: "outbound",
    fromNumber: "+15550101234",
    toNumber: "+15550109999",
    brief: "Confirm Dana's cleaning on Tuesday at 3pm.",
  } as PhoneCall;

  test("briefs a call from the number's instructions and the brief, never the Soul", () => {
    const prompt = composeCallSystemPrompt({ employee, company, number, call });
    assert.match(prompt, /Opening hours are 8am to 5pm/);
    assert.match(prompt, /Confirm Dana's cleaning/);
    assert.match(prompt, /Never claim to be human/);
    assert.match(prompt, /press_keys/);
    assert.doesNotMatch(prompt, /SECRET SOUL|62%/);
    const inbound = composeCallSystemPrompt({
      employee,
      company,
      number,
      call: { ...call, direction: "inbound", fromNumber: "+15550107777" },
    });
    assert.doesNotMatch(inbound, /press_keys|Confirm Dana/);
    assert.match(inbound, /unverified member of the public/);
    assert.doesNotMatch(
      composeTextReplySystemPrompt({ employee, company, number, counterpart: "+15550107777" }),
      /SECRET SOUL/,
    );
  });

  test("replays the transcript as alternating turns that end on the other side", () => {
    const messages = callMessages(call, [
      { speaker: "caller", text: "Hello?", at: "t1" },
      { speaker: "employee", text: "Hi, this is Ava.", at: "t2" },
      { speaker: "employee", text: "Are you still there?", at: "t3" },
      { speaker: "caller", text: "Yes, sorry.", at: "t4" },
    ]);
    assert.deepEqual(
      messages.map((m) => m.role),
      ["user", "assistant", "user"],
    );
    const merged = messages[1].content[0];
    assert.equal(merged.type === "text" && merged.text, "Hi, this is Ava.\nAre you still there?");
    assert.equal(
      messages[0].content[0].type === "text" && messages[0].content[0].text.includes("Hello?"),
      true,
    );
  });

  test("turns model text into something a voice can say", () => {
    assert.equal(
      speakable("**Sure!** Here's [the link](https://x.test) 😀"),
      "Sure! Here's the link",
    );
    const long = `${"This is a sentence. ".repeat(60)}`;
    const spoken = speakable(long);
    assert.ok(spoken.length <= 700);
    assert.ok(spoken.endsWith("."));
  });

  test("hangs up when the employee calls end_call, and presses keys on an outbound call", async () => {
    const { runner, seen } = fakeRunner(async (params) => {
      await params.tools.find((t) => t.name === "press_keys")!.run({ digits: "2w#" });
      await params.tools.find((t) => t.name === "end_call")!.run({});
      return "Thanks, **goodbye**!";
    });
    const result = await runCallTurn({
      model,
      employee,
      company,
      number,
      call: call as PhoneCall,
      transcript: [{ speaker: "caller", text: "Press 2 for appointments.", at: "t" }],
      runRestricted: runner,
    });
    assert.deepEqual(result, { text: "Thanks, goodbye!", endCall: true, digits: "2w#" });
    assert.deepEqual(
      seen[0].tools.map((t) => t.name),
      ["end_call", "press_keys"],
    );
  });
});

describe("the employee's side of a text conversation", () => {
  const thread = [{ direction: "inbound", body: "Hi, are you open Saturday?" }] as PhoneMessage[];

  test("returns the reply, trimmed to one text", async () => {
    const { runner } = fakeRunner(async () => "We're closed on Saturdays.");
    assert.equal(
      await runTextReplyTurn({
        model,
        employee,
        company,
        number,
        counterpart: "+15550107777",
        thread,
        runRestricted: runner,
      }),
      "We're closed on Saturdays.",
    );
  });

  test("sends nothing when the employee skips the reply", async () => {
    const { runner } = fakeRunner(async (params) => {
      await params.tools.find((t) => t.name === "skip_reply")!.run({});
      return "";
    });
    assert.equal(
      await runTextReplyTurn({
        model,
        employee,
        company,
        number,
        counterpart: "+15550107777",
        thread,
        runRestricted: runner,
      }),
      null,
    );
  });
});
