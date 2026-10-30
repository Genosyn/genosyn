import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { RevenueDocumentCandidate } from "../db/entities/RevenueDocumentCandidate.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { scanMailForRevenueDocuments } from "../services/revenue/documentCapture.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { emailLogsRouter } from "./emailLogs.js";
import { revenueRouter } from "./revenue.js";

/**
 * Lists that still page by offset sort on a timestamp many rows share — a
 * batch of notification email, a bounce sweep's suppressions, a mailbox's
 * messages sent in the same second. Without a unique last sort key the rows
 * that tie can come back in a different order on each page, so Previous and
 * Next repeat some and pass over others. Each now ends its order in the id.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let admin: User;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid/email/logs", emailLogsRouter);
  app.use("/api/companies/:cid", revenueRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  admin = await insert(User, {
    email: "admin@example.com",
    name: "Admin",
    passwordHash: "x",
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: admin.id });
  await insert(Membership, { companyId: company.id, userId: admin.id, role: "owner" });
  actingUserId = admin.id;
});

async function get(path: string) {
  const response = await fetch(`${baseUrl}/api/companies/${company.id}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** Every offset page of a list, in order. */
async function offsetPages(path: string, pageSize: number, total: number): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; offset < total; offset += pageSize) {
    const joiner = path.includes("?") ? "&" : "?";
    const page = await get(`${path}${joiner}limit=${pageSize}&offset=${offset}`);
    assert.equal(page.status, 200, JSON.stringify(page.body));
    ids.push(...(page.body.rows as Array<{ id: string }>).map((row) => row.id));
  }
  return ids;
}

const descending = (ids: string[]) => [...ids].sort((a, b) => (a < b ? 1 : -1));
const ascending = (ids: string[]) => [...ids].sort((a, b) => (a < b ? -1 : 1));
const INSTANT = "2026-05-04 09:00:00";

describe("offset lists that sort on a shared timestamp end their order in the id", () => {
  test("Settings → Notification email → Logs: a batch sent in one second pages each log once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 75; i++) {
      const id = randomUUID();
      ids.push(id);
      await AppDataSource.query(
        `INSERT INTO email_logs (id, companyId, transport, purpose, toAddress, fromAddress, subject, status, createdAt)
         VALUES (?, ?, 'console', 'other', ?, 'noreply@acme.example', 'Digest', 'sent', ?)`,
        [id, company.id, `person${i}@example.com`, INSTANT],
      );
    }
    const paged = await offsetPages("/email/logs", 25, 75);
    assert.equal(new Set(paged).size, 75, "no log twice, none passed over");
    assert.deepEqual(paged, descending(ids), "newest first, then by id");
  });

  test("Revenue → Suppressions: addresses suppressed together page each one once", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) {
      const id = randomUUID();
      ids.push(id);
      await AppDataSource.query(
        `INSERT INTO suppressions (id, companyId, email, reason, source, notes, createdAt)
         VALUES (?, ?, ?, 'bounce', 'sweep', '', ?)`,
        [id, company.id, `bounced${i}@example.com`, INSTANT],
      );
    }
    const paged = await offsetPages("/revenue/suppressions", 25, 60);
    assert.equal(new Set(paged).size, 60);
    assert.deepEqual(paged, descending(ids));
  });

  test("document capture scans messages sent in the same second once each, in id order", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 23; i++) {
      const message = await insert(MailMessage, {
        companyId: company.id,
        accountId: "mail-account-1",
        threadId: `thread-${i}`,
        gmailMessageId: `gmail-message-${i}`,
        gmailThreadId: `gmail-thread-${i}`,
        fromEmail: "seller@example.com",
        toEmails: "buyer@example.com",
        subject: "Proposal attached",
        sentAt: new Date("2026-05-04T09:00:00.000Z"),
        attachmentsJson: JSON.stringify([
          { attachmentId: `att-${i}`, filename: "Proposal.pdf", mimeType: "application/pdf", size: 128 },
        ]),
      });
      ids.push(message.id);
    }
    const scanned: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const before = new Set(
        (await AppDataSource.getRepository(RevenueDocumentCandidate).findBy({ companyId: company.id })).map(
          (candidate) => candidate.mailMessageId,
        ),
      );
      const page = await scanMailForRevenueDocuments(company.id, { limit: 7, offset });
      const after = await AppDataSource.getRepository(RevenueDocumentCandidate).findBy({
        companyId: company.id,
      });
      scanned.push(...after.map((candidate) => candidate.mailMessageId).filter((id) => !before.has(id)));
      assert.equal(page.createdCandidates, page.scannedMessages, "every message on the page is new");
      offset = page.nextOffset;
    }
    assert.deepEqual(ascending(scanned), ascending(ids), "every message once");
    assert.equal(
      await AppDataSource.getRepository(RevenueDocumentCandidate).countBy({ companyId: company.id }),
      23,
    );
  });
});
