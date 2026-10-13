import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { PhoneMessage } from "../db/entities/PhoneMessage.js";
import { closeTestDb, initTestDb, resetTestDb } from "../test/dbHarness.js";
import { phoneFixture, TEST_ACCOUNT_SID, TEST_AUTH_TOKEN } from "../test/phoneFixtures.js";
import { twilioSignature } from "../services/phone/signature.js";
import { PHONE_WEBHOOK_MOUNT } from "../services/phone/webhookUrls.js";
import { phoneWebhooksRouter } from "./phoneWebhooks.js";

/**
 * The phone webhooks answer strangers on the internet before any session
 * exists. What matters is that only a request Twilio signed with the number's
 * own Auth Token does anything, that a retried delivery is kept once, and that
 * every wrong id looks the same from outside.
 */

let server: Server;
let baseUrl: string;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(PHONE_WEBHOOK_MOUNT, phoneWebhooksRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(resetTestDb);

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function post(
  path: string,
  params: Record<string, string>,
  opts: { token?: string; signature?: string } = {},
): Promise<Response> {
  const url = `${baseUrl}${PHONE_WEBHOOK_MOUNT}${path}`;
  const signature = opts.signature ?? twilioSignature(opts.token ?? TEST_AUTH_TOKEN, url, params);
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(params).toString(),
  });
}

function sms(sid: string, body: string): Record<string, string> {
  return {
    AccountSid: TEST_ACCOUNT_SID,
    MessageSid: sid,
    From: "+15550107777",
    To: "+15550101234",
    Body: body,
    NumMedia: "0",
  };
}

describe("incoming texts", () => {
  test("a signed delivery is kept, and a retried one is kept only once", async () => {
    const { number } = await phoneFixture();
    for (let i = 0; i < 2; i += 1) {
      const res = await post(`/numbers/${number.id}/sms`, sms("SM100", "Your code is 482913"));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /xml/);
      assert.match(await res.text(), /<Response><\/Response>/);
    }
    const rows = await AppDataSource.getRepository(PhoneMessage).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].body, "Your code is 482913");
    assert.equal(rows[0].direction, "inbound");
  });

  test("a delivery signed with another token, or not signed, does nothing", async () => {
    const { number } = await phoneFixture();
    const forged = await post(`/numbers/${number.id}/sms`, sms("SM200", "x"), {
      token: "f".repeat(32),
    });
    assert.equal(forged.status, 403);
    const unsigned = await post(`/numbers/${number.id}/sms`, sms("SM201", "x"), { signature: "" });
    assert.equal(unsigned.status, 403);
    assert.equal(await AppDataSource.getRepository(PhoneMessage).count(), 0);
  });

  test("a delivery claiming another Twilio account is refused even when signed", async () => {
    const { number } = await phoneFixture();
    const res = await post(`/numbers/${number.id}/sms`, {
      ...sms("SM300", "x"),
      AccountSid: "AC" + "f".repeat(32),
    });
    assert.equal(res.status, 403);
  });

  test("unknown and malformed ids look the same", async () => {
    await phoneFixture();
    const unknown = await post(
      `/numbers/6f1c2f2c-4c3b-4f4a-9d3e-2a1b0c9d8e7f/sms`,
      sms("SM1", "x"),
    );
    const malformed = await post(`/numbers/not-a-uuid/sms`, sms("SM1", "x"));
    assert.equal(unknown.status, 404);
    assert.equal(malformed.status, 404);
    assert.equal(await unknown.text(), "");
  });
});

describe("incoming calls", () => {
  test("a signed call is answered with TwiML", async () => {
    const { number } = await phoneFixture();
    const res = await post(`/numbers/${number.id}/voice`, {
      AccountSid: TEST_ACCOUNT_SID,
      CallSid: "CA100",
      From: "+15550107777",
      To: number.e164,
      CallStatus: "ringing",
      Direction: "inbound",
    });
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.match(xml, /<Gather input="speech"/);
    // Later URLs in the call are built on the address Twilio used.
    assert.match(
      xml,
      new RegExp(`action="${baseUrl.replace(/[.]/g, "\\.")}${PHONE_WEBHOOK_MOUNT}/calls/`),
    );
  });
});

describe("text delivery status", () => {
  test("moves an outbound text forward", async () => {
    const { number } = await phoneFixture();
    const message = await AppDataSource.getRepository(PhoneMessage).save(
      AppDataSource.getRepository(PhoneMessage).create({
        companyId: number.companyId,
        phoneNumberId: number.id,
        employeeId: number.employeeId,
        direction: "outbound",
        fromNumber: number.e164,
        toNumber: "+15550109999",
        providerSid: "SM900",
        status: "queued",
        occurredAt: new Date(),
        body: "hi",
      }),
    );
    const res = await post(`/messages/${message.id}/status`, {
      AccountSid: TEST_ACCOUNT_SID,
      MessageSid: "SM900",
      MessageStatus: "undelivered",
      ErrorCode: "30034",
    });
    assert.equal(res.status, 204);
    const saved = await AppDataSource.getRepository(PhoneMessage).findOneByOrFail({
      id: message.id,
    });
    assert.equal(saved.status, "undelivered");
    assert.equal(saved.errorCode, 30034);
    assert.match(saved.errorMessage, /10DLC/);
  });
});
