import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import cookieSession from "cookie-session";
import express from "express";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AppSetting } from "../db/entities/AppSetting.js";
import { Company } from "../db/entities/Company.js";
import { Invitation } from "../db/entities/Invitation.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { hashToken } from "../lib/token.js";
import { errorHandler } from "../middleware/error.js";
import { resetGlobalSmtpCacheForTests } from "../services/globalEmailTransport.js";
import { initializePublicUrl } from "../services/publicUrlSetup.js";
import { areSignupsDisabled, setSignupsDisabled } from "../services/signupSettings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { authRouter } from "./auth.js";
import { invitationsRouter } from "./invitations.js";

const security = config.security as unknown as {
  multiTenant: boolean;
  bootstrapMasterAdminEmail: string;
};
const original = {
  multiTenant: security.multiTenant,
  bootstrapMasterAdminEmail: security.bootstrapMasterAdminEmail,
};
let server: Server;
let baseUrl: string;
let emailOutput: string[] = [];
const originalLog = console.log;

before(async () => {
  await initTestDb();
  console.log = (...args: unknown[]) => emailOutput.push(args.map(String).join(" "));
  const app = express();
  app.use(express.json());
  app.use(
    cookieSession({ name: "session", keys: ["local-signup-test-signing-key"], secure: false }),
  );
  app.use("/api/auth", authRouter);
  app.use("/api/invitations", invitationsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetTestDb();
  resetGlobalSmtpCacheForTests();
  security.multiTenant = true;
  security.bootstrapMasterAdminEmail = "";
  emailOutput = [];
  await initializePublicUrl("https://genosyn.example.test");
  await setSignupsDisabled(true);
});

after(async () => {
  console.log = originalLog;
  Object.assign(security, original);
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

async function call(path: string, body?: unknown, cookie?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cookie: response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; "),
  };
}

async function createInvitation(overrides: Partial<Invitation> = {}) {
  const company = await insert(Company, {
    name: "Inviting company",
    slug: `company-${randomUUID()}`,
    ownerId: randomUUID(),
  });
  const token = randomUUID();
  const invitation = await insert(Invitation, {
    companyId: company.id,
    email: "invitee@example.test",
    token: hashToken(token),
    expiresAt: new Date(Date.now() + 60 * 60_000),
    acceptedAt: null,
    ...overrides,
  });
  return { company, invitation, token };
}

function signupBody(invitationToken?: string, email = "invitee@example.test") {
  return {
    email,
    name: "Invited Member",
    password: "a long local test password",
    ...(invitationToken ? { invitationToken } : {}),
  };
}

function verificationLink(): URL {
  const match = emailOutput
    .join("\n")
    .match(/https:\/\/genosyn\.example\.test\/verify-email\/[^\s]+/);
  assert.ok(match, "the console transport should receive a verification link");
  return new URL(match[0]);
}

test("closed signup preserves invitation until email proof and explicit acceptance", async () => {
  const { token, invitation, company } = await createInvitation();
  assert.deepEqual((await call("/api/auth/signup-status")).body, {
    open: false,
    setupRequired: false,
  });
  const signup = await call("/api/auth/signup", signupBody(token, " Invitee@Example.test "));
  assert.equal(signup.status, 200);
  assert.equal(signup.body.emailVerificationRequired, true);
  assert.ok(signup.cookie);
  const user = await AppDataSource.getRepository(User).findOneByOrFail({
    id: String(signup.body.id),
  });
  assert.equal(user.email, invitation.email);
  assert.equal(user.emailVerifiedAt, null);
  assert.equal(user.isMasterAdmin, false);
  assert.equal(await AppDataSource.getRepository(Membership).count(), 0);
  assert.equal(
    (await AppDataSource.getRepository(Invitation).findOneByOrFail({ id: invitation.id }))
      .acceptedAt,
    null,
  );
  assert.equal(await areSignupsDisabled(), true);
  assert.equal((await call("/api/invitations/accept", { token }, signup.cookie)).status, 403);

  const link = verificationLink();
  assert.equal(link.origin, "https://genosyn.example.test");
  assert.equal(link.searchParams.get("invitation"), token);
  assert.equal(
    (
      await call(
        "/api/auth/verify-email",
        { token: link.pathname.split("/").at(-1) },
        signup.cookie,
      )
    ).status,
    200,
  );
  assert.equal(await AppDataSource.getRepository(Membership).count(), 0);
  const accepted = await call("/api/invitations/accept", { token }, signup.cookie);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.companyId, company.id);
  const membership = await AppDataSource.getRepository(Membership).findOneByOrFail({
    userId: user.id,
    companyId: company.id,
  });
  assert.equal(membership.role, "member");
  assert.ok(
    (await AppDataSource.getRepository(Invitation).findOneByOrFail({ id: invitation.id }))
      .acceptedAt,
  );
  assert.equal((await call("/api/invitations/accept", { token }, signup.cookie)).status, 400);
});

test("closed enrollment refuses missing, mismatched, expired and already accepted invitations", async () => {
  const { token } = await createInvitation();
  assert.equal((await call("/api/auth/signup", signupBody())).status, 403);
  assert.equal(
    (await call("/api/auth/signup", signupBody(token, "another@example.test"))).status,
    400,
  );
  const expired = await createInvitation({ expiresAt: new Date(Date.now() - 60_000) });
  assert.equal((await call("/api/auth/signup", signupBody(expired.token))).status, 400);
  const used = await createInvitation({ acceptedAt: new Date() });
  assert.equal((await call("/api/auth/signup", signupBody(used.token))).status, 400);
  assert.equal(await AppDataSource.getRepository(User).count(), 0);
  assert.equal(await AppDataSource.getRepository(Membership).count(), 0);
  assert.equal(await areSignupsDisabled(), true);
});

test("deleted companies cannot enroll an invitee", async () => {
  const { token, company } = await createInvitation();
  await AppDataSource.getRepository(Company).delete(company.id);
  assert.equal((await call("/api/auth/signup", signupBody(token))).status, 400);
  assert.equal(await AppDataSource.getRepository(User).count(), 0);
});

test("resending verification keeps a live invitation and reports console fallback", async () => {
  const { token, invitation } = await createInvitation();
  const signup = await call("/api/auth/signup", signupBody(token));
  assert.equal(signup.status, 200);
  emailOutput = [];
  const resend = await call(
    "/api/auth/resend-verification",
    { invitationToken: token },
    signup.cookie,
  );
  assert.equal(resend.status, 200);
  assert.equal(resend.body.delivery, "skipped");
  assert.equal(verificationLink().searchParams.get("invitation"), token);
  assert.equal(
    (await AppDataSource.getRepository(Invitation).findOneByOrFail({ id: invitation.id }))
      .acceptedAt,
    null,
  );
});

test("fresh shared SaaS requires operator URL setup before even bootstrap signup", async () => {
  await AppDataSource.getRepository(AppSetting).delete({ key: "instance.publicUrl" });
  security.bootstrapMasterAdminEmail = "operator@example.test";
  assert.deepEqual((await call("/api/auth/signup-status")).body, {
    open: false,
    setupRequired: true,
  });
  const result = await call(
    "/api/auth/signup",
    signupBody(undefined, security.bootstrapMasterAdminEmail),
  );
  assert.equal(result.status, 503);
  assert.equal(await AppDataSource.getRepository(User).count(), 0);
  assert.equal(
    await AppDataSource.getRepository(AppSetting).existsBy({ key: "instance.publicUrl" }),
    false,
  );
  await initializePublicUrl("https://genosyn.example.test");
  const signup = await call(
    "/api/auth/signup",
    signupBody(undefined, security.bootstrapMasterAdminEmail),
  );
  assert.equal(signup.status, 200);
  const user = await AppDataSource.getRepository(User).findOneByOrFail({
    id: String(signup.body.id),
  });
  assert.equal(user.isMasterAdmin, false);
  assert.equal(user.emailVerifiedAt, null);
  const link = verificationLink();
  assert.equal(
    (
      await call(
        "/api/auth/verify-email",
        { token: link.pathname.split("/").at(-1) },
        signup.cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (await AppDataSource.getRepository(User).findOneByOrFail({ id: user.id })).isMasterAdmin,
    true,
  );
  // Promotion still retires the unverified browser session.
  assert.equal((await call("/api/auth/me", undefined, signup.cookie)).status, 401);
});
