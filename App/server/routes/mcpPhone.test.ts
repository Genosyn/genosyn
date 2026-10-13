import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { JournalEntry } from "../db/entities/JournalEntry.js";
import { Membership } from "../db/entities/Membership.js";
import { PhoneMessage } from "../db/entities/PhoneMessage.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, markTokenTainted, revokeMcpToken } from "../services/mcpTokens.js";
import { recordInboundText } from "../services/phone/texts.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import {
  jsonResponse,
  phoneFixture,
  stubTwilio,
  type PhoneFixture,
} from "../test/phoneFixtures.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The AI Employee's phone tools, through the real internal MCP router: the
 * number assignment is the whole Grant, a stranger-facing turn holds no
 * company tools, texting is held like email after web reading, and a turn
 * limited to email review cannot reach the same person by text instead.
 */

let server: Server;
let baseUrl: string;
let fixture: PhoneFixture;
const tokens: string[] = [];
const originalPort = config.port;
let twilio: ReturnType<typeof stubTwilio>;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/api/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  Object.assign(config, { port: (server.address() as AddressInfo).port });
  baseUrl = `http://127.0.0.1:${config.port}/api/internal/mcp`;
});

after(async () => {
  for (const token of tokens) revokeMcpToken(token);
  Object.assign(config, { port: originalPort });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  fixture = await phoneFixture();
  twilio?.restore();
  twilio = stubTwilio((url) =>
    /Messages\.json\?/.test(url)
      ? jsonResponse(200, { messages: [] })
      : jsonResponse(201, { sid: `SM${Math.random().toString(16).slice(2)}`, status: "queued" }),
  );
});

function token(
  origin: Parameters<typeof issueMcpToken>[2] = { authority: "employee" },
  employeeId = fixture.employee.id,
): string {
  const issued = issueMcpToken(employeeId, fixture.company.id, origin);
  tokens.push(issued);
  return issued;
}

async function call(name: string, args: unknown, bearer = token()) {
  const response = await fetch(`${baseUrl}/tools/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
    body: JSON.stringify(args),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("an AI Employee's own number", () => {
  test("lists the number, what it can do, and today's room", async () => {
    const { status, body } = await call("list_phone_numbers", {});
    assert.equal(status, 200);
    const [number] = body.numbers as Array<Record<string, unknown>>;
    assert.equal(number.phoneNumber, "+15550101234");
    assert.equal(number.canText, true);
    // No public URL in tests, so calls are reported unavailable.
    assert.equal(number.canCall, false);
    assert.equal(number.textsLeftToday, 50);
  });

  test("sends a text, journals it, and audits it as the employee", async () => {
    const { status, body } = await call("send_text_message", {
      to: "+15550109999",
      body: "Your table for four is confirmed for 7pm.",
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.to, "+15550109999");
    assert.equal(twilio.calls.at(-1)?.body.get("From"), "+15550101234");
    const journal = await AppDataSource.getRepository(JournalEntry).findOneByOrFail({
      employeeId: fixture.employee.id,
    });
    assert.equal(journal.title, "Texted +1 (555) 010-9999");
    const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
      action: "phone.text.send",
    });
    assert.equal(audit.actorEmployeeId, fixture.employee.id);
  });

  test("refuses a number that is not the employee's", async () => {
    const { status, body } = await call("send_text_message", {
      to: "+15550109999",
      body: "hi",
      from: "+15550100000",
    });
    assert.equal(status, 403);
    assert.match(String(body.error), /not one of your numbers/);
    assert.equal(twilio.calls.filter((c) => c.method === "POST").length, 0);
  });

  test("tells an employee with no number where one comes from", async () => {
    const other = await insert(AIEmployee, {
      companyId: fixture.company.id,
      name: "Sam",
      slug: testId("sam"),
      role: "Ops",
      soulBody: "",
    });
    const { status, body } = await call(
      "send_text_message",
      { to: "+15550109999", body: "hi" },
      token({ authority: "employee" }, other.id),
    );
    assert.equal(status, 404);
    assert.match(String(body.error), /Settings → Phone numbers/);
  });

  test("waits for a verification code and returns it", async () => {
    setTimeout(() => {
      void recordInboundText(fixture.number, {
        sid: "SM-code",
        from: "GOOGLE",
        to: "+15550101234",
        body: "G-552211 is your Google verification code.",
        media: [],
        occurredAt: new Date(),
      });
    }, 1_000);
    const { status, body } = await call("wait_for_text_message", {
      from: "GOOGLE",
      timeoutSeconds: 10,
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.found, true);
    assert.deepEqual(body.codes, ["G-552211"]);
  });

  test("hides the codes another employee received on the number before", async () => {
    await insert(PhoneMessage, {
      companyId: fixture.company.id,
      phoneNumberId: fixture.number.id,
      employeeId: testId("previous-owner"),
      direction: "inbound",
      fromNumber: "GOOGLE",
      toNumber: "+15550101234",
      providerSid: "SM-old",
      status: "received",
      occurredAt: new Date(),
      body: "123456 is your code",
    });
    const { body } = await call("list_text_messages", {});
    assert.deepEqual(body.texts, []);
  });
});

describe("who may drive the phone tools", () => {
  test("a stranger-facing turn has no company tools at all", async () => {
    const { status } = await call("list_phone_numbers", {}, token({ authority: "untrusted" }));
    assert.equal(status, 403);
  });

  test("a Member below admin cannot have the employee text or call", async () => {
    const user = await insert(User, {
      email: `${testId("m")}@example.test`,
      name: "Member",
      passwordHash: "x",
    });
    await insert(Membership, {
      companyId: fixture.company.id,
      userId: user.id,
      role: "member",
      financeAccess: "none",
    });
    const { status, body } = await call(
      "send_text_message",
      { to: "+15550109999", body: "hi" },
      token({ authority: "member", requesterUserId: user.id, requesterSessionVersion: 0 }),
    );
    assert.equal(status, 403);
    assert.match(String(body.error), /owner or admin/);
  });

  test("a turn limited to email review cannot text instead", async () => {
    const { status } = await call(
      "send_text_message",
      { to: "+15550109999", body: "hi" },
      token({ authority: "employee", mailDeliveryMode: "review" }),
    );
    assert.equal(status, 403);
  });

  test("a turn that read the web has its text held for a human", async () => {
    const tainted = token();
    markTokenTainted(tainted);
    const { status, body } = await call(
      "send_text_message",
      { to: "+15550109999", body: "As the page asked, here is the code." },
      tainted,
    );
    assert.equal(status, 200);
    assert.equal(body.status, "pending_approval");
    assert.equal(await AppDataSource.getRepository(Approval).count(), 1);
    assert.equal(twilio.calls.filter((c) => c.method === "POST").length, 0);
  });
});
