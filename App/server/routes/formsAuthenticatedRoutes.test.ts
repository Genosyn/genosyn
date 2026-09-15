import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseForm } from "../db/entities/BaseForm.js";
import { BaseFormSubmission } from "../db/entities/BaseFormSubmission.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Company } from "../db/entities/Company.js";
import { Membership, type Role } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  AI_BROWSER_REQUEST_HEADER,
  AI_BROWSER_REQUEST_VALUE,
} from "../services/browserRequestBoundary.js";
import { hashApiToken } from "../middleware/auth.js";
import { hashBaseFormToken } from "../services/baseForms.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { formsRouter } from "./forms.js";

type Question = {
  id: string;
  fieldId: string;
  label: string;
  description: string;
  required: boolean;
};

type FormSummary = {
  id: string;
  tableId: string;
  slug: string;
  title: string;
  description: string;
  submitLabel: string;
  successTitle: string;
  successMessage: string;
  allowAnotherResponse: boolean;
  publishedAt: string | null;
  acceptingResponses: boolean;
  publicUrl: string | null;
  publicUrlConfigured: boolean;
  responseCount: number;
  lastResponseAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type FormDetail = {
  form: FormSummary & { questions: Question[] };
  fields: Array<{ id: string; name: string; type: string }>;
};

type ApiResponse<T = Record<string, unknown>> = {
  status: number;
  body: T;
  headers: Headers;
};

type RequestOptions = {
  body?: unknown;
  headers?: Record<string, string>;
};

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let actingSessionVersion = 0;

let owner: User;
let admin: User;
let member: User;
let outsider: User;
let company: Company;
let otherCompany: Company;
let base: Base;
let siblingBase: Base;
let otherCompanyBase: Base;
let table: BaseTable;
let siblingTable: BaseTable;
let otherCompanyTable: BaseTable;
let nameField: BaseField;
let emailField: BaseField;
let internalField: BaseField;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: actingSessionVersion }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", formsRouter);
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

async function createUser(label: string): Promise<User> {
  return insert(User, {
    email: `${label}-${randomUUID()}@example.com`,
    name: label,
    passwordHash: "x",
    sessionVersion: 0,
  });
}

async function createTable(targetBase: Base, name: string, slug: string): Promise<BaseTable> {
  return insert(BaseTable, {
    baseId: targetBase.id,
    name,
    slug,
    sortOrder: 1_000,
    archivedAt: null,
  });
}

beforeEach(async () => {
  await resetTestDb();
  actingSessionVersion = 0;
  owner = await createUser("Owner");
  admin = await createUser("Admin");
  member = await createUser("Member");
  outsider = await createUser("Outsider");
  actingUserId = owner.id;

  company = await insert(Company, {
    name: "Northstar",
    slug: `northstar-${randomUUID()}`,
    ownerId: owner.id,
  });
  otherCompany = await insert(Company, {
    name: "Elsewhere",
    slug: `elsewhere-${randomUUID()}`,
    ownerId: outsider.id,
  });
  await Promise.all([
    insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" as Role }),
    insert(Membership, { companyId: company.id, userId: admin.id, role: "admin" as Role }),
    insert(Membership, { companyId: company.id, userId: member.id, role: "member" as Role }),
    insert(Membership, {
      companyId: otherCompany.id,
      userId: outsider.id,
      role: "owner" as Role,
    }),
  ]);

  base = await insert(Base, {
    companyId: company.id,
    name: "Research",
    slug: "research",
    color: "violet",
    createdById: owner.id,
  });
  siblingBase = await insert(Base, {
    companyId: company.id,
    name: "Operations",
    slug: "operations",
    color: "slate",
    createdById: owner.id,
  });
  otherCompanyBase = await insert(Base, {
    companyId: otherCompany.id,
    name: "Research",
    slug: "research",
    color: "amber",
    createdById: outsider.id,
  });
  table = await createTable(base, "Interviews", "interviews");
  siblingTable = await createTable(siblingBase, "Vendors", "vendors");
  otherCompanyTable = await createTable(otherCompanyBase, "Interviews", "interviews");

  nameField = await insert(BaseField, {
    tableId: table.id,
    name: "Name",
    type: "text",
    configJson: "{}",
    isPrimary: true,
    sortOrder: 1_000,
  });
  emailField = await insert(BaseField, {
    tableId: table.id,
    name: "Email",
    type: "email",
    configJson: "{}",
    isPrimary: false,
    sortOrder: 2_000,
  });
  internalField = await insert(BaseField, {
    tableId: table.id,
    name: "Member",
    type: "member",
    configJson: "{}",
    isPrimary: false,
    sortOrder: 3_000,
  });
});

async function apiCall<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: RequestOptions = {},
): Promise<ApiResponse<T>> {
  const headers = { ...options.headers };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

function collectionPath(targetCompany = company, targetBase = base, targetTable = table): string {
  return `/api/companies/${targetCompany.id}/bases/${targetBase.slug}/tables/${targetTable.id}/forms`;
}

function detailPath(
  formSlug: string,
  targetCompany = company,
  targetBase = base,
  targetTable = table,
): string {
  return `${collectionPath(targetCompany, targetBase, targetTable)}/${formSlug}`;
}

function question(field: BaseField = nameField, overrides: Partial<Question> = {}): Question {
  return {
    id: randomUUID(),
    fieldId: field.id,
    label: field.name,
    description: "",
    required: false,
    ...overrides,
  };
}

async function createForm(
  title = "Customer interview",
  path = collectionPath(),
): Promise<FormDetail> {
  const response = await apiCall<FormDetail>("POST", path, { body: { title } });
  assert.equal(response.status, 201);
  return response.body;
}

function publicToken(detail: FormDetail): string {
  assert.ok(detail.form.publicUrl);
  return new URL(detail.form.publicUrl).pathname.split("/").pop()!;
}

async function issueApiKey(
  args: {
    companyId?: string;
    userId?: string;
    revokedAt?: Date | null;
    expiresAt?: Date | null;
  } = {},
): Promise<{ row: ApiKey; token: string }> {
  const suffix = randomBytes(32).toString("base64url");
  const row = await insert(ApiKey, {
    companyId: args.companyId ?? company.id,
    userId: args.userId ?? owner.id,
    name: "Forms tests",
    prefix: suffix.slice(0, 8),
    tokenHash: hashApiToken(suffix),
    lastUsedAt: null,
    expiresAt: args.expiresAt ?? null,
    revokedAt: args.revokedAt ?? null,
  });
  return { row, token: `gen_${suffix}` };
}

describe("authenticated Base Form route authority", () => {
  test("requires a valid login for every member Form operation without disclosing scope", async () => {
    const created = await createForm();
    actingUserId = null;
    const operations: Array<[string, string, unknown?]> = [
      ["GET", collectionPath()],
      ["POST", collectionPath(), { title: "Unauthorized" }],
      ["GET", detailPath(created.form.slug)],
      ["PATCH", detailPath(created.form.slug), { title: "Unauthorized" }],
      ["POST", `${detailPath(created.form.slug)}/rotate-link`, {}],
      ["DELETE", detailPath(created.form.slug)],
    ];

    for (const [method, path, body] of operations) {
      const response = await apiCall<{ error: string }>(method, path, { body });
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.body.error, "Unauthorized");
    }
    assert.equal(await AppDataSource.getRepository(BaseForm).countBy({ id: created.form.id }), 1);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ companyId: company.id }),
      1,
    );
  });

  test("rejects a signed-in non-member across reads and mutations", async () => {
    const created = await createForm();
    actingUserId = outsider.id;
    const operations: Array<[string, string, unknown?]> = [
      ["GET", collectionPath()],
      ["POST", collectionPath(), { title: "Forbidden" }],
      ["GET", detailPath(created.form.slug)],
      ["PATCH", detailPath(created.form.slug), { title: "Forbidden" }],
      ["POST", `${detailPath(created.form.slug)}/rotate-link`, {}],
      ["DELETE", detailPath(created.form.slug)],
    ];

    for (const [method, path, body] of operations) {
      const response = await apiCall<{ error: string }>(method, path, { body });
      assert.equal(response.status, 403, `${method} ${path}`);
      assert.equal(response.body.error, "Forbidden");
    }
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: created.form.id,
    });
    assert.equal(stored.title, created.form.title);
  });

  test("allows owner, admin, and ordinary Member roles to collaborate on Forms", async () => {
    const actors = [
      { user: owner, role: "owner" },
      { user: admin, role: "admin" },
      { user: member, role: "member" },
    ];
    const created: FormDetail[] = [];
    for (const actor of actors) {
      actingUserId = actor.user.id;
      const detail = await createForm(`${actor.role} survey`);
      created.push(detail);
      assert.equal((await apiCall("GET", detailPath(detail.form.slug))).status, 200);
      assert.equal(
        (
          await apiCall("PATCH", detailPath(detail.form.slug), {
            body: { description: `${actor.role} edited this Form` },
          })
        ).status,
        200,
      );
    }

    const listed = await apiCall<FormSummary[]>("GET", collectionPath());
    assert.equal(listed.status, 200);
    assert.deepEqual(
      new Set(listed.body.map((form) => form.id)),
      new Set(created.map((detail) => detail.form.id)),
    );
    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      companyId: company.id,
    });
    for (const actor of actors) {
      assert.equal(
        audits.filter((event) => event.actorUserId === actor.user.id).length,
        2,
        actor.role,
      );
    }
  });

  test("allows an active company API key but rejects cross-company, revoked, expired, and orphaned keys", async () => {
    actingUserId = null;
    const active = await issueApiKey();
    const authorization = { authorization: `Bearer ${active.token}` };
    const created = await apiCall<FormDetail>("POST", collectionPath(), {
      headers: authorization,
      body: { title: "API survey" },
    });
    assert.equal(created.status, 201);
    assert.equal(
      (await apiCall("GET", detailPath(created.body.form.slug), { headers: authorization })).status,
      200,
    );
    assert.equal(
      (
        await apiCall("PATCH", detailPath(created.body.form.slug), {
          headers: authorization,
          body: { description: "Edited through the API" },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await apiCall("GET", collectionPath(otherCompany, otherCompanyBase, otherCompanyTable), {
          headers: authorization,
        })
      ).status,
      401,
    );

    active.row.revokedAt = new Date();
    await AppDataSource.getRepository(ApiKey).save(active.row);
    assert.equal((await apiCall("GET", collectionPath(), { headers: authorization })).status, 401);

    const expired = await issueApiKey({ expiresAt: new Date(Date.now() - 1_000) });
    assert.equal(
      (
        await apiCall("GET", collectionPath(), {
          headers: { authorization: `Bearer ${expired.token}` },
        })
      ).status,
      401,
    );

    const orphaned = await issueApiKey({ userId: member.id });
    await AppDataSource.getRepository(Membership).delete({
      companyId: company.id,
      userId: member.id,
    });
    assert.equal(
      (
        await apiCall("GET", collectionPath(), {
          headers: { authorization: `Bearer ${orphaned.token}` },
        })
      ).status,
      403,
    );

    const apiAudits = await AppDataSource.getRepository(AuditEvent).findBy({
      targetId: created.body.form.id,
    });
    assert.ok(apiAudits.length >= 2);
    assert.ok(apiAudits.every((event) => event.actorUserId === owner.id));
  });

  test("blocks authenticated Form APIs inside an AI Browser and rejects stale sessions", async () => {
    const aiBrowserHeaders = {
      [AI_BROWSER_REQUEST_HEADER]: AI_BROWSER_REQUEST_VALUE,
    };
    const blockedRead = await apiCall<{ error: string }>("GET", collectionPath(), {
      headers: aiBrowserHeaders,
    });
    const blockedWrite = await apiCall<{ error: string }>("POST", collectionPath(), {
      headers: aiBrowserHeaders,
      body: { title: "Browser escape" },
    });
    assert.equal(blockedRead.status, 403);
    assert.equal(blockedWrite.status, 403);
    assert.match(blockedRead.body.error, /unavailable inside an AI Browser/);
    assert.equal(await AppDataSource.getRepository(BaseForm).countBy({}), 0);

    actingSessionVersion = owner.sessionVersion + 1;
    const stale = await apiCall<{ error: string }>("GET", collectionPath());
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, "Unauthorized");
  });
});

describe("authenticated Base Form tenant isolation", () => {
  test("never resolves a Base, table, or Form through a mismatched scope", async () => {
    const primary = await createForm("Primary Form");
    const sibling = await createForm(
      "Sibling Form",
      collectionPath(company, siblingBase, siblingTable),
    );
    actingUserId = outsider.id;
    const foreign = await createForm(
      "Foreign Form",
      collectionPath(otherCompany, otherCompanyBase, otherCompanyTable),
    );

    actingUserId = owner.id;
    const sameCompanyDetailMismatches = [
      detailPath(primary.form.slug, company, siblingBase, siblingTable),
      detailPath(sibling.form.slug, company, base, table),
      detailPath(primary.form.slug, company, base, siblingTable),
    ];
    for (const path of sameCompanyDetailMismatches) {
      assert.equal((await apiCall("GET", path)).status, 404, path);
      assert.equal((await apiCall("DELETE", path)).status, 404, path);
    }
    assert.equal((await apiCall("GET", collectionPath(company, siblingBase, table))).status, 404);

    actingUserId = outsider.id;
    const crossCompanyMismatches = [
      detailPath(primary.form.slug, otherCompany, otherCompanyBase, otherCompanyTable),
      detailPath(foreign.form.slug, otherCompany, base, table),
      collectionPath(otherCompany, otherCompanyBase, table),
    ];
    for (const path of crossCompanyMismatches) {
      assert.equal((await apiCall("GET", path)).status, 404, path);
    }

    assert.equal(await AppDataSource.getRepository(BaseForm).countBy({}), 3);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ action: "form.delete" }),
      0,
    );
  });

  test("checks company membership before exposing whether scoped resources exist", async () => {
    const created = await createForm();
    actingUserId = outsider.id;
    for (const path of [
      collectionPath(),
      detailPath(created.form.slug),
      detailPath("does-not-exist"),
    ]) {
      const response = await apiCall<{ error: string }>("GET", path);
      assert.equal(response.status, 403);
      assert.equal(response.body.error, "Forbidden");
    }
  });
});

describe("authenticated Base Form input validation", () => {
  test("strictly rejects malformed create bodies and path parameters without side effects", async () => {
    const invalidBodies: unknown[] = [
      {},
      { title: "" },
      { title: "   " },
      { title: "x".repeat(161) },
      { title: 42 },
      { title: "Survey", unexpected: true },
      [],
    ];
    for (const body of invalidBodies) {
      const response = await apiCall<{ error: string }>("POST", collectionPath(), { body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.body.error, "ValidationError");
    }
    assert.equal((await apiCall("POST", collectionPath())).status, 400);

    const malformedPaths = [
      `/api/companies/${company.id}/bases/${"s".repeat(121)}/tables/${table.id}/forms`,
      `/api/companies/${company.id}/bases/${base.slug}/tables/not-a-uuid/forms`,
    ];
    for (const path of malformedPaths) {
      const response = await apiCall<{ error: string }>("GET", path);
      assert.equal(response.status, 400, path);
      assert.equal(response.body.error, "ValidationError");
    }
    assert.equal(await AppDataSource.getRepository(BaseForm).countBy({}), 0);
    assert.equal(await AppDataSource.getRepository(AuditEvent).countBy({}), 0);
  });

  test("strictly rejects malformed patches, duplicate questions, and oversized question sets", async () => {
    const created = await createForm();
    const first = question(nameField);
    const invalidPatches: unknown[] = [
      {},
      { unexpected: true },
      { title: " " },
      { title: "x".repeat(161) },
      { description: "x".repeat(5_001) },
      { submitLabel: " " },
      { submitLabel: "x".repeat(81) },
      { successTitle: " " },
      { successTitle: "x".repeat(161) },
      { successMessage: "x".repeat(5_001) },
      { allowAnotherResponse: "yes" },
      { published: 1 },
      { acceptingResponses: null },
      { questions: [{ ...first, extra: "not allowed" }] },
      { questions: [{ ...first, id: "not-a-uuid" }] },
      { questions: [{ ...first, fieldId: "not-a-uuid" }] },
      { questions: [{ ...first, label: " " }] },
      { questions: [{ ...first, label: "x".repeat(201) }] },
      { questions: [{ ...first, description: "x".repeat(2_001) }] },
      { questions: [first, { ...question(emailField), id: first.id }] },
      { questions: [first, { ...question(nameField), fieldId: first.fieldId }] },
      {
        questions: Array.from({ length: 101 }, (_, index) => ({
          ...question(),
          id: randomUUID(),
          fieldId: randomUUID(),
          label: `Question ${index + 1}`,
        })),
      },
    ];

    for (const body of invalidPatches) {
      const response = await apiCall<{ error: string }>("PATCH", detailPath(created.form.slug), {
        body,
      });
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 300));
      assert.equal(response.body.error, "ValidationError");
    }
    const malformedSlug = await apiCall<{ error: string }>("GET", detailPath("f".repeat(121)));
    assert.equal(malformedSlug.status, 400);
    assert.equal(malformedSlug.body.error, "ValidationError");

    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: created.form.id,
    });
    assert.equal(stored.title, created.form.title);
    assert.equal(stored.questionsJson, "[]");
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({
        targetId: created.form.id,
        action: "form.update",
      }),
      0,
    );
  });

  test("rejects unsupported, missing, and cross-table fields without persisting the patch", async () => {
    const siblingField = await insert(BaseField, {
      tableId: siblingTable.id,
      name: "Vendor",
      type: "text",
      configJson: "{}",
      isPrimary: true,
      sortOrder: 1_000,
    });
    const created = await createForm();
    const cases = [
      [question(internalField), /cannot be public/],
      [question({ ...nameField, id: randomUUID() }), /missing field/],
      [question(siblingField), /missing field/],
    ] as const;
    for (const [invalidQuestion, message] of cases) {
      const response = await apiCall<{ error: string }>("PATCH", detailPath(created.form.slug), {
        body: { questions: [invalidQuestion] },
      });
      assert.equal(response.status, 400);
      assert.match(response.body.error, message);
    }
    assert.equal(
      (await AppDataSource.getRepository(BaseForm).findOneByOrFail({ id: created.form.id }))
        .questionsJson,
      "[]",
    );
  });

  test("requires an empty rotate body and does not rotate the credential on validation failure", async () => {
    const created = await createForm();
    const before = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: created.form.id,
    });
    const rejected = await apiCall<{ error: string }>(
      "POST",
      `${detailPath(created.form.slug)}/rotate-link`,
      { body: { force: true } },
    );
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "ValidationError");
    const unchanged = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: created.form.id,
    });
    assert.equal(unchanged.tokenHash, before.tokenHash);
    assert.equal(unchanged.tokenEncrypted, before.tokenEncrypted);

    const accepted = await apiCall<FormDetail>(
      "POST",
      `${detailPath(created.form.slug)}/rotate-link`,
    );
    assert.equal(accepted.status, 200);
    assert.notEqual(publicToken(accepted.body), publicToken(created));
  });
});

describe("authenticated Base Form lifecycle and cleanup", () => {
  test("round-trips every editable setting while keeping identity and first publish time stable", async () => {
    const created = await createForm("Initial title");
    const slug = created.form.slug;
    const questions = [
      question(nameField, {
        label: "Your name",
        description: "How should we address you?",
        required: true,
      }),
      question(emailField, { label: "Work email", required: false }),
    ];
    const patch = {
      title: "Renamed survey",
      description: "A detailed introduction",
      submitLabel: "Send response",
      successTitle: "All done",
      successMessage: "Your answers have been recorded.",
      allowAnotherResponse: true,
      questions,
      published: true,
      acceptingResponses: false,
    };
    const updated = await apiCall<FormDetail>("PATCH", detailPath(slug), { body: patch });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.form.slug, slug);
    assert.equal(updated.body.form.title, patch.title);
    assert.equal(updated.body.form.description, patch.description);
    assert.equal(updated.body.form.submitLabel, patch.submitLabel);
    assert.equal(updated.body.form.successTitle, patch.successTitle);
    assert.equal(updated.body.form.successMessage, patch.successMessage);
    assert.equal(updated.body.form.allowAnotherResponse, true);
    assert.equal(updated.body.form.acceptingResponses, false);
    assert.deepEqual(updated.body.form.questions, questions);
    assert.ok(updated.body.form.publishedAt);
    const firstPublishedAt = updated.body.form.publishedAt;

    const publishedAgain = await apiCall<FormDetail>("PATCH", detailPath(slug), {
      body: { published: true },
    });
    assert.equal(publishedAgain.status, 200);
    assert.equal(publishedAgain.body.form.publishedAt, firstPublishedAt);
    const reopened = await apiCall<FormDetail>("PATCH", detailPath(slug), {
      body: { acceptingResponses: true },
    });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.form.acceptingResponses, true);
    const unpublished = await apiCall<FormDetail>("PATCH", detailPath(slug), {
      body: { published: false },
    });
    assert.equal(unpublished.status, 200);
    assert.equal(unpublished.body.form.publishedAt, null);

    const fetched = await apiCall<FormDetail>("GET", detailPath(slug));
    assert.equal(fetched.status, 200);
    assert.deepEqual(fetched.body.form.questions, questions);
    assert.deepEqual(
      new Set(fetched.body.fields.map((field) => field.id)),
      new Set([nameField.id, emailField.id, internalField.id]),
    );
  });

  test("creates unique stable slugs and reports response totals without exposing questions in lists", async () => {
    const first = await createForm("Quarterly Intake");
    const second = await createForm("Quarterly Intake");
    assert.equal(first.form.slug, "quarterly-intake");
    assert.equal(second.form.slug, "quarterly-intake-2");

    const record = await insert(BaseRecord, {
      tableId: table.id,
      dataJson: JSON.stringify({ [nameField.id]: "Ada" }),
      sortOrder: 1_000,
    });
    const submission = await insert(BaseFormSubmission, {
      companyId: company.id,
      formId: first.form.id,
      recordId: record.id,
      clientSubmissionId: randomUUID(),
    });
    const listed = await apiCall<Array<FormSummary & { questions?: unknown }>>(
      "GET",
      collectionPath(),
    );
    assert.equal(listed.status, 200);
    const firstSummary = listed.body.find((form) => form.id === first.form.id);
    const secondSummary = listed.body.find((form) => form.id === second.form.id);
    assert.ok(firstSummary);
    assert.ok(secondSummary);
    assert.equal(firstSummary.responseCount, 1);
    assert.equal(firstSummary.lastResponseAt, submission.createdAt.toISOString());
    assert.equal("questions" in firstSummary, false);
    assert.equal(secondSummary.responseCount, 0);
    assert.equal(secondSummary.lastResponseAt, null);
  });

  test("allocates unique bounded slugs when same-title Forms are created concurrently", async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        apiCall<FormDetail>("POST", collectionPath(), {
          body: { title: "Concurrent intake" },
        }),
      ),
    );
    assert.ok(
      responses.every((response) => response.status === 201),
      JSON.stringify(
        responses.map((response) => ({ status: response.status, body: response.body })),
      ),
    );
    const slugs = responses.map((response) => response.body.form.slug);
    assert.equal(new Set(slugs).size, responses.length);
    assert.ok(slugs.every((slug) => slug.length <= 120));
    assert.ok(slugs.includes("concurrent-intake"));
    assert.equal(await AppDataSource.getRepository(BaseForm).countBy({ tableId: table.id }), 12);
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({ action: "form.create" }),
      12,
    );
  });

  test("enforces draft and archived-table publishing rules without partial writes", async () => {
    const created = await createForm();
    const emptyPublish = await apiCall<{ error: string }>("PATCH", detailPath(created.form.slug), {
      body: { published: true },
    });
    assert.equal(emptyPublish.status, 400);
    assert.match(emptyPublish.body.error, /at least one question/i);

    table.archivedAt = new Date();
    await AppDataSource.getRepository(BaseTable).save(table);
    const archivedCreate = await apiCall<{ error: string }>("POST", collectionPath(), {
      body: { title: "Archived" },
    });
    assert.equal(archivedCreate.status, 409);
    assert.match(archivedCreate.body.error, /Restore this table/);

    const archivedPublish = await apiCall<{ error: string }>(
      "PATCH",
      detailPath(created.form.slug),
      { body: { questions: [question(nameField)], published: true } },
    );
    assert.equal(archivedPublish.status, 409);
    assert.match(archivedPublish.body.error, /Restore this table/);
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: created.form.id,
    });
    assert.equal(stored.publishedAt, null);
    assert.equal(stored.questionsJson, "[]");
  });

  test("redacts question and presentation content from lifecycle audit metadata and skips no-op audits", async () => {
    const created = await createForm("Audit target");
    const oldToken = publicToken(created);
    const secretQuestion = question(nameField, {
      label: "Sensitive question label 7c895",
      description: "Sensitive question description 7c895",
      required: true,
    });
    const update = await apiCall<FormDetail>("PATCH", detailPath(created.form.slug), {
      body: {
        description: "Sensitive Form description 7c895",
        successMessage: "Sensitive success message 7c895",
        questions: [secretQuestion],
        published: true,
      },
    });
    assert.equal(update.status, 200);
    const noOp = await apiCall<FormDetail>("PATCH", detailPath(created.form.slug), {
      body: { title: created.form.title },
    });
    assert.equal(noOp.status, 200);
    const rotated = await apiCall<FormDetail>(
      "POST",
      `${detailPath(created.form.slug)}/rotate-link`,
      { body: {} },
    );
    assert.equal(rotated.status, 200);
    const newToken = publicToken(rotated.body);

    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      targetId: created.form.id,
    });
    assert.equal(audits.filter((event) => event.action === "form.create").length, 1);
    assert.equal(audits.filter((event) => event.action === "form.update").length, 1);
    assert.equal(audits.filter((event) => event.action === "form.public_link.rotate").length, 1);
    const metadata = audits.map((event) => event.metadataJson).join("\n");
    for (const secret of [
      oldToken,
      newToken,
      secretQuestion.id,
      secretQuestion.label,
      secretQuestion.description,
      "Sensitive Form description 7c895",
      "Sensitive success message 7c895",
    ]) {
      assert.ok(!metadata.includes(secret), secret);
    }
    assert.ok(audits.every((event) => event.actorUserId === owner.id));
    assert.ok(audits.every((event) => event.actorKind === "user"));
    assert.ok(audits.every((event) => event.targetType === "base_form"));
    const updateMetadata = JSON.parse(
      audits.find((event) => event.action === "form.update")!.metadataJson,
    ) as { changes: string[]; published: boolean; acceptingResponses: boolean };
    assert.deepEqual(updateMetadata.changes, [
      "description",
      "successMessage",
      "questions",
      "publish",
    ]);
    assert.equal(updateMetadata.published, true);
    assert.equal(updateMetadata.acceptingResponses, true);
  });

  test("deletes Form lineage while preserving Base rows and append-only audit history", async () => {
    const created = await createForm("Disposable Form");
    const token = publicToken(created);
    const records = await Promise.all(
      ["Ada", "Grace"].map((name, index) =>
        insert(BaseRecord, {
          tableId: table.id,
          dataJson: JSON.stringify({ [nameField.id]: name }),
          sortOrder: (index + 1) * 1_000,
        }),
      ),
    );
    for (const record of records) {
      await insert(BaseFormSubmission, {
        companyId: company.id,
        formId: created.form.id,
        recordId: record.id,
        clientSubmissionId: randomUUID(),
      });
    }
    const deleted = await apiCall<{ ok: boolean }>("DELETE", detailPath(created.form.slug));
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { ok: true });
    assert.equal(await AppDataSource.getRepository(BaseForm).countBy({ id: created.form.id }), 0);
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({ formId: created.form.id }),
      0,
    );
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 2);

    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      targetId: created.form.id,
    });
    assert.deepEqual(audits.map((event) => event.action).sort(), ["form.create", "form.delete"]);
    assert.ok(!audits.some((event) => event.metadataJson.includes(token)));
    assert.equal((await apiCall("GET", detailPath(created.form.slug))).status, 404);
    assert.equal((await apiCall("DELETE", detailPath(created.form.slug))).status, 404);
  });

  test("fails closed when duplicated Form tenancy is damaged", async () => {
    const created = await createForm();
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: created.form.id,
    });
    stored.companyId = otherCompany.id;
    await AppDataSource.getRepository(BaseForm).save(stored);

    assert.equal((await apiCall("GET", detailPath(created.form.slug))).status, 404);
    assert.equal(
      (
        await apiCall("PATCH", detailPath(created.form.slug), {
          body: { title: "Should not change" },
        })
      ).status,
      404,
    );
    assert.equal((await apiCall("DELETE", detailPath(created.form.slug))).status, 404);
    assert.equal(
      (await AppDataSource.getRepository(BaseForm).findOneByOrFail({ id: created.form.id })).title,
      created.form.title,
    );
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({
        targetId: created.form.id,
        action: "form.delete",
      }),
      0,
    );
  });

  test("stores a rotated token hash rather than either public bearer value", async () => {
    const created = await createForm();
    const oldToken = publicToken(created);
    const rotated = await apiCall<FormDetail>(
      "POST",
      `${detailPath(created.form.slug)}/rotate-link`,
      { body: {} },
    );
    assert.equal(rotated.status, 200);
    const nextToken = publicToken(rotated.body);
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: created.form.id,
    });
    assert.equal(stored.tokenHash, hashBaseFormToken(nextToken));
    assert.notEqual(stored.tokenHash, hashBaseFormToken(oldToken));
    assert.ok(!stored.tokenEncrypted.includes(oldToken));
    assert.ok(!stored.tokenEncrypted.includes(nextToken));
  });
});
