import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import bcrypt from "bcrypt";
import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { hashToken } from "../lib/token.js";
import { errorHandler } from "../middleware/error.js";
import { ADMIN_SETUP_LINK_TTL_MS } from "../services/adminUserCreate.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { adminRouter } from "./admin.js";
import { authRouter } from "./auth.js";

/**
 * Admin → Users → Add user.
 *
 * A master admin creates an account by hand, with either a first password they
 * set or a one-time setup link that is the ordinary reset token — so the link
 * is proven here by redeeming it through the real `/api/auth/reset` route, not
 * by reading the column back. The account may start in a company, never as its
 * owner, and the add is recorded in that company's audit log.
 */

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let operator: User;
let company: Company;

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
  app.use("/api/admin", adminRouter);
  app.use("/api/auth", authRouter);
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
  operator = await insert(User, {
    email: "op@example.com",
    name: "Operator",
    passwordHash: "x",
    sessionVersion: 0,
    isMasterAdmin: true,
    emailVerifiedAt: new Date(),
  });
  actingUserId = operator.id;
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: operator.id });
  await insert(Membership, { companyId: company.id, userId: operator.id, role: "owner" });
});

type CreatedResponse = {
  user: {
    id: string;
    email: string;
    name: string;
    handle: string | null;
    isMasterAdmin: boolean;
    membershipCount: number;
    ownedCompanies: unknown[];
  };
  setupLink: string | null;
  emailStatus: "sent" | "skipped" | "failed";
  error?: string;
};

async function addUser(body: Record<string, unknown>): Promise<{
  status: number;
  body: CreatedResponse;
}> {
  const response = await fetch(`${baseUrl}/api/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as CreatedResponse };
}

const withPassword = {
  name: "Grace Hopper",
  email: "grace@example.com",
  password: "correct horse battery",
  companyId: null,
};

async function storedUser(email: string): Promise<User | null> {
  return AppDataSource.getRepository(User).findOneBy({ email });
}

describe("POST /api/admin/users", () => {
  test("only a master admin may add a user", async () => {
    const member = await insert(User, {
      email: "member@example.com",
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
      emailVerifiedAt: new Date(),
    });
    actingUserId = member.id;
    const refused = await addUser(withPassword);
    assert.equal(refused.status, 403);
    assert.equal(await storedUser("grace@example.com"), null);

    actingUserId = null;
    assert.equal((await addUser(withPassword)).status, 401);
    assert.equal(await storedUser("grace@example.com"), null);
  });

  test("adds an account with the password the admin set", async () => {
    const created = await addUser({ ...withPassword, email: "  Grace@Example.com " });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.email, "grace@example.com");
    assert.equal(created.body.user.name, "Grace Hopper");
    assert.equal(created.body.user.isMasterAdmin, false);
    assert.equal(created.body.user.membershipCount, 0);
    assert.deepEqual(created.body.user.ownedCompanies, []);
    assert.ok(created.body.user.handle, "the account gets a handle like any other");
    assert.equal(created.body.setupLink, null);

    const user = await storedUser("grace@example.com");
    assert.ok(user);
    assert.ok(await bcrypt.compare("correct horse battery", user.passwordHash));
    assert.equal(user.resetToken, null, "no setup link is left open");
    assert.equal(user.isMasterAdmin, false);
    // The admin does not vouch for the mailbox: it starts unverified, exactly
    // like a self-registered account.
    assert.equal(user.emailVerifiedAt, null);
    assert.equal(await AppDataSource.getRepository(Membership).countBy({ userId: user.id }), 0);

    const listed = (await (await fetch(`${baseUrl}/api/admin/users`)).json()) as Array<{
      email: string;
    }>;
    assert.ok(listed.some((row) => row.email === "grace@example.com"));
  });

  test("a new account can sign in with the password the admin set", async () => {
    await addUser(withPassword);
    actingUserId = null;
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "grace@example.com", password: "correct horse battery" }),
    });
    assert.equal(login.status, 200);
  });

  test("leaves the password to the person through a one-time setup link", async () => {
    const before = Date.now();
    const created = await addUser({ ...withPassword, password: null });
    assert.equal(created.status, 201);
    const link = created.body.setupLink;
    assert.ok(link, "the admin gets the link to pass on");
    const url = new URL(link);
    assert.equal(url.searchParams.get("setup"), "1");
    const match = /^\/reset\/([^/]+)$/.exec(url.pathname);
    assert.ok(match, `unexpected setup link ${link}`);
    const token = decodeURIComponent(match[1]);

    const user = await storedUser("grace@example.com");
    assert.ok(user);
    // Only the digest is stored, and it expires like an invitation does.
    assert.equal(user.resetToken, hashToken(token));
    assert.ok(user.resetExpiresAt);
    const ttl = user.resetExpiresAt.getTime() - before;
    assert.ok(ttl >= ADMIN_SETUP_LINK_TTL_MS - 5_000 && ttl <= ADMIN_SETUP_LINK_TTL_MS + 5_000);

    // Nobody knows the password the account starts with.
    assert.equal(await bcrypt.compare("", user.passwordHash), false);
    assert.equal(await bcrypt.compare("correct horse battery", user.passwordHash), false);

    // The link is the ordinary reset token: the real reset route redeems it, once.
    actingUserId = null;
    const redeem = () =>
      fetch(`${baseUrl}/api/auth/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: "chosen by grace herself" }),
      });
    assert.equal((await redeem()).status, 200);
    const afterReset = await storedUser("grace@example.com");
    assert.ok(afterReset && (await bcrypt.compare("chosen by grace herself", afterReset.passwordHash)));
    assert.equal(afterReset.resetToken, null);
    assert.equal((await redeem()).status, 400, "the setup link works once");
  });

  test("emails a welcome without ever logging the setup link", async () => {
    const created = await addUser({ ...withPassword, password: null });
    // Tests have no email transport, so the send is logged and skipped — and
    // the admin is told so.
    assert.equal(created.body.emailStatus, "skipped");
    const logs = await AppDataSource.getRepository(EmailLog).findBy({
      toAddress: "grace@example.com",
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].purpose, "welcome");
    assert.equal(logs[0].companyId, null);
    assert.equal(logs[0].bodyPreview.includes("/reset/"), false);
    assert.match(logs[0].bodyPreview, /redacted/);
  });

  test("adds the account to a company with the chosen role and records it there", async () => {
    const created = await addUser({ ...withPassword, companyId: company.id, role: "admin" });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.membershipCount, 1);

    const membership = await AppDataSource.getRepository(Membership).findOneBy({
      companyId: company.id,
      userId: created.body.user.id,
    });
    assert.equal(membership?.role, "admin");
    const audit = await AppDataSource.getRepository(AuditEvent).findOneBy({
      companyId: company.id,
      action: "member.add",
    });
    assert.ok(audit);
    assert.equal(audit.targetId, created.body.user.id);
    assert.equal(audit.actorUserId, operator.id);
    assert.equal(JSON.parse(audit.metadataJson ?? "{}").role, "admin");
  });

  test("a company Member is the default role", async () => {
    const created = await addUser({ ...withPassword, companyId: company.id });
    assert.equal(created.status, 201);
    const membership = await AppDataSource.getRepository(Membership).findOneBy({
      companyId: company.id,
      userId: created.body.user.id,
    });
    assert.equal(membership?.role, "member");
  });

  test("never makes anyone a company owner", async () => {
    const refused = await addUser({ ...withPassword, companyId: company.id, role: "owner" });
    assert.equal(refused.status, 400);
    assert.equal(await storedUser("grace@example.com"), null);
  });

  test("refuses an email that already has an account, whatever its case", async () => {
    assert.equal((await addUser(withPassword)).status, 201);
    const again = await addUser({ ...withPassword, email: "GRACE@example.com", name: "Other" });
    assert.equal(again.status, 409);
    assert.match(again.body.error ?? "", /already exists/);
    assert.equal(await AppDataSource.getRepository(User).countBy({ email: "grace@example.com" }), 1);
  });

  test("refuses a company that does not exist and creates nothing", async () => {
    const refused = await addUser({
      ...withPassword,
      companyId: "00000000-0000-4000-8000-000000000000",
    });
    assert.equal(refused.status, 404);
    assert.equal(await storedUser("grace@example.com"), null);
  });

  test("validates the form at the boundary", async () => {
    for (const body of [
      { ...withPassword, password: "too short" },
      { ...withPassword, name: "   " },
      { ...withPassword, email: "not-an-email" },
      { ...withPassword, companyId: "acme" },
      { ...withPassword, isMasterAdmin: true },
      { name: "No password field", email: "x@example.com", companyId: null },
    ]) {
      const refused = await addUser(body);
      assert.equal(refused.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    assert.equal(await AppDataSource.getRepository(User).count(), 1, "only the operator exists");
  });
});
