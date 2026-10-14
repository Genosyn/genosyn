import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { EmailLog } from "../db/entities/EmailLog.js";
import { Goal } from "../db/entities/Goal.js";
import { Invitation } from "../db/entities/Invitation.js";
import { Membership, type FinanceAccess, type Role } from "../db/entities/Membership.js";
import { Notebook } from "../db/entities/Notebook.js";
import { Routine } from "../db/entities/Routine.js";
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
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? {
          userId: actingUserId,
          sessionVersion: 0,
          authenticatedAt: Date.now(),
        }
      : null;
    await persistTestSession(req);
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

  test("tells the client what this Member may do in Finance", async () => {
    // Surfaces outside Finance — the inbox's invoice and estimate buttons —
    // decide what to offer from this, so it has to be the same verdict the
    // finance routes gate on rather than a second opinion.
    const owner = await call<Array<{ id: string; financeAccess: FinanceAccess }>>("GET", "");
    assert.equal(owner.status, 200);
    assert.equal(owner.body[0].financeAccess, "full");

    // An owner dialled down in the column is still full: the exemption is the
    // rule, and reporting "read" here would hide buttons that in fact work.
    const membershipRepo = AppDataSource.getRepository(Membership);
    const ownerMembership = await membershipRepo.findOneByOrFail({
      companyId: company.id,
      userId: actingUserId!,
    });
    ownerMembership.financeAccess = "read";
    await membershipRepo.save(ownerMembership);
    const stillFull = await call<Array<{ financeAccess: FinanceAccess }>>("GET", "");
    assert.equal(stillFull.body[0].financeAccess, "full");

    // An ordinary Member reports whatever the column says.
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
    actingUserId = member.id;
    const restricted = await call<Array<{ financeAccess: FinanceAccess }>>("GET", "");
    assert.equal(restricted.status, 200);
    assert.equal(restricted.body[0].financeAccess, "read");
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

  describe("a first Goal written with the company", () => {
    const goal = {
      title: "  Reach 50 paying customers by March  ",
      targetValue: 50,
      direction: "increase_to",
      unit: " customers ",
    };

    test("creates one top-level manual Goal for the Member and counts it as direction", async () => {
      const created = await call<{ id: string; hasGoal: boolean; mission: string }>("POST", "", {
        name: "Goal First",
        goal,
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.hasGoal, true);
      assert.equal(created.body.mission, "");

      const rows = await AppDataSource.getRepository(Goal).find({
        where: { companyId: created.body.id },
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].title, "Reach 50 paying customers by March");
      assert.equal(rows[0].targetValue, 50);
      assert.equal(rows[0].direction, "increase_to");
      assert.equal(rows[0].unit, "customers");
      assert.equal(rows[0].metricKind, "manual");
      assert.equal(rows[0].status, "active");
      assert.equal(rows[0].parentGoalId, null);
      assert.equal(rows[0].createdById, actingUserId);

      const audit = await AppDataSource.getRepository(AuditEvent).findOneByOrFail({
        companyId: created.body.id,
        action: "goal.create",
      });
      assert.equal(audit.targetId, rows[0].id);

      // With no mission or vision, the Goal alone is what lets setup move on.
      const status = await call<{ nextStep: string }>(
        "GET",
        `/${created.body.id}/onboarding-status`,
      );
      assert.equal(status.body.nextStep, "employee");
    });

    test("reports the Goal on the list, detail and patch responses", async () => {
      const created = await call<{ id: string }>("POST", "", { name: "Goal First", goal });
      const bare = await call<{ id: string }>("POST", "", { name: "Goal Later" });

      const list = await call<Array<{ id: string; hasGoal: boolean }>>("GET", "");
      assert.equal(list.body.find((c) => c.id === created.body.id)?.hasGoal, true);
      assert.equal(list.body.find((c) => c.id === bare.body.id)?.hasGoal, false);
      assert.equal(list.body.find((c) => c.id === company.id)?.hasGoal, false);

      const detail = await call<{ hasGoal: boolean }>("GET", `/${created.body.id}`);
      assert.equal(detail.body.hasGoal, true);
      const patched = await call<{ hasGoal: boolean }>("PATCH", `/${created.body.id}`, {
        name: "Goal First, renamed",
      });
      assert.equal(patched.body.hasGoal, true);
      const bareDetail = await call<{ hasGoal: boolean }>("GET", `/${bare.body.id}`);
      assert.equal(bareDetail.body.hasGoal, false);
    });

    test("a Goal that is later archived stops counting as direction", async () => {
      const created = await call<{ id: string }>("POST", "", { name: "Goal First", goal });
      await AppDataSource.getRepository(Goal).update(
        { companyId: created.body.id },
        { status: "archived" },
      );

      const detail = await call<{ hasGoal: boolean }>("GET", `/${created.body.id}`);
      assert.equal(detail.body.hasGoal, false);
      const status = await call<{ nextStep: string }>(
        "GET",
        `/${created.body.id}/onboarding-status`,
      );
      assert.equal(status.body.nextStep, "company");
    });

    test("keeps a mission and vision written beside it, and defaults the direction", async () => {
      const created = await call<{ id: string; mission: string; vision: string }>("POST", "", {
        name: "Both",
        mission: "  Help shops thrive.  ",
        vision: "Every shop is independent.",
        goal: { title: "Hit $2M in monthly revenue", targetValue: 2_000_000 },
      });
      assert.equal(created.status, 200);
      assert.equal(created.body.mission, "Help shops thrive.");
      assert.equal(created.body.vision, "Every shop is independent.");
      const row = await AppDataSource.getRepository(Goal).findOneByOrFail({
        companyId: created.body.id,
      });
      assert.equal(row.direction, "increase_to");
      assert.equal(row.unit, "");
      assert.equal(row.targetValue, 2_000_000);
    });

    test("a decreasing Goal keeps its direction and unit", async () => {
      const created = await call<{ id: string }>("POST", "", {
        name: "Calm",
        goal: { title: "Cut churn to 2%", targetValue: 2, direction: "decrease_to", unit: "%" },
      });
      const row = await AppDataSource.getRepository(Goal).findOneByOrFail({
        companyId: created.body.id,
      });
      assert.equal(row.direction, "decrease_to");
      assert.equal(row.unit, "%");
    });

    test("rejects an invalid Goal without writing a company", async () => {
      const companyCount = await AppDataSource.getRepository(Company).count();
      const bad: Array<Record<string, unknown>> = [
        { ...goal, title: "   " },
        { ...goal, title: "x".repeat(141) },
        { ...goal, targetValue: "50" },
        { ...goal, targetValue: null },
        { title: goal.title },
        { ...goal, direction: "sideways" },
        { ...goal, unit: "u".repeat(21) },
      ];
      for (const candidate of bad) {
        const response = await call("POST", "", { name: "Never Made", goal: candidate });
        assert.equal(response.status, 400, JSON.stringify(candidate));
      }
      assert.equal(await AppDataSource.getRepository(Company).count(), companyCount);
      assert.equal(await AppDataSource.getRepository(Goal).count(), 0);
    });

    test("takes the half-made company away when its Goal cannot be written", async () => {
      const companies = await AppDataSource.getRepository(Company).count();
      const memberships = await AppDataSource.getRepository(Membership).count();
      await AppDataSource.query(`
        CREATE TRIGGER fail_company_goal
        BEFORE INSERT ON goals
        BEGIN
          SELECT RAISE(FAIL, 'goal failure');
        END
      `);
      try {
        const response = await call("POST", "", { name: "Half Made", goal });

        assert.equal(response.status, 500);
        assert.equal(await AppDataSource.getRepository(Company).count(), companies);
        assert.equal(await AppDataSource.getRepository(Membership).count(), memberships);
        assert.equal(await AppDataSource.getRepository(Notebook).countBy({ title: "General" }), 0);
      } finally {
        await AppDataSource.query("DROP TRIGGER fail_company_goal");
      }
    });
  });

  test("saves both company direction fields before the guide offers hiring", async () => {
    const created = await call<{ id: string; mission: string; vision: string }>("POST", "", {
      name: "Clear Direction",
      mission: "  Make everyday research accessible.  ",
      vision: "  Every team makes well-informed decisions.  ",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.mission, "Make everyday research accessible.");
    assert.equal(created.body.vision, "Every team makes well-informed decisions.");

    const status = await call<{ complete: boolean; employee: null; nextStep: string }>(
      "GET",
      `/${created.body.id}/onboarding-status`,
    );
    assert.equal(status.status, 200);
    assert.equal(status.body.complete, false);
    assert.equal(status.body.employee, null);
    assert.equal(status.body.nextStep, "employee");
  });

  test("a company created with a name only must set direction before hiring", async () => {
    const created = await call<{ id: string }>("POST", "", { name: "Direction Later" });
    const missing = await call<{ nextStep: string }>(
      "GET",
      `/${created.body.id}/onboarding-status`,
    );
    assert.equal(missing.status, 200);
    assert.equal(missing.body.nextStep, "company");

    const partial = await call("PATCH", `/${created.body.id}`, { mission: "A useful mission" });
    assert.equal(partial.status, 200);
    assert.equal(
      (await call<{ nextStep: string }>("GET", `/${created.body.id}/onboarding-status`)).body
        .nextStep,
      "company",
    );

    const complete = await call("PATCH", `/${created.body.id}`, { vision: "A useful future" });
    assert.equal(complete.status, 200);
    assert.equal(
      (await call<{ nextStep: string }>("GET", `/${created.body.id}/onboarding-status`)).body
        .nextStep,
      "employee",
    );
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

describe("company time zone", () => {
  const storedZone = async () =>
    (await AppDataSource.getRepository(Company).findOneByOrFail({ id: company.id })).timezone;

  test("every company starts on server time and says so on every route", async () => {
    // An existing company has the empty string, so its Routines keep firing on
    // the server's clock until somebody picks a zone.
    assert.equal(company.timezone, "");
    const list = await call<Array<{ timezone: string }>>("GET", "");
    assert.equal(list.body[0].timezone, "");
    const detail = await call<{ timezone: string }>("GET", `/${company.id}`);
    assert.equal(detail.body.timezone, "");
    const created = await call<{ timezone: string }>("POST", "", { name: "No zone given" });
    assert.equal(created.status, 200);
    assert.equal(created.body.timezone, "");
  });

  test("a company can be created in a time zone, trimmed", async () => {
    const created = await call<{ id: string; timezone: string }>("POST", "", {
      name: "Berlin office",
      timezone: "  Europe/Berlin ",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.timezone, "Europe/Berlin");

    const list = await call<Array<{ id: string; timezone: string }>>("GET", "");
    assert.equal(list.body.find((entry) => entry.id === created.body.id)?.timezone, "Europe/Berlin");
    const detail = await call<{ timezone: string }>("GET", `/${created.body.id}`);
    assert.equal(detail.body.timezone, "Europe/Berlin");
    // The empty string is the explicit spelling of server time.
    const server = await call<{ timezone: string }>("POST", "", { name: "Server", timezone: "" });
    assert.equal(server.body.timezone, "");
  });

  test("starts a company on server time when its browser's zone is not one this server knows", async () => {
    // The zone sent at creation is the creator's browser's, which can name a
    // zone this runtime lacks. That must never stop a company being created.
    for (const timezone of ["Mars/Base", "+01:00", "local"]) {
      const response = await call<{ id: string; timezone: string }>("POST", "", {
        name: "Nowhere",
        timezone,
      });
      assert.equal(response.status, 200, JSON.stringify(timezone));
      assert.equal(response.body.timezone, "", JSON.stringify(timezone));
    }
  });

  test("refuses a malformed zone at creation without writing partial rows", async () => {
    const companyCount = await AppDataSource.getRepository(Company).count();
    const membershipCount = await AppDataSource.getRepository(Membership).count();
    for (const timezone of ["x".repeat(100), 7]) {
      const response = await call("POST", "", { name: "Nowhere", timezone });
      assert.equal(response.status, 400, JSON.stringify(timezone));
    }
    assert.equal(await AppDataSource.getRepository(Company).count(), companyCount);
    assert.equal(await AppDataSource.getRepository(Membership).count(), membershipCount);
  });

  test("an owner sets, changes and clears the zone without sending anything else", async () => {
    const set = await call<{ timezone: string; name: string }>("PATCH", `/${company.id}`, {
      timezone: "Asia/Tokyo",
    });
    assert.equal(set.status, 200);
    assert.equal(set.body.timezone, "Asia/Tokyo");
    assert.equal(set.body.name, company.name);
    assert.equal(await storedZone(), "Asia/Tokyo");

    const changed = await call<{ timezone: string }>("PATCH", `/${company.id}`, {
      timezone: " America/New_York ",
    });
    assert.equal(changed.body.timezone, "America/New_York");

    // Back to server time.
    const cleared = await call<{ timezone: string }>("PATCH", `/${company.id}`, { timezone: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.timezone, "");
    assert.equal(await storedZone(), "");

    // It rides along with the other profile fields too.
    const both = await call<{ timezone: string; mission: string }>("PATCH", `/${company.id}`, {
      mission: "Serve Europe.",
      timezone: "Europe/Berlin",
    });
    assert.equal(both.body.mission, "Serve Europe.");
    assert.equal(both.body.timezone, "Europe/Berlin");
  });

  test("refuses an unknown or malformed zone and keeps the one it had", async () => {
    await call("PATCH", `/${company.id}`, { timezone: "Europe/Berlin" });
    for (const timezone of [
      "Mars/Base",
      "Europe/Atlantis",
      "+01:00",
      "UTC+3",
      "local",
      "../etc/passwd",
      "x".repeat(65),
      null,
      42,
    ]) {
      const response = await call<{ error: string }>("PATCH", `/${company.id}`, { timezone });
      assert.equal(response.status, 400, JSON.stringify(timezone));
      assert.equal(await storedZone(), "Europe/Berlin", JSON.stringify(timezone));
    }
    // The message tells the person what a good answer looks like.
    const refused = await call<{ issues: Array<{ message: string }> }>("PATCH", `/${company.id}`, {
      timezone: "Mars/Base",
    });
    assert.match(refused.body.issues[0].message, /IANA name such as Europe\/Berlin/);
    // An empty body is still not a change.
    assert.equal((await call("PATCH", `/${company.id}`, {})).status, 400);
  });

  test("only an owner or admin can change it", async () => {
    const member = await insert(User, {
      email: "member@example.com",
      name: "Member",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role });
    actingUserId = member.id;
    const refused = await call("PATCH", `/${company.id}`, { timezone: "Asia/Tokyo" });
    assert.equal(refused.status, 403);
    assert.equal(await storedZone(), "");
    // Everyone in the company can still read it.
    const detail = await call<{ timezone: string }>("GET", `/${company.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.timezone, "");

    const admin = await insert(User, {
      email: "admin@example.com",
      name: "Admin",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" as Role });
    actingUserId = admin.id;
    const allowed = await call<{ timezone: string }>("PATCH", `/${company.id}`, {
      timezone: "Asia/Tokyo",
    });
    assert.equal(allowed.status, 200);
    assert.equal(await storedZone(), "Asia/Tokyo");
  });

  test("moves the company's enabled Routines to the new clock, and back", async () => {
    const wallClock = (zone: string | undefined, moment: Date | null) =>
      new Intl.DateTimeFormat("en-US", {
        ...(zone ? { timeZone: zone } : {}),
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(moment ?? new Date(NaN));
    const previous = process.env.TZ;
    // A server clock that is neither UTC nor the zones below.
    process.env.TZ = "Pacific/Auckland";
    try {
      const employee = await insert(AIEmployee, {
        companyId: company.id,
        name: "Ana",
        slug: "ana",
        role: "Operations",
      });
      const routines = AppDataSource.getRepository(Routine);
      const scheduled = await insert(Routine, {
        employeeId: employee.id,
        name: "Morning round",
        slug: "morning-round",
        cronExpr: "0 9 * * *",
        body: "Make the round.",
        nextRunAt: new Date(Date.now() + 3_600_000),
      });
      const paused = await insert(Routine, {
        employeeId: employee.id,
        name: "Paused round",
        slug: "paused-round",
        cronExpr: "0 9 * * *",
        body: "Make the round.",
        enabled: false,
        nextRunAt: null,
      });
      const reload = (id: string) => routines.findOneByOrFail({ id });

      const tokyo = await call("PATCH", `/${company.id}`, { timezone: "Asia/Tokyo" });
      assert.equal(tokyo.status, 200);
      const inTokyo = await reload(scheduled.id);
      assert.equal(wallClock("Asia/Tokyo", inTokyo.nextRunAt), "09:00");
      assert.ok((inTokyo.nextRunAt as Date).getTime() > Date.now());
      assert.equal((await reload(paused.id)).nextRunAt, null);

      // Saying the same thing again moves nothing: a Routine already waiting
      // on the right clock keeps its slot.
      await routines.update({ id: scheduled.id }, { nextRunAt: new Date(Date.now() + 7_200_000) });
      const sentinel = (await reload(scheduled.id)).nextRunAt as Date;
      await call("PATCH", `/${company.id}`, { timezone: "Asia/Tokyo", mission: "Same zone." });
      assert.equal((await reload(scheduled.id)).nextRunAt?.getTime(), sentinel.getTime());

      // "Server time" reads the machine's clock again.
      const back = await call("PATCH", `/${company.id}`, { timezone: "" });
      assert.equal(back.status, 200);
      const onServer = await reload(scheduled.id);
      assert.equal(wallClock("Pacific/Auckland", onServer.nextRunAt), "09:00");
      assert.notEqual(wallClock("Asia/Tokyo", onServer.nextRunAt), "09:00");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
