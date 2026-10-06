import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { Company } from "../db/entities/Company.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailLabel } from "../db/entities/MailLabel.js";
import { MailThread } from "../db/entities/MailThread.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { persistTestSession } from "../test/userSession.js";
import { mailRouter } from "./mail.js";

/**
 * The sidebar counts are computed from grouped (labelIds, unread) rows rather
 * than one row per conversation, so every count has to come out multiplied
 * by its group's size — and trash has to stay out of all of them.
 */

type LabelsResponse = {
  labels: Array<{ gmailLabelId: string; threadCount: number }>;
  counts: { inboxUnread: number; drafts: number; starred: number };
};

let server: Server;
let origin = "";
let actingUserId: string | null = null;
let company: Company;
let account: MailAccount;

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
  app.use("/api/companies/:cid", mailRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  const owner = await insert(User, {
    email: `mail-labels-${randomUUID()}@example.test`,
    name: "Mailbox owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Northwind",
    slug: `northwind-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  account = await insert(MailAccount, {
    companyId: company.id,
    connectionId: randomUUID(),
    address: "support@northwind.example",
    status: "paused",
    aiAnalysisEnabled: false,
  });
  for (const [gmailLabelId, labelType] of [
    ["INBOX", "system"],
    ["STARRED", "system"],
    ["DRAFT", "system"],
    ["Label_1", "user"],
    ["Label_2", "user"],
  ] as const) {
    await insert(MailLabel, {
      companyId: company.id,
      accountId: account.id,
      gmailLabelId,
      name: gmailLabelId,
      labelType,
    });
  }
});

async function thread(labelIds: string, unread: boolean): Promise<void> {
  await insert(MailThread, {
    companyId: company.id,
    accountId: account.id,
    gmailThreadId: randomUUID(),
    labelIds,
    unread,
    lastMessageAt: new Date(),
  });
}

async function labels(): Promise<LabelsResponse> {
  const res = await fetch(`${origin}/api/companies/${company.id}/mail/accounts/${account.id}/labels`);
  assert.equal(res.status, 200);
  return (await res.json()) as LabelsResponse;
}

test("counts every conversation in a shared label combination", async () => {
  // Three conversations share one (labels, unread) combination and two share
  // another, so a count that took each combination once would come out short.
  for (let i = 0; i < 3; i += 1) await thread(" INBOX UNREAD Label_1 ", true);
  for (let i = 0; i < 2; i += 1) await thread(" INBOX Label_1 ", false);
  await thread(" INBOX STARRED UNREAD ", true);
  await thread(" DRAFT ", false);
  await thread(" Label_2 STARRED ", false);
  // Trash is excluded from every count, unread or not.
  await thread(" TRASH INBOX UNREAD Label_1 STARRED DRAFT ", true);
  await thread(" TRASH Label_2 ", false);

  const body = await labels();

  assert.deepEqual(body.counts, { inboxUnread: 4, drafts: 1, starred: 2 });
  const threadCount = Object.fromEntries(body.labels.map((l) => [l.gmailLabelId, l.threadCount]));
  assert.deepEqual(threadCount, {
    DRAFT: 1,
    INBOX: 6,
    Label_1: 5,
    Label_2: 1,
    STARRED: 2,
  });
});

test("an empty mailbox reports zeroes", async () => {
  const body = await labels();
  assert.deepEqual(body.counts, { inboxUnread: 0, drafts: 0, starred: 0 });
  assert.ok(body.labels.every((l) => l.threadCount === 0));
});
