import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AppDataSource } from "../../db/datasource.js";
import { AppSetting } from "../../db/entities/AppSetting.js";
import { AuditEvent } from "../../db/entities/AuditEvent.js";
import { PhoneMessage } from "../../db/entities/PhoneMessage.js";
import { PhoneNumber } from "../../db/entities/PhoneNumber.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../../test/dbHarness.js";
import { jsonResponse, phoneFixture, stubTwilio } from "../../test/phoneFixtures.js";
import { getPublicUrlSettings, setPublicUrl } from "../publicUrl.js";
import { PhoneError } from "./errors.js";
import {
  importPhoneNumber,
  listImportablePhoneNumbers,
  removePhoneNumber,
  reservePhoneNumber,
  searchAvailablePhoneNumbers,
  updatePhoneNumber,
} from "./numbers.js";

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  // Back to "no public URL" for every test that does not set one.
  await getPublicUrlSettings();
});
after(closeTestDb);

const OWNED = {
  sid: "PN" + "a".repeat(32),
  phone_number: "+14155550199",
  friendly_name: "(415) 555-0199",
  capabilities: { voice: true, sms: true, mms: false },
  sms_url: "",
  voice_url: "",
};

describe("finding and reserving numbers", () => {
  test("search reads both capability spellings and the monthly price", async () => {
    const { company, connection } = await phoneFixture();
    const twilio = stubTwilio((url) =>
      url.includes("pricing.twilio.com")
        ? jsonResponse(200, {
            price_unit: "USD",
            phone_number_prices: [
              { number_type: "local", base_price: "1.15", current_price: "1.15" },
            ],
          })
        : jsonResponse(200, {
            available_phone_numbers: [
              {
                phone_number: "+14155550199",
                friendly_name: "(415) 555-0199",
                locality: "San Francisco",
                region: "CA",
                iso_country: "US",
                address_requirements: "none",
                capabilities: { voice: true, SMS: true, MMS: false },
              },
            ],
          }),
    );
    try {
      const found = await searchAvailablePhoneNumbers({
        companyId: company.id,
        connectionId: connection.id,
        country: "us",
        type: "local",
        areaCode: "415",
      });
      assert.deepEqual(found.monthlyPrice, { amount: "1.15", currency: "USD" });
      assert.equal(found.numbers[0].sms, true);
      assert.equal(found.numbers[0].voice, true);
      const search = twilio.calls.find((c) => c.url.includes("AvailablePhoneNumbers"));
      assert.match(search!.url, /AvailablePhoneNumbers\/US\/Local\.json\?AreaCode=415/);
    } finally {
      twilio.restore();
    }
  });

  test("reserves a number for an employee, without webhooks while there is no public URL", async () => {
    const { company, connection, employee } = await phoneFixture();
    const twilio = stubTwilio(() => jsonResponse(201, OWNED));
    try {
      const number = await reservePhoneNumber({
        companyId: company.id,
        connectionId: connection.id,
        phoneNumber: "+1 (415) 555-0199",
        employeeId: employee.id,
        label: "Sales line",
        country: "us",
        locality: "San Francisco, CA",
        userId: "user-1",
      });
      assert.equal(number.providerSid, OWNED.sid);
      assert.equal(number.employeeId, employee.id);
      assert.equal(number.country, "US");
      assert.equal(number.webhookBaseUrl, null);
      const purchase = twilio.calls[0];
      assert.equal(purchase.method, "POST");
      assert.match(purchase.url, /IncomingPhoneNumbers\.json$/);
      assert.equal(purchase.body.get("PhoneNumber"), "+14155550199");
      assert.equal(purchase.body.get("FriendlyName"), "Sales line");
      assert.equal(purchase.body.get("SmsUrl"), null);
      assert.ok(
        await AppDataSource.getRepository(AuditEvent).findOneBy({ action: "phone_number.reserve" }),
      );
    } finally {
      twilio.restore();
    }
  });

  test("points the webhooks at a reachable public URL in the same purchase", async () => {
    const { company, connection } = await phoneFixture();
    await setPublicUrl("https://genosyn.example.com");
    const twilio = stubTwilio(() => jsonResponse(201, OWNED));
    try {
      const number = await reservePhoneNumber({
        companyId: company.id,
        connectionId: connection.id,
        phoneNumber: "+14155550199",
        employeeId: null,
        label: "",
        country: "",
        locality: "",
        userId: null,
      });
      const body = twilio.calls[0].body;
      assert.equal(
        body.get("SmsUrl"),
        `https://genosyn.example.com/api/phone/webhooks/numbers/${number.id}/sms`,
      );
      assert.equal(
        body.get("VoiceUrl"),
        `https://genosyn.example.com/api/phone/webhooks/numbers/${number.id}/voice`,
      );
      assert.equal(number.webhookBaseUrl, "https://genosyn.example.com");
    } finally {
      twilio.restore();
      await AppDataSource.getRepository(AppSetting).delete({ key: "instance.publicUrl" });
      await getPublicUrlSettings();
    }
  });

  test("lists only the account's numbers that are not in Genosyn yet", async () => {
    const { company, connection, number } = await phoneFixture();
    const twilio = stubTwilio(() =>
      jsonResponse(200, {
        incoming_phone_numbers: [
          { ...OWNED, sid: number.providerSid, phone_number: number.e164 },
          { ...OWNED, voice_url: "https://elsewhere.example/voice" },
        ],
      }),
    );
    try {
      const importable = await listImportablePhoneNumbers(company.id, connection.id);
      assert.equal(importable.length, 1);
      assert.equal(importable[0].sid, OWNED.sid);
      assert.equal(importable[0].configuredElsewhere, true);
    } finally {
      twilio.restore();
    }
  });

  test("brings in an owned number, and refuses one that is already here", async () => {
    const { company, connection } = await phoneFixture();
    const twilio = stubTwilio(() => jsonResponse(200, OWNED));
    try {
      const imported = await importPhoneNumber({
        companyId: company.id,
        connectionId: connection.id,
        sid: OWNED.sid,
        employeeId: null,
        label: "",
        userId: null,
      });
      assert.equal(imported.reservedInGenosyn, false);
      assert.equal(imported.label, "(415) 555-0199");
      await assert.rejects(
        importPhoneNumber({
          companyId: company.id,
          connectionId: connection.id,
          sid: OWNED.sid,
          employeeId: null,
          label: "",
          userId: null,
        }),
        (err) => err instanceof PhoneError && err.status === 409,
      );
    } finally {
      twilio.restore();
    }
  });
});

describe("configuring a number", () => {
  test("refuses settings that cannot work", async () => {
    const { company, number } = await phoneFixture();
    const update = (patch: Parameters<typeof updatePhoneNumber>[0]["patch"]) =>
      updatePhoneNumber({ companyId: company.id, id: number.id, patch, userId: null });
    await assert.rejects(update({ callMode: "forward" }), /forwarded to/);
    await assert.rejects(update({ callMode: "forward", forwardTo: number.e164 }), /itself/);
    await assert.rejects(update({ voice: "Polly.Nobody" }), /Unknown voice/);
    await assert.rejects(update({ dailyTextLimit: -1 }), /Daily limits/);
    await assert.rejects(update({ instructions: "x".repeat(4_001) }), /4,000 characters/);
    await assert.rejects(update({ employeeId: "not-in-this-company" }), /not in this company/);
  });

  test("saves what changed and audits which fields", async () => {
    const { company, number } = await phoneFixture();
    const saved = await updatePhoneNumber({
      companyId: company.id,
      id: number.id,
      patch: {
        callMode: "forward",
        forwardTo: "+1 555 010 8888",
        textMode: "reply",
        instructions: "  Opening hours are 9 to 5.  \r\n",
      },
      userId: "user-1",
    });
    assert.equal(saved.forwardTo, "+15550108888");
    assert.equal(saved.textMode, "reply");
    assert.equal(saved.instructions, "  Opening hours are 9 to 5.");
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "phone_number.update",
    });
    assert.deepEqual(JSON.parse(audit.metadataJson).fields.sort(), [
      "callMode",
      "forwardTo",
      "instructions",
      "textMode",
    ]);
  });
});

describe("removing a number", () => {
  test("releases it from Twilio when asked, and takes its texts with it", async () => {
    const { company, number } = await phoneFixture();
    await insert(PhoneMessage, {
      companyId: company.id,
      phoneNumberId: number.id,
      employeeId: number.employeeId,
      direction: "inbound",
      fromNumber: "+15550107777",
      toNumber: number.e164,
      providerSid: "SM-gone",
      status: "received",
      occurredAt: new Date(),
      body: "123456",
    });
    const twilio = stubTwilio(() => new Response(null, { status: 204 }));
    try {
      await removePhoneNumber({
        companyId: company.id,
        id: number.id,
        release: true,
        userId: null,
      });
      assert.equal(twilio.calls[0].method, "DELETE");
      assert.match(
        twilio.calls[0].url,
        new RegExp(`IncomingPhoneNumbers/${number.providerSid}\\.json`),
      );
      assert.equal(await AppDataSource.getRepository(PhoneNumber).count(), 0);
      assert.equal(await AppDataSource.getRepository(PhoneMessage).count(), 0);
    } finally {
      twilio.restore();
    }
  });

  test("keeps the number on the Twilio account when not released", async () => {
    const { company, number } = await phoneFixture();
    const twilio = stubTwilio(() => jsonResponse(200, {}));
    try {
      await removePhoneNumber({
        companyId: company.id,
        id: number.id,
        release: false,
        userId: null,
      });
      // No webhooks were ever pointed here, so Twilio is not called at all.
      assert.equal(twilio.calls.length, 0);
      assert.equal(await AppDataSource.getRepository(PhoneNumber).count(), 0);
    } finally {
      twilio.restore();
    }
  });
});
