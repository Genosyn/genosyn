import { persistTestSession } from "../test/userSession.js";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
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
import { hashBaseFormToken } from "../services/baseForms.js";
import { deleteUserCascade } from "../services/userDelete.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { basesRouter } from "./bases.js";
import { formsRouter } from "./forms.js";
import {
  publicFormsRouter,
  publicFormsSecurityHeaders,
  resetPublicFormSubmitThrottleForTests,
} from "./publicForms.js";

type FormQuestion = {
  id: string;
  fieldId: string;
  label: string;
  description: string;
  required: boolean;
};

type FormDto = {
  id: string;
  slug: string;
  title: string;
  publishedAt: string | null;
  acceptingResponses: boolean;
  publicUrl: string | null;
  responseCount: number;
  questions: FormQuestion[];
};

type FormDetail = { form: FormDto; fields: Array<{ id: string; type: string }> };

let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;
let company: Company;
let base: Base;
let table: BaseTable;
let nameField: BaseField;
let emailField: BaseField;
let choiceField: BaseField;
let linkField: BaseField;

before(async () => {
  await initTestDb();
  const app = express();
  app.use("/api/forms", publicFormsSecurityHeaders);
  app.use("/forms", publicFormsSecurityHeaders);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/forms", publicFormsRouter);
  app.get("/forms/:token", (_req, res) => res.type("html").send("forms app"));
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
    next();
  });
  app.use("/api/companies/:cid", basesRouter);
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

beforeEach(async () => {
  await resetTestDb();
  resetPublicFormSubmitThrottleForTests();
  const owner = await insert(User, {
    email: `forms-${randomUUID()}@example.com`,
    name: "Forms owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  actingUserId = owner.id;
  company = await insert(Company, {
    name: "Northstar Research",
    slug: `forms-${randomUUID()}`,
    ownerId: owner.id,
  });
  await insert(Membership, {
    companyId: company.id,
    userId: owner.id,
    role: "owner" as Role,
  });
  base = await insert(Base, {
    companyId: company.id,
    name: "Research",
    slug: "research",
    color: "violet",
    createdById: owner.id,
  });
  table = await insert(BaseTable, {
    baseId: base.id,
    name: "Interviews",
    slug: "interviews",
    sortOrder: 1_000,
    archivedAt: null,
  });
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
  choiceField = await insert(BaseField, {
    tableId: table.id,
    name: "Plan",
    type: "select",
    configJson: JSON.stringify({
      options: [
        { id: "starter", label: "Starter", color: "slate" },
        { id: "growth", label: "Growth", color: "emerald" },
      ],
    }),
    isPrimary: false,
    sortOrder: 3_000,
  });
  linkField = await insert(BaseField, {
    tableId: table.id,
    name: "Internal account",
    type: "link",
    configJson: JSON.stringify({ targetTableId: table.id }),
    isPrimary: false,
    sortOrder: 4_000,
  });
});

async function jsonCall<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

function formsPath(): string {
  return `/api/companies/${company.id}/bases/${base.slug}/tables/${table.id}/forms`;
}

function tokenFrom(detail: FormDetail): string {
  assert.ok(detail.form.publicUrl);
  return new URL(detail.form.publicUrl).pathname.split("/").pop()!;
}

async function createForm(title = "Customer interview"): Promise<FormDetail> {
  const response = await jsonCall<FormDetail>("POST", formsPath(), { title });
  assert.equal(response.status, 201);
  return response.body;
}

async function publishForm(): Promise<{
  detail: FormDetail;
  token: string;
  questions: { name: FormQuestion; email: FormQuestion; plan: FormQuestion };
}> {
  const created = await createForm();
  const questions = {
    name: {
      id: randomUUID(),
      fieldId: nameField.id,
      label: "Your name",
      description: "",
      required: true,
    },
    email: {
      id: randomUUID(),
      fieldId: emailField.id,
      label: "Work email",
      description: "We will only use this to follow up.",
      required: false,
    },
    plan: {
      id: randomUUID(),
      fieldId: choiceField.id,
      label: "Preferred plan",
      description: "",
      required: false,
    },
  };
  const response = await jsonCall<FormDetail>("PATCH", `${formsPath()}/${created.form.slug}`, {
    questions: Object.values(questions),
    published: true,
  });
  assert.equal(response.status, 200);
  return { detail: response.body, token: tokenFrom(response.body), questions };
}

describe("Base Forms member and public links", () => {
  test("keeps maximum-length titles reachable through a bounded stable slug", async () => {
    const created = await createForm("A".repeat(160));
    assert.ok(created.form.slug.length <= 120);

    const fetched = await jsonCall<FormDetail>("GET", `${formsPath()}/${created.form.slug}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.form.id, created.form.id);
  });

  test("stores only a hash plus ciphertext, projects a safe public DTO, and rotates the link", async () => {
    const { detail, token, questions } = await publishForm();
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: detail.form.id,
    });
    assert.equal(stored.tokenHash, hashBaseFormToken(token));
    assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(stored.tokenEncrypted, token);
    assert.equal("tokenHash" in (detail.form as unknown as Record<string, unknown>), false);
    assert.equal("tokenEncrypted" in (detail.form as unknown as Record<string, unknown>), false);

    const opened = await jsonCall<Record<string, unknown>>("GET", `/api/forms/${token}`);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.companyName, company.name);
    assert.equal(opened.body.color, base.color);
    const serialized = JSON.stringify(opened.body);
    assert.ok(!serialized.includes(company.id));
    assert.ok(!serialized.includes(base.id));
    assert.ok(!serialized.includes(table.id));
    assert.ok(!serialized.includes(nameField.id));
    assert.ok(!serialized.includes(linkField.id));
    assert.ok(serialized.includes(questions.name.id));
    assert.ok(!serialized.includes("targetTableId"));
    assert.match(opened.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(opened.headers.get("pragma"), "no-cache");
    assert.equal(opened.headers.get("x-robots-tag"), "noindex, nofollow");

    const rotated = await jsonCall<FormDetail>(
      "POST",
      `${formsPath()}/${detail.form.slug}/rotate-link`,
      {},
    );
    assert.equal(rotated.status, 200);
    const nextToken = tokenFrom(rotated.body);
    assert.notEqual(nextToken, token);
    const oldLink = await jsonCall("GET", `/api/forms/${token}`);
    const malformed = await jsonCall("GET", "/api/forms/not-a-token");
    assert.equal(oldLink.status, 404);
    assert.equal(malformed.status, 404);
    assert.deepEqual(oldLink.body, malformed.body);
    assert.equal((await jsonCall("GET", `/api/forms/${nextToken}`)).status, 200);

    const browserPage = await fetch(`${baseUrl}/forms/${nextToken}`);
    assert.match(browserPage.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(browserPage.headers.get("x-robots-tag"), "noindex, nofollow");
  });

  test("audits Member Form lifecycle changes without bearer tokens or response content", async () => {
    const created = await createForm("Audited survey");
    const originalToken = tokenFrom(created);
    const question: FormQuestion = {
      id: randomUUID(),
      fieldId: nameField.id,
      label: "Private prompt text",
      description: "Private prompt description",
      required: true,
    };

    assert.equal(
      (
        await jsonCall("PATCH", `${formsPath()}/${created.form.slug}`, {
          questions: [question],
          published: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await jsonCall("PATCH", `${formsPath()}/${created.form.slug}`, {
          acceptingResponses: false,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await jsonCall("PATCH", `${formsPath()}/${created.form.slug}`, {
          acceptingResponses: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await jsonCall("PATCH", `${formsPath()}/${created.form.slug}`, {
          published: false,
        })
      ).status,
      200,
    );
    const rotated = await jsonCall<FormDetail>(
      "POST",
      `${formsPath()}/${created.form.slug}/rotate-link`,
      {},
    );
    assert.equal(rotated.status, 200);
    const rotatedToken = tokenFrom(rotated.body);
    assert.equal((await jsonCall("DELETE", `${formsPath()}/${created.form.slug}`)).status, 200);

    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      companyId: company.id,
      targetId: created.form.id,
    });
    assert.equal(audits.filter((audit) => audit.action === "form.create").length, 1);
    assert.equal(audits.filter((audit) => audit.action === "form.update").length, 4);
    assert.equal(audits.filter((audit) => audit.action === "form.public_link.rotate").length, 1);
    assert.equal(audits.filter((audit) => audit.action === "form.delete").length, 1);
    assert.ok(
      audits.every(
        (audit) =>
          audit.actorKind === "user" &&
          audit.actorUserId === actingUserId &&
          audit.targetType === "base_form",
      ),
    );

    const updateChanges = audits
      .filter((audit) => audit.action === "form.update")
      .map((audit) => (JSON.parse(audit.metadataJson) as { changes: string[] }).changes)
      .map((changes) => changes.join(","));
    assert.deepEqual(
      new Set(updateChanges),
      new Set(["questions,publish", "close", "reopen", "unpublish"]),
    );
    const serializedAudit = audits.map((audit) => audit.metadataJson).join("\n");
    assert.ok(!serializedAudit.includes(originalToken));
    assert.ok(!serializedAudit.includes(rotatedToken));
    assert.ok(!serializedAudit.includes(question.id));
    assert.ok(!serializedAudit.includes(question.label));
    assert.ok(!serializedAudit.includes(question.description));
  });

  test("keeps draft, closed, archived, and cross-tenant destinations fail closed", async () => {
    const draft = await createForm("Draft survey");
    assert.equal((await jsonCall("GET", `/api/forms/${tokenFrom(draft)}`)).status, 404);

    const { detail, token } = await publishForm();
    const closed = await jsonCall<FormDetail>("PATCH", `${formsPath()}/${detail.form.slug}`, {
      acceptingResponses: false,
    });
    assert.equal(closed.status, 200);
    const closedPublic = await jsonCall<{ acceptingResponses: boolean }>(
      "GET",
      `/api/forms/${token}`,
    );
    assert.equal(closedPublic.status, 200);
    assert.equal(closedPublic.body.acceptingResponses, false);
    assert.equal(
      (
        await jsonCall("POST", `/api/forms/${token}/responses`, {
          submissionId: randomUUID(),
          values: {},
        })
      ).status,
      409,
    );

    await jsonCall("PATCH", `${formsPath()}/${detail.form.slug}`, {
      acceptingResponses: true,
      published: false,
    });
    assert.equal((await jsonCall("GET", `/api/forms/${token}`)).status, 404);

    await jsonCall("PATCH", `${formsPath()}/${detail.form.slug}`, { published: true });
    table.archivedAt = new Date();
    await AppDataSource.getRepository(BaseTable).save(table);
    assert.equal((await jsonCall("GET", `/api/forms/${token}`)).status, 404);

    table.archivedAt = null;
    await AppDataSource.getRepository(BaseTable).save(table);
    const other = await insert(Company, {
      name: "Other company",
      slug: `other-${randomUUID()}`,
      ownerId: actingUserId!,
    });
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: detail.form.id,
    });
    stored.companyId = other.id;
    await AppDataSource.getRepository(BaseForm).save(stored);
    assert.equal((await jsonCall("GET", `/api/forms/${token}`)).status, 404);
  });

  test("throttles unknown probes without penalizing known inactive Form links", async () => {
    const draft = await createForm("Inactive survey");
    const draftToken = tokenFrom(draft);
    const { token: activeToken } = await publishForm();

    for (let attempt = 0; attempt <= config.security.authRateLimit.maxAttempts; attempt += 1) {
      assert.equal((await jsonCall("GET", `/api/forms/${draftToken}`)).status, 404);
    }
    assert.equal((await jsonCall("GET", `/api/forms/${activeToken}`)).status, 200);

    const unknownToken = randomBytes(32).toString("base64url");
    for (let attempt = 0; attempt < config.security.authRateLimit.maxAttempts; attempt += 1) {
      assert.equal((await jsonCall("GET", `/api/forms/${unknownToken}`)).status, 404);
    }
    const blocked = await jsonCall("GET", `/api/forms/${unknownToken}`);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  });

  test("keeps a departing Member's Form while unlinking its creator", async () => {
    const member = await insert(User, {
      email: `departing-${randomUUID()}@example.com`,
      name: "Departing Member",
      passwordHash: "x",
      sessionVersion: 0,
    });
    await insert(Membership, {
      companyId: company.id,
      userId: member.id,
      role: "member" as Role,
    });
    actingUserId = member.id;
    const created = await createForm("Former Member's survey");
    assert.equal(
      (await AppDataSource.getRepository(BaseForm).findOneByOrFail({ id: created.form.id }))
        .createdById,
      member.id,
    );

    await deleteUserCascade({ userId: member.id });

    const retained = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: created.form.id,
    });
    assert.equal(retained.createdById, null);
    assert.equal(retained.title, "Former Member's survey");
    assert.equal(await AppDataSource.getRepository(User).countBy({ id: member.id }), 0);
  });
});

describe("Base Form responses", () => {
  test("accepts browser local datetimes and rejects loose or impossible values", async () => {
    const datetimeField = await insert(BaseField, {
      tableId: table.id,
      name: "Appointment",
      type: "datetime",
      configJson: "{}",
      isPrimary: false,
      sortOrder: 5_000,
    });
    const created = await createForm("Appointment request");
    const question: FormQuestion = {
      id: randomUUID(),
      fieldId: datetimeField.id,
      label: "Appointment time",
      description: "",
      required: true,
    };
    const published = await jsonCall<FormDetail>("PATCH", `${formsPath()}/${created.form.slug}`, {
      questions: [question],
      published: true,
    });
    assert.equal(published.status, 200);
    const token = tokenFrom(published.body);

    for (const value of ["2024-02-30T12:00", "0", "2024-02-29 12:00", "2024-02-29T24:00"]) {
      const response = await jsonCall("POST", `/api/forms/${token}/responses`, {
        submissionId: randomUUID(),
        values: { [question.id]: value },
      });
      assert.equal(response.status, 400, value);
    }
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 0);

    const accepted = await jsonCall("POST", `/api/forms/${token}/responses`, {
      submissionId: randomUUID(),
      values: { [question.id]: "2024-02-29T12:34" },
    });
    assert.equal(accepted.status, 200);
    const record = await AppDataSource.getRepository(BaseRecord).findOneByOrFail({
      tableId: table.id,
    });
    assert.equal(JSON.parse(record.dataJson)[datetimeField.id], "2024-02-29T12:34");
  });

  test("rejects publishing required select and multiselect questions with no usable choices", async () => {
    for (const [index, type] of (["select", "multiselect"] as const).entries()) {
      const emptyChoiceField = await insert(BaseField, {
        tableId: table.id,
        name: type === "select" ? "Empty choice" : "Empty multiple choice",
        type,
        configJson: JSON.stringify({
          options: [{ id: `blank-${type}`, label: "   ", color: "slate" }],
        }),
        isPrimary: false,
        sortOrder: 5_000 + index,
      });
      const created = await createForm(`${type} validation`);
      const question: FormQuestion = {
        id: randomUUID(),
        fieldId: emptyChoiceField.id,
        label: type === "select" ? "Choose one" : "Choose several",
        description: "",
        required: true,
      };

      const savedDraft = await jsonCall<FormDetail>(
        "PATCH",
        `${formsPath()}/${created.form.slug}`,
        { questions: [question] },
      );
      assert.equal(savedDraft.status, 200);
      const published = await jsonCall<{ error: string }>(
        "PATCH",
        `${formsPath()}/${created.form.slug}`,
        { published: true },
      );
      assert.equal(published.status, 400);
      assert.match(published.body.error, /at least one choice before publishing/);
      assert.equal(
        (await AppDataSource.getRepository(BaseForm).findOneByOrFail({ id: created.form.id }))
          .publishedAt,
        null,
      );
    }
  });

  test("creates one Base row for an idempotent retry and records redacted audit lineage", async () => {
    const { detail, token, questions } = await publishForm();
    const submissionId = randomUUID();
    const body = {
      submissionId,
      values: {
        [questions.name.id]: "Ada Lovelace",
        [questions.email.id]: "ada@example.com",
        [questions.plan.id]: "growth",
      },
    };
    const first = await jsonCall<{ ok: true }>("POST", `/api/forms/${token}/responses`, body);
    const retry = await jsonCall<{ ok: true }>("POST", `/api/forms/${token}/responses`, body);
    assert.equal(first.status, 200);
    assert.equal(retry.status, 200);
    assert.deepEqual(first.body, { ok: true });
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 1);
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({ formId: detail.form.id }),
      1,
    );
    const record = await AppDataSource.getRepository(BaseRecord).findOneByOrFail({
      tableId: table.id,
    });
    assert.deepEqual(JSON.parse(record.dataJson), {
      [nameField.id]: "Ada Lovelace",
      [emailField.id]: "ada@example.com",
      [choiceField.id]: "growth",
    });
    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      companyId: company.id,
      action: "form.submission.create",
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorKind, "webhook");
    assert.ok(!audits[0].metadataJson.includes("Ada"));
    assert.ok(!audits[0].metadataJson.includes("ada@example.com"));
  });

  test("handles concurrent SQLite HTTP submissions with distinct and shared keys", async () => {
    const { detail, token, questions } = await publishForm();
    const endpoint = `/api/forms/${token}/responses`;
    const distinct = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        jsonCall("POST", endpoint, {
          submissionId: randomUUID(),
          values: { [questions.name.id]: `Respondent ${index + 1}` },
        }),
      ),
    );
    assert.ok(distinct.every((response) => response.status === 200));
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 10);

    const sharedSubmissionId = randomUUID();
    const shared = await Promise.all(
      Array.from({ length: 10 }, () =>
        jsonCall("POST", endpoint, {
          submissionId: sharedSubmissionId,
          values: { [questions.name.id]: "One retried respondent" },
        }),
      ),
    );
    assert.ok(shared.every((response) => response.status === 200));
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 11);
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({ formId: detail.form.id }),
      11,
    );
  });

  test("honors a committed idempotency key after the Form closes", async () => {
    const { detail, token, questions } = await publishForm();
    const submissionId = randomUUID();
    const response = {
      submissionId,
      values: { [questions.name.id]: "Dorothy Vaughan" },
    };
    assert.equal((await jsonCall("POST", `/api/forms/${token}/responses`, response)).status, 200);
    assert.equal(
      (
        await jsonCall("PATCH", `${formsPath()}/${detail.form.slug}`, {
          acceptingResponses: false,
        })
      ).status,
      200,
    );

    const retry = await jsonCall<{ ok: true }>("POST", `/api/forms/${token}/responses`, response);
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, { ok: true });
    assert.equal(
      (
        await jsonCall("POST", `/api/forms/${token}/responses`, {
          ...response,
          submissionId: randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 1);
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({ formId: detail.form.id }),
      1,
    );
  });

  test("rejects unknown, missing, invalid choice, and internal-link answers without a row", async () => {
    const created = await createForm("Validation survey");
    const internalQuestion: FormQuestion = {
      id: randomUUID(),
      fieldId: linkField.id,
      label: "Internal account",
      description: "",
      required: false,
    };
    const internal = await jsonCall("PATCH", `${formsPath()}/${created.form.slug}`, {
      questions: [internalQuestion],
    });
    assert.equal(internal.status, 400);

    const { token, questions } = await publishForm();
    const cases = [
      { [randomUUID()]: "unknown" },
      {},
      { [questions.name.id]: "Ada", [questions.plan.id]: "enterprise" },
      { [questions.name.id]: "Ada", [questions.email.id]: "not-an-email" },
    ];
    for (const values of cases) {
      const response = await jsonCall("POST", `/api/forms/${token}/responses`, {
        submissionId: randomUUID(),
        values,
      });
      assert.equal(response.status, 400);
    }
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 0);
  });

  test("retains collected rows when a Form is deleted and removes lineage when a row is deleted", async () => {
    const { detail, token, questions } = await publishForm();
    await jsonCall("POST", `/api/forms/${token}/responses`, {
      submissionId: randomUUID(),
      values: { [questions.name.id]: "Grace Hopper" },
    });
    const record = await AppDataSource.getRepository(BaseRecord).findOneByOrFail({
      tableId: table.id,
    });
    const deletedRow = await jsonCall(
      "DELETE",
      `/api/companies/${company.id}/bases/${base.slug}/tables/${table.id}/rows/${record.id}`,
    );
    assert.equal(deletedRow.status, 200);
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({ formId: detail.form.id }),
      0,
    );

    const secondSubmission = randomUUID();
    await jsonCall("POST", `/api/forms/${token}/responses`, {
      submissionId: secondSubmission,
      values: { [questions.name.id]: "Katherine Johnson" },
    });
    const deletedForm = await jsonCall("DELETE", `${formsPath()}/${detail.form.slug}`);
    assert.equal(deletedForm.status, 200);
    assert.equal(await AppDataSource.getRepository(BaseForm).countBy({ id: detail.form.id }), 0);
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({ formId: detail.form.id }),
      0,
    );
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 1);
    assert.equal((await jsonCall("GET", `/api/forms/${token}`)).status, 404);
  });

  test("sets privacy headers before rejecting an oversized response body", async () => {
    const { token } = await publishForm();
    const response = await fetch(`${baseUrl}/api/forms/${token}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(1_100_000) }),
    });
    assert.equal(response.status, 413);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  });
});
