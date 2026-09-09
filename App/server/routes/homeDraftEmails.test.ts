import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";
import cookieSession from "cookie-session";
import express from "express";
import { WebSocket } from "ws";

import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { MailAccount } from "../db/entities/MailAccount.js";
import { MailMessage } from "../db/entities/MailMessage.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { UserSession } from "../db/entities/UserSession.js";
import { errorHandler } from "../middleware/error.js";
import { type HomeData } from "../services/home.js";
import { createDraftSendBatch } from "../services/mail/draftSendQueue.js";
import { attachRealtime, mintWsToken, type WsEvent } from "../services/realtime.js";
import { createUserSession, type UserSessionIdentity } from "../services/userSessions.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testId } from "../test/dbHarness.js";
import { homeRouter } from "./home.js";

let server: Server;
let baseUrl: string;
let company: Company;
let otherCompany: Company;
let owner: User;
let member: User;
let outsider: User;
const clients = new Set<WebSocket>();

async function closeClients(): Promise<void> {
  await Promise.all(
    [...clients].map(async (socket) => {
      if (socket.readyState === WebSocket.CLOSED) return;
      const closed = once(socket, "close");
      socket.terminate();
      await closed;
    }),
  );
  clients.clear();
}

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use(
    cookieSession({ name: "session", keys: ["home-drafts-test-signing-key"], secure: false }),
  );
  // Only session issuance is a fixture; cookie signing, authentication,
  // persisted session validity, company membership, and Home are real.
  app.post("/test/sign-in/:uid", async (req, res) => {
    const user = await AppDataSource.getRepository(User).findOneByOrFail({ id: req.params.uid });
    const identity = await createUserSession(user);
    req.session = { ...identity, authenticatedAt: Date.now() };
    res.json(identity);
  });
  app.use("/api/companies/:cid", homeRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  attachRealtime(server);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await closeClients();
  await resetTestDb();
  owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "fixture",
    sessionVersion: 0,
  });
  member = await insert(User, {
    email: "member@example.test",
    name: "Member",
    passwordHash: "fixture",
    sessionVersion: 0,
  });
  outsider = await insert(User, {
    email: "outsider@example.test",
    name: "Outsider",
    passwordHash: "fixture",
    sessionVersion: 0,
  });
  company = await insert(Company, {
    name: "Home company",
    slug: "home-company",
    ownerId: owner.id,
  });
  otherCompany = await insert(Company, {
    name: "Private company",
    slug: "private-company",
    ownerId: outsider.id,
  });
  await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
  await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
  await insert(Membership, { companyId: otherCompany.id, userId: outsider.id, role: "owner" });
});

after(async () => {
  await closeClients();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

async function signIn(user: User): Promise<{ cookie: string; identity: UserSessionIdentity }> {
  const response = await fetch(`${baseUrl}/test/sign-in/${user.id}`, { method: "POST" });
  assert.equal(response.status, 200);
  return {
    identity: (await response.json()) as UserSessionIdentity,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}

async function home(cookie?: string, companyId = company.id) {
  const response = await fetch(`${baseUrl}/api/companies/${companyId}/home`, {
    headers: cookie ? { cookie } : {},
  });
  return { status: response.status, body: (await response.json()) as HomeData };
}

async function draftMailbox(companyId = company.id) {
  const account = await insert(MailAccount, {
    companyId,
    connectionId: testId("connection"),
    address: `${companyId}@example.test`,
  });
  const draft = await addDraft(account);
  return { account, draft };
}

async function addDraft(account: MailAccount) {
  return insert(MailMessage, {
    companyId: account.companyId,
    accountId: account.id,
    threadId: testId("thread"),
    gmailMessageId: testId("message"),
    gmailThreadId: testId("provider-thread"),
    gmailDraftId: testId("provider-draft"),
    toEmails: "recipient@example.test",
    subject: "Needs review",
    createdByUserId: owner.id,
  });
}

describe("Home draft email authorization and response", () => {
  test("requires authentication before revealing draft counts or previews", async () => {
    await draftMailbox();
    const response = await home();
    assert.equal(response.status, 401);
    assert.equal("draftEmailCount" in response.body, false);
  });

  test("rejects a forged signed session", async () => {
    const session = await signIn(member);
    const forged = session.cookie.replace(/session.sig=[^;]+/, "session.sig=forged");
    assert.equal((await home(forged)).status, 401);
  });

  test("rejects nonmembers even when they own a different company", async () => {
    await draftMailbox();
    assert.equal((await home((await signIn(outsider)).cookie)).status, 403);
  });

  test("allows an ordinary Member to review all company mailbox drafts", async () => {
    const own = await draftMailbox();
    const other = await draftMailbox(otherCompany.id);
    const response = await home((await signIn(member)).cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.draftEmailCount, 1);
    assert.deepEqual(
      response.body.draftEmails.map((row) => row.id),
      [own.draft.id],
    );
    assert.deepEqual(response.body.draftEmailAccounts, [
      { id: own.account.id, email: own.account.address, count: 1 },
    ]);
    assert.equal(JSON.stringify(response.body).includes(other.account.address), false);
  });

  test("rejects a company-id substitution in the Home URL", async () => {
    await draftMailbox(otherCompany.id);
    assert.equal((await home((await signIn(member)).cookie, otherCompany.id)).status, 403);
  });

  test("separates counts and preview content when a Member belongs to both companies", async () => {
    await insert(Membership, { companyId: otherCompany.id, userId: member.id, role: "member" });
    const own = await draftMailbox();
    const other = await draftMailbox(otherCompany.id);
    await addDraft(other.account);
    const { cookie } = await signIn(member);
    const one = await home(cookie);
    const two = await home(cookie, otherCompany.id);
    assert.equal(one.body.draftEmailCount, 1);
    assert.equal(two.body.draftEmailCount, 2);
    assert.ok(one.body.draftEmails.every((row) => row.accountId === own.account.id));
    assert.ok(two.body.draftEmails.every((row) => row.accountId === other.account.id));
  });

  test("returns the full count even when only five preview rows are sent", async () => {
    const { account } = await draftMailbox();
    for (let index = 0; index < 6; index += 1) await addDraft(account);
    const response = await home((await signIn(owner)).cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.draftEmailCount, 7);
    assert.equal(response.body.draftEmails.length, 5);
    assert.equal(response.body.draftEmailAccounts[0].count, 7);
  });

  test("revoking a persisted browser session prevents further draft reads", async () => {
    const { cookie, identity } = await signIn(member);
    await AppDataSource.getRepository(UserSession).delete(identity.userSessionId);
    assert.equal((await home(cookie)).status, 401);
  });
});

async function connect(identity: UserSessionIdentity) {
  const token = await mintWsToken(member.id, company.id, { kind: "session", identity });
  const socket = new WebSocket(
    `${baseUrl.replace("http:", "ws:")}/api/ws?token=${encodeURIComponent(token)}`,
  );
  clients.add(socket);
  await new Promise<void>((resolve, reject) => {
    const onMessage = (data: Buffer) => {
      if ((JSON.parse(String(data)) as WsEvent).type !== "hello") return;
      socket.off("message", onMessage);
      resolve();
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
  return socket;
}

function nextMailUpdate(socket: WebSocket): Promise<Extract<WsEvent, { type: "mail.updated" }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", listener);
      reject(new Error("Draft queue change did not broadcast mail.updated"));
    }, 10_000);
    const listener = (data: Buffer) => {
      const event = JSON.parse(String(data)) as WsEvent;
      if (event.type !== "mail.updated") return;
      clearTimeout(timer);
      socket.off("message", listener);
      resolve(event);
    };
    socket.on("message", listener);
  });
}

test("queueing and appending drafts broadcasts a live update after Home counts have changed", async () => {
  const { account, draft } = await draftMailbox();
  const second = await addDraft(account);
  const { cookie, identity } = await signIn(member);
  const socket = await connect(identity);
  assert.equal((await home(cookie)).body.draftEmailCount, 2);

  const queued = nextMailUpdate(socket);
  const firstBatch = await createDraftSendBatch(account, [draft.id], member.id);
  assert.deepEqual(await queued, { type: "mail.updated", accountId: account.id });
  const afterQueue = await home(cookie);
  assert.equal(afterQueue.body.draftEmailCount, 1);
  assert.deepEqual(
    afterQueue.body.draftEmails.map((row) => row.id),
    [second.id],
  );

  const appended = nextMailUpdate(socket);
  const secondBatch = await createDraftSendBatch(account, [second.id], member.id);
  assert.equal(secondBatch.batch.id, firstBatch.batch.id);
  assert.deepEqual(await appended, { type: "mail.updated", accountId: account.id });
  const afterAppend = await home(cookie);
  assert.equal(afterAppend.body.draftEmailCount, 0);
  assert.deepEqual(afterAppend.body.draftEmailAccounts, []);
});
