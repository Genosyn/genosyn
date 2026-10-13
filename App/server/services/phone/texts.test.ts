import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { PhoneMessage } from "../../db/entities/PhoneMessage.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../../test/dbHarness.js";
import { PhoneError } from "./errors.js";
import { jsonResponse, phoneFixture, stubTwilio } from "../../test/phoneFixtures.js";
import {
  listTexts,
  recordInboundText,
  sendText,
  setFreshInboundTextHandler,
  waitForText,
} from "./texts.js";

before(initTestDb);
beforeEach(resetTestDb);
after(async () => {
  setFreshInboundTextHandler(null);
  await closeTestDb();
});

function inbound(sid: string, body: string, from = "+15550107777") {
  return { sid, from, to: "+15550101234", body, media: [], occurredAt: new Date() };
}

describe("receiving texts", () => {
  test("keeps each text once, and hands only the first copy on", async () => {
    const { number } = await phoneFixture();
    const seen: string[] = [];
    setFreshInboundTextHandler((message) => seen.push(message.id));
    try {
      const first = await recordInboundText(number, inbound("SM1", "Your code is 482913"));
      const again = await recordInboundText(number, inbound("SM1", "Your code is 482913"));
      assert.equal(first.created, true);
      assert.equal(again.created, false);
      assert.equal(again.message.id, first.message.id);
      assert.deepEqual(seen, [first.message.id]);
      assert.equal(await AppDataSource.getRepository(PhoneMessage).count(), 1);
    } finally {
      setFreshInboundTextHandler(null);
    }
  });

  test("shows an employee only texts from while the number was its own or nobody's", async () => {
    const { number, employee } = await phoneFixture();
    const mine = await recordInboundText(number, inbound("SM-mine", "mine"));
    await recordInboundText({ ...number, employeeId: null }, inbound("SM-none", "unassigned"));
    await recordInboundText(
      { ...number, employeeId: testId("other") },
      inbound("SM-old", "old owner"),
    );
    const visible = await listTexts({
      phoneNumberIds: [number.id],
      visibleToEmployeeId: employee.id,
      limit: 10,
    });
    assert.deepEqual(visible.map((t) => t.body).sort(), ["mine", "unassigned"]);
    assert.ok(visible.some((t) => t.id === mine.message.id));
    const all = await listTexts({ phoneNumberIds: [number.id], limit: 10 });
    assert.equal(all.length, 3);
  });

  test("filters by sender and body, newest first", async () => {
    const { number } = await phoneFixture();
    await recordInboundText(number, {
      ...inbound("SM-a", "Hello there"),
      occurredAt: new Date(Date.now() - 60_000),
    });
    await recordInboundText(number, inbound("SM-b", "Your Stripe code is 123456", "STRIPE"));
    const [match] = await listTexts({
      phoneNumberIds: [number.id],
      counterpart: "STRIPE",
      contains: "code",
      limit: 5,
    });
    assert.equal(match.providerSid, "SM-b");
    const newest = await listTexts({ phoneNumberIds: [number.id], limit: 5 });
    assert.deepEqual(
      newest.map((t) => t.providerSid),
      ["SM-b", "SM-a"],
    );
  });
});

describe("waiting for a text", () => {
  test("returns a matching text that arrives during the wait, with its code", async () => {
    const { number } = await phoneFixture();
    const twilio = stubTwilio(() => jsonResponse(200, { messages: [] }));
    try {
      setTimeout(() => {
        void recordInboundText(
          number,
          inbound("SM-otp", "Your verification code is 771234", "GOOGLE"),
        );
      }, 1_200);
      const result = await waitForText({
        numbers: [number],
        from: "GOOGLE",
        since: new Date(Date.now() - 60_000),
        timeoutMs: 10_000,
      });
      assert.ok(result);
      assert.equal(result.message.providerSid, "SM-otp");
      assert.deepEqual(result.codes, ["771234"]);
    } finally {
      twilio.restore();
    }
  });

  test("gives up after the timeout when nothing matches", async () => {
    const { number } = await phoneFixture();
    const twilio = stubTwilio(() => jsonResponse(200, { messages: [] }));
    try {
      await recordInboundText(number, inbound("SM-other", "unrelated", "+15550108888"));
      const result = await waitForText({
        numbers: [number],
        from: "GOOGLE",
        since: new Date(Date.now() - 60_000),
        timeoutMs: 1_500,
      });
      assert.equal(result, null);
    } finally {
      twilio.restore();
    }
  });

  test("fetches texts from Twilio when nothing pushes them", async () => {
    const { number } = await phoneFixture();
    const twilio = stubTwilio(() =>
      jsonResponse(200, {
        messages: [
          {
            sid: "SM-polled",
            from: "+15550107777",
            to: "+15550101234",
            body: "Code 445566",
            status: "received",
            direction: "inbound",
            date_sent: new Date().toUTCString(),
          },
        ],
      }),
    );
    try {
      const result = await waitForText({
        numbers: [number],
        since: new Date(Date.now() - 60_000),
        timeoutMs: 3_000,
      });
      assert.equal(result?.message.providerSid, "SM-polled");
      assert.match(twilio.calls[0].url, /\/Messages\.json\?/);
      assert.match(twilio.calls[0].url, /To=%2B15550101234/);
    } finally {
      twilio.restore();
    }
  });
});

describe("sending texts", () => {
  test("sends from the employee's own number through Twilio", async () => {
    const { number, employee } = await phoneFixture();
    const twilio = stubTwilio(() => jsonResponse(201, { sid: "SM-out", status: "queued" }));
    try {
      const sent = await sendText({
        number,
        to: "+1 (555) 010-9999",
        body: "Running five minutes late.",
        sender: { kind: "employee", employeeId: employee.id, runId: null },
      });
      assert.equal(sent.providerSid, "SM-out");
      assert.equal(sent.status, "queued");
      assert.equal(sent.toNumber, "+15550109999");
      const request = twilio.calls[0];
      assert.equal(request.method, "POST");
      assert.equal(request.body.get("From"), "+15550101234");
      assert.equal(request.body.get("To"), "+15550109999");
      assert.equal(request.body.get("Body"), "Running five minutes late.");
      // No public URL in tests, so no status callback is promised to Twilio.
      assert.equal(request.body.get("StatusCallback"), null);
    } finally {
      twilio.restore();
    }
  });

  test("refuses another employee's number, a bad recipient, and an over-long text", async () => {
    const { number, employee } = await phoneFixture();
    const twilio = stubTwilio(() => jsonResponse(201, { sid: "SM-x", status: "queued" }));
    try {
      await assert.rejects(
        sendText({
          number,
          to: "+15550109999",
          body: "hi",
          sender: { kind: "employee", employeeId: "someone-else", runId: null },
        }),
        (err) => err instanceof PhoneError && err.status === 403,
      );
      await assert.rejects(
        sendText({
          number,
          to: "555-0199",
          body: "hi",
          sender: { kind: "employee", employeeId: employee.id, runId: null },
        }),
        /not a phone number/,
      );
      await assert.rejects(
        sendText({
          number,
          to: "+15550109999",
          body: "x".repeat(1_601),
          sender: { kind: "employee", employeeId: employee.id, runId: null },
        }),
        /at most 1600 characters|at most 1,600 characters/,
      );
      assert.equal(twilio.calls.length, 0);
    } finally {
      twilio.restore();
    }
  });

  test("stops at the daily limit for AI texts, but not for a Member's", async () => {
    const { number, employee } = await phoneFixture({ dailyTextLimit: 1 });
    await insert(PhoneMessage, {
      companyId: number.companyId,
      phoneNumberId: number.id,
      employeeId: employee.id,
      direction: "outbound",
      fromNumber: number.e164,
      toNumber: "+15550109999",
      providerSid: "SM-earlier",
      status: "delivered",
      occurredAt: new Date(),
      body: "earlier",
    });
    const twilio = stubTwilio(() =>
      jsonResponse(201, { sid: `SM-${Math.random()}`, status: "queued" }),
    );
    try {
      await assert.rejects(
        sendText({
          number,
          to: "+15550109999",
          body: "again",
          sender: { kind: "employee", employeeId: employee.id, runId: null },
        }),
        (err) => err instanceof PhoneError && err.status === 429,
      );
      const member = await sendText({
        number,
        to: "+15550109999",
        body: "From a person",
        sender: { kind: "member", userId: "user-1" },
      });
      assert.equal(member.sentByUserId, "user-1");
    } finally {
      twilio.restore();
    }
  });

  test("records Twilio's refusal on the text", async () => {
    const { number, employee } = await phoneFixture();
    const twilio = stubTwilio(() =>
      jsonResponse(400, { code: 21608, message: "The number is unverified.", status: 400 }),
    );
    try {
      await assert.rejects(
        sendText({
          number,
          to: "+15550109999",
          body: "hi",
          sender: { kind: "employee", employeeId: employee.id, runId: null },
        }),
        /Trial accounts can only text verified numbers/,
      );
      const [failed] = await AppDataSource.getRepository(PhoneMessage).find();
      assert.equal(failed.status, "failed");
      assert.equal(failed.errorCode, 21608);
    } finally {
      twilio.restore();
    }
  });
});
