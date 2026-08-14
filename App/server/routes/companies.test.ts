import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { Invitation } from "../db/entities/Invitation.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { Notebook } from "../db/entities/Notebook.js";
import { User } from "../db/entities/User.js";
import { hashToken } from "../lib/token.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { authRouter } from "./auth.js";
import { companiesRouter } from "./companies.js";
import { emailLogsRouter } from "./emailLogs.js";
import { invitationsRouter } from "./invitations.js";

let server: Server;
let baseUrl: string;
let actingUserId: string | null = null;
let company: Company;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt: Date.now(),
        }
      : null;
    next();
  });
  app.use("/api/auth", authRouter);
  app.use("/api/companies", companiesRouter);
  app.use("/api/invitations", invitationsRouter);
  app.use("/api/companies/:cid/email/logs", emailLogsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
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
  const owner = await insert(User, {
    email: "owner@example.com",
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Acme",
    slug: "acme",
    ownerId: owner.id,
    mission: "Help independent teams make better decisions.",
    vision: "Every team can run a calm, evidence-led company.",
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
});

type ApiResponse<T = Record<string, unknown>> = { status: number; body: T };

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}/api/companies${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function callAbsolute<T = Record<string, unknown>>(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function ownerApiKeyHeaders(): Promise<Record<string, string>> {
  const tokenBody = "A".repeat(43);
  await insert(ApiKey, {
    companyId: company.id,
    userId: company.ownerId,
    name: "Owner automation",
    prefix: tokenBody.slice(0, 8),
    tokenHash: hashApiToken(tokenBody),
    lastUsedAt: new Date(),
    expiresAt: null,
    revokedAt: null,
  });
  actingUserId = null;
  return { authorization: `Bearer gen_${tokenBody}` };
}

describe("company routes", () => {
  test("returns company direction from list and detail routes", async () => {
    const list = await call<Array<{ id: string; mission: string; vision: string }>>("GET", "");
    assert.equal(list.status, 200);
    assert.equal(list.body[0].id, company.id);
    assert.equal(list.body[0].mission, company.mission);
    assert.equal(list.body[0].vision, company.vision);

    const detail = await call<{ mission: string; vision: string }>("GET", `/${company.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.mission, company.mission);
    assert.equal(detail.body.vision, company.vision);
  });

  test("creates a company with trimmed optional direction", async () => {
    const created = await call<{ name: string; mission: string; vision: string }>("POST", "", {
      name: "  New Co  ",
      mission: "  Make planning accessible.  ",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.name, "New Co");
    assert.equal(created.body.mission, "Make planning accessible.");
    assert.equal(created.body.vision, "");
  });

  test("creates a company without direction for backwards compatibility", async () => {
    const created = await call<{ mission: string; vision: string }>("POST", "", {
      name: "Role only",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.mission, "");
    assert.equal(created.body.vision, "");
  });

  test("makes a newly created company visible to the Member's next list refresh", async () => {
    const created = await call<{
      id: string;
      name: string;
      slug: string;
      role: Role;
      requireTwoFactor: boolean;
    }>("POST", "", { name: "Switch Here" });
    assert.equal(created.status, 200);

    const list = await call<
      Array<{
        id: string;
        name: string;
        slug: string;
        role: Role;
        requireTwoFactor: boolean;
      }>
    >("GET", "");
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.find((candidate) => candidate.id === created.body.id),
      created.body,
    );

    const membership = await AppDataSource.getRepository(Membership).findOneByOrFail({
      companyId: created.body.id,
      userId: actingUserId!,
    });
    assert.equal(membership.role, "owner");
    const notebook = await AppDataSource.getRepository(Notebook).findOneByOrFail({
      companyId: created.body.id,
      slug: "general",
    });
    assert.equal(notebook.title, "General");
    assert.equal(notebook.createdById, actingUserId);
  });

  test("returns a unique routable slug for each same-name company", async () => {
    const first = await call<{ id: string; slug: string }>("POST", "", {
      name: "Repeated Name",
    });
    const second = await call<{ id: string; slug: string }>("POST", "", {
      name: "Repeated Name",
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(first.body.slug, "repeated-name");
    assert.equal(second.body.slug, "repeated-name-2");

    const list = await call<Array<{ id: string; slug: string }>>("GET", "");
    assert.equal(list.status, 200);
    assert.equal(
      list.body.find((candidate) => candidate.id === first.body.id)?.slug,
      first.body.slug,
    );
    assert.equal(
      list.body.find((candidate) => candidate.id === second.body.id)?.slug,
      second.body.slug,
    );
  });

  test("rejects unauthenticated creation without writing partial rows", async () => {
    const companyCount = await AppDataSource.getRepository(Company).count();
    const membershipCount = await AppDataSource.getRepository(Membership).count();
    const notebookCount = await AppDataSource.getRepository(Notebook).count();
    actingUserId = null;

    const response = await call("POST", "", { name: "Must Not Exist" });

    assert.equal(response.status, 401);
    assert.equal(await AppDataSource.getRepository(Company).count(), companyCount);
    assert.equal(await AppDataSource.getRepository(Membership).count(), membershipCount);
    assert.equal(await AppDataSource.getRepository(Notebook).count(), notebookCount);
  });

  test("rejects invalid creation input without writing partial rows", async () => {
    const companyCount = await AppDataSource.getRepository(Company).count();
    const membershipCount = await AppDataSource.getRepository(Membership).count();
    const notebookCount = await AppDataSource.getRepository(Notebook).count();

    const response = await call("POST", "", { name: "   " });

    assert.equal(response.status, 400);
    assert.equal(await AppDataSource.getRepository(Company).count(), companyCount);
    assert.equal(await AppDataSource.getRepository(Membership).count(), membershipCount);
    assert.equal(await AppDataSource.getRepository(Notebook).count(), notebookCount);
  });

  test("owner API keys cannot create a company and become an owner Member", async () => {
    const companyCount = await AppDataSource.getRepository(Company).count();
    const membershipCount = await AppDataSource.getRepository(Membership).count();
    const headers = await ownerApiKeyHeaders();

    const response = await call("POST", "", { name: "API-key-owned company" }, headers);

    assert.equal(response.status, 401);
    assert.equal(await AppDataSource.getRepository(Company).count(), companyCount);
    assert.equal(await AppDataSource.getRepository(Membership).count(), membershipCount);
  });

  test("owner API keys cannot invite a Member or receive an invitation token", async () => {
    const headers = await ownerApiKeyHeaders();

    const response = await call(
      "POST",
      `/${company.id}/invitations`,
      { email: "invitee@example.com" },
      headers,
    );

    assert.equal(response.status, 403);
    assert.equal(await AppDataSource.getRepository(Invitation).count(), 0);
    assert.equal("token" in response.body, false);
  });

  test("invitation acceptance links are never exposed through Email Logs", async () => {
    const invited = await call("POST", `/${company.id}/invitations`, {
      email: "invitee@example.com",
    });
    assert.equal(invited.status, 200);
    assert.equal("token" in invited.body, false);

    const stored = await AppDataSource.getRepository(EmailLog).findOneByOrFail({
      companyId: company.id,
      purpose: "invitation",
    });
    assert.doesNotMatch(stored.bodyPreview, /\/invite\//);

    const historicalToken = "historical-raw-invitation-token";
    const historical = await insert(EmailLog, {
      companyId: company.id,
      providerId: null,
      transport: "console",
      purpose: "invitation",
      toAddress: "old-invitee@example.com",
      fromAddress: "noreply@example.com",
      subject: "Old invitation",
      bodyPreview: `Accept the invite: https://example.com/invite/${historicalToken}`,
      status: "sent",
      errorMessage: "",
      messageId: "",
      triggeredByUserId: company.ownerId,
    });
    const detail = await callAbsolute<{ bodyPreview: string }>(
      "GET",
      `/api/companies/${company.id}/email/logs/${historical.id}`,
      undefined,
      {},
    );
    assert.equal(detail.status, 200);
    assert.doesNotMatch(detail.body.bodyPreview, new RegExp(historicalToken));
  });

  test("owner API keys cannot read Email Logs", async () => {
    const rawToken = "raw-invitation-token-in-an-old-log";
    await insert(EmailLog, {
      companyId: company.id,
      providerId: null,
      transport: "console",
      purpose: "invitation",
      toAddress: "invitee@example.com",
      fromAddress: "noreply@example.com",
      subject: "Invitation",
      bodyPreview: `Accept the invite: https://example.com/invite/${rawToken}`,
      status: "sent",
      errorMessage: "",
      messageId: "",
      triggeredByUserId: company.ownerId,
    });
    const headers = await ownerApiKeyHeaders();

    const response = await callAbsolute(
      "GET",
      `/api/companies/${company.id}/email/logs/`,
      undefined,
      headers,
    );

    assert.equal(response.status, 403);
    assert.doesNotMatch(JSON.stringify(response.body), new RegExp(rawToken));
  });

  test("owner API keys cannot promote Members or change their finance authorization", async () => {
    const member = await insert(User, {
      email: "member@example.com",
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, {
      companyId: company.id,
      userId: member.id,
      role: "member" as Role,
      financeAccess: "read",
    });
    const headers = await ownerApiKeyHeaders();

    const roleResponse = await call(
      "PATCH",
      `/${company.id}/members/${member.id}`,
      { role: "admin" },
      headers,
    );
    const financeResponse = await call(
      "PATCH",
      `/${company.id}/members/${member.id}/finance-access`,
      { financeAccess: "full" },
      headers,
    );

    assert.equal(roleResponse.status, 403);
    assert.equal(financeResponse.status, 403);
    const stored = await AppDataSource.getRepository(Membership).findOneByOrFail({
      companyId: company.id,
      userId: member.id,
    });
    assert.equal(stored.role, "member");
    assert.equal(stored.financeAccess, "read");
  });

  test("owner API keys cannot remove a Member", async () => {
    const member = await insert(User, {
      email: "member@example.com",
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, {
      companyId: company.id,
      userId: member.id,
      role: "member" as Role,
    });
    const headers = await ownerApiKeyHeaders();

    const response = await call(
      "DELETE",
      `/${company.id}/members/${member.id}`,
      undefined,
      headers,
    );

    assert.equal(response.status, 403);
    assert.ok(
      await AppDataSource.getRepository(Membership).findOneBy({
        companyId: company.id,
        userId: member.id,
      }),
    );
  });

  test("owner API keys cannot delete the company", async () => {
    const headers = await ownerApiKeyHeaders();

    const response = await call("DELETE", `/${company.id}`, undefined, headers);

    assert.equal(response.status, 403);
    assert.ok(await AppDataSource.getRepository(Company).findOneBy({ id: company.id }));
  });

  test("API keys cannot accept invitations into another company", async () => {
    const otherOwner = await insert(User, {
      email: "other-owner@example.com",
      name: "Other owner",
      passwordHash: "x",
      sessionVersion: 0,
    });
    const otherCompany = await insert(Company, {
      name: "Other company",
      slug: "other-company",
      ownerId: otherOwner.id,
      mission: "",
      vision: "",
    });
    const rawToken = "invitation-token";
    const invitation = await insert(Invitation, {
      companyId: otherCompany.id,
      email: "owner@example.com",
      token: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
    });
    const headers = await ownerApiKeyHeaders();

    const response = await callAbsolute(
      "POST",
      "/api/invitations/accept",
      { token: rawToken },
      headers,
    );

    assert.equal(response.status, 401);
    assert.equal(
      await AppDataSource.getRepository(Membership).countBy({
        companyId: otherCompany.id,
        userId: company.ownerId,
      }),
      0,
    );
    assert.equal(
      (await AppDataSource.getRepository(Invitation).findOneByOrFail({ id: invitation.id }))
        .acceptedAt,
      null,
    );
  });

  test("API keys cannot mutate account identity or turn a password change into a session", async () => {
    const headers = await ownerApiKeyHeaders();

    const emailResponse = await callAbsolute(
      "PATCH",
      "/api/auth/me",
      { email: "attacker@example.com" },
      headers,
    );
    const passwordResponse = await callAbsolute(
      "POST",
      "/api/auth/password",
      { currentPassword: "irrelevant", newPassword: "a-new-long-password" },
      headers,
    );

    assert.equal(emailResponse.status, 401);
    assert.equal(passwordResponse.status, 401);
    assert.equal(
      (await AppDataSource.getRepository(User).findOneByOrFail({ id: company.ownerId })).email,
      "owner@example.com",
    );
  });

  test("ordinary scoped API-key access remains available", async () => {
    const headers = await ownerApiKeyHeaders();

    const detail = await call<{ id: string }>("GET", `/${company.id}`, undefined, headers);
    const updated = await call<{ mission: string }>(
      "PATCH",
      `/${company.id}`,
      { mission: "Updated by ordinary automation." },
      headers,
    );

    assert.equal(detail.status, 200);
    assert.equal(detail.body.id, company.id);
    assert.equal(updated.status, 200);
    assert.equal(updated.body.mission, "Updated by ordinary automation.");
  });

  test("API keys cannot weaken the company two-factor policy", async () => {
    company.requireTwoFactor = true;
    await AppDataSource.getRepository(Company).save(company);
    const headers = await ownerApiKeyHeaders();

    const response = await call("PATCH", `/${company.id}`, { requireTwoFactor: false }, headers);

    assert.equal(response.status, 403);
    assert.equal(
      (await AppDataSource.getRepository(Company).findOneByOrFail({ id: company.id }))
        .requireTwoFactor,
      true,
    );
  });

  test("updates either field independently and trims its value", async () => {
    const updated = await call<{ mission: string; vision: string }>("PATCH", `/${company.id}`, {
      mission: "  Focus the week's highest-impact work.  ",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.mission, "Focus the week's highest-impact work.");
    assert.equal(updated.body.vision, company.vision);
  });

  test("rejects oversized context without changing stored values", async () => {
    const response = await call("PATCH", `/${company.id}`, { vision: "x".repeat(2_001) });
    assert.equal(response.status, 400);
    const stored = await AppDataSource.getRepository(Company).findOneByOrFail({ id: company.id });
    assert.equal(stored.vision, company.vision);
  });
});
