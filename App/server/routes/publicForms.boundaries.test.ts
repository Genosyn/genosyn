import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";
import type { Server } from "node:http";

import { AppDataSource } from "../db/datasource.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Base } from "../db/entities/Base.js";
import { BaseField } from "../db/entities/BaseField.js";
import { BaseForm } from "../db/entities/BaseForm.js";
import { BaseFormSubmission } from "../db/entities/BaseFormSubmission.js";
import { BaseRecord } from "../db/entities/BaseRecord.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Company } from "../db/entities/Company.js";
import { errorHandler } from "../middleware/error.js";
import {
  PUBLIC_BASE_FORM_FIELD_TYPES,
  BaseFormRequestError,
  PublicBaseFormClosedError,
  PublicBaseFormNotFoundError,
  baseFormQuestionsSchema,
  baseFormTokenExists,
  createBaseForm,
  deleteBaseForm,
  hashBaseFormToken,
  publicBaseFormDto,
  resolvePublicBaseForm,
  submitBaseFormResponse,
  updateBaseForm,
  type BaseFormQuestion,
  type PublicBaseFormFieldType,
  type PublicBaseFormValue,
} from "../services/baseForms.js";
import { deleteBaseRecordWithContents, deleteBaseTableWithContents } from "../services/bases.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { publicFormsRouter, resetPublicFormSubmitThrottleForTests } from "./publicForms.js";

type FieldMap = Record<PublicBaseFormFieldType, BaseField>;
type QuestionMap = Record<PublicBaseFormFieldType, BaseFormQuestion>;

const choiceOptions = [
  { id: "starter", label: "Starter", color: "slate" },
  { id: "growth", label: "Growth", color: "emerald" },
  { id: "scale", label: "Scale", color: "violet" },
];

let server: Server;
let baseUrl = "";
let company: Company;
let base: Base;
let table: BaseTable;
let fields: FieldMap;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/forms", publicFormsRouter);
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

  company = await insert(Company, {
    name: "Boundary Labs",
    slug: `boundary-${randomUUID()}`,
    ownerId: randomUUID(),
  });
  base = await insert(Base, {
    companyId: company.id,
    name: "Public research",
    slug: "public-research",
    color: "violet",
    createdById: null,
  });
  table = await insert(BaseTable, {
    baseId: base.id,
    name: "Responses",
    slug: "responses",
    sortOrder: 1_000,
    archivedAt: null,
  });

  const entries = await Promise.all(
    PUBLIC_BASE_FORM_FIELD_TYPES.map(async (type, index) => {
      const field = await insert(BaseField, {
        tableId: table.id,
        name: `${type} answer`,
        type,
        configJson:
          type === "select" || type === "multiselect"
            ? JSON.stringify({ options: choiceOptions })
            : "{}",
        isPrimary: index === 0,
        sortOrder: (index + 1) * 1_000,
      });
      return [type, field] as const;
    }),
  );
  fields = Object.fromEntries(entries) as FieldMap;
});

function questions(required = false): QuestionMap {
  return Object.fromEntries(
    PUBLIC_BASE_FORM_FIELD_TYPES.map((type) => [
      type,
      {
        id: randomUUID(),
        fieldId: fields[type].id,
        label: `${type} question`,
        description: `Enter the ${type} response`,
        required,
      },
    ]),
  ) as QuestionMap;
}

function tokenFromPublicUrl(publicUrl: string | null): string {
  assert.ok(publicUrl);
  const token = new URL(publicUrl).pathname.split("/").pop();
  assert.ok(token);
  return token;
}

async function publishForm(questionList: BaseFormQuestion[], title = "Boundary survey") {
  const created = await createBaseForm({
    companyId: company.id,
    baseSlug: base.slug,
    tableId: table.id,
    title,
    actorUserId: null,
  });
  const detail = await updateBaseForm({
    companyId: company.id,
    baseSlug: base.slug,
    tableId: table.id,
    formSlug: created.form.slug,
    patch: { questions: questionList, published: true },
    actorUserId: null,
  });
  return {
    detail,
    token: tokenFromPublicUrl(detail.form.publicUrl),
  };
}

function validValues(questionMap: QuestionMap): Record<string, PublicBaseFormValue> {
  return {
    [questionMap.text.id]: "Ada Lovelace",
    [questionMap.longtext.id]: "A carefully considered long answer.",
    [questionMap.number.id]: 42.5,
    [questionMap.checkbox.id]: true,
    [questionMap.date.id]: "2000-02-29",
    [questionMap.datetime.id]: "2024-02-29T23:59:59.999",
    [questionMap.email.id]: "ada@example.com",
    [questionMap.url.id]: "https://example.com/path?q=1#answer",
    [questionMap.select.id]: "growth",
    [questionMap.multiselect.id]: ["starter", "scale"],
  };
}

async function publicCall<T = Record<string, unknown>>(
  method: "GET" | "POST",
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

async function counts(formId: string): Promise<{ records: number; submissions: number }> {
  const [records, submissions] = await Promise.all([
    AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }),
    AppDataSource.getRepository(BaseFormSubmission).countBy({ formId }),
  ]);
  return { records, submissions };
}

function isRequestError(error: unknown, message: RegExp): boolean {
  return (
    error instanceof BaseFormRequestError && error.status === 400 && message.test(error.message)
  );
}

describe("public Base Form question and value boundaries", () => {
  test("accepts exactly 100 strict, uniquely bound question definitions", () => {
    const makeQuestion = (): BaseFormQuestion => ({
      id: randomUUID(),
      fieldId: randomUUID(),
      label: "Question",
      description: "",
      required: false,
    });
    const oneHundred = Array.from({ length: 100 }, makeQuestion);
    assert.equal(baseFormQuestionsSchema.safeParse(oneHundred).success, true);
    assert.equal(baseFormQuestionsSchema.safeParse([...oneHundred, makeQuestion()]).success, false);

    const duplicateQuestionId = [makeQuestion(), makeQuestion()];
    duplicateQuestionId[1].id = duplicateQuestionId[0].id;
    assert.equal(baseFormQuestionsSchema.safeParse(duplicateQuestionId).success, false);

    const duplicateFieldId = [makeQuestion(), makeQuestion()];
    duplicateFieldId[1].fieldId = duplicateFieldId[0].fieldId;
    assert.equal(baseFormQuestionsSchema.safeParse(duplicateFieldId).success, false);
    assert.equal(
      baseFormQuestionsSchema.safeParse([{ ...makeQuestion(), unexpected: true }]).success,
      false,
    );
    assert.equal(
      baseFormQuestionsSchema.safeParse([{ ...makeQuestion(), label: " ".repeat(3) }]).success,
      false,
    );
    assert.equal(
      baseFormQuestionsSchema.safeParse([{ ...makeQuestion(), label: "x".repeat(201) }]).success,
      false,
    );
    assert.equal(
      baseFormQuestionsSchema.safeParse([{ ...makeQuestion(), description: "x".repeat(2_001) }])
        .success,
      false,
    );
  });

  test("stores every supported field type at its valid size and format boundaries", async () => {
    const questionMap = questions(true);
    const { detail, token } = await publishForm(Object.values(questionMap));
    const values = validValues(questionMap);
    values[questionMap.text.id] = "t".repeat(2_000);
    values[questionMap.longtext.id] = "l".repeat(50_000);
    values[questionMap.number.id] = Number.MAX_VALUE;
    values[questionMap.email.id] = "  boundary@example.com  ";
    values[questionMap.url.id] = "  https://example.com/a?b=c  ";

    assert.deepEqual(
      await submitBaseFormResponse({
        token,
        clientSubmissionId: randomUUID(),
        values,
      }),
      { ok: true },
    );

    const row = await AppDataSource.getRepository(BaseRecord).findOneByOrFail({
      tableId: table.id,
    });
    assert.deepEqual(JSON.parse(row.dataJson), {
      [fields.text.id]: "t".repeat(2_000),
      [fields.longtext.id]: "l".repeat(50_000),
      [fields.number.id]: Number.MAX_VALUE,
      [fields.checkbox.id]: true,
      [fields.date.id]: "2000-02-29",
      [fields.datetime.id]: "2024-02-29T23:59:59.999",
      [fields.email.id]: "boundary@example.com",
      [fields.url.id]: "https://example.com/a?b=c",
      [fields.select.id]: "growth",
      [fields.multiselect.id]: ["starter", "scale"],
    });
    assert.deepEqual(await counts(detail.form.id), { records: 1, submissions: 1 });

    const context = await resolvePublicBaseForm(token);
    assert.ok(context);
    const dto = publicBaseFormDto(context);
    assert.deepEqual(
      dto.questions.map((question) => question.type),
      PUBLIC_BASE_FORM_FIELD_TYPES,
    );
    assert.deepEqual(
      dto.questions.find((question) => question.type === "select")?.options,
      choiceOptions,
    );
    assert.deepEqual(
      dto.questions.find((question) => question.type === "multiselect")?.options,
      choiceOptions,
    );
  });

  test("enforces required semantics for every supported type without reserving lineage", async () => {
    const questionMap = questions(true);
    const { detail, token } = await publishForm(Object.values(questionMap), "Required answers");
    const complete = validValues(questionMap);

    for (const type of PUBLIC_BASE_FORM_FIELD_TYPES) {
      const values = { ...complete };
      if (type === "checkbox") values[questionMap[type].id] = false;
      else if (type === "multiselect") values[questionMap[type].id] = [];
      else if (type === "number") delete values[questionMap[type].id];
      else values[questionMap[type].id] = "   ";

      await assert.rejects(
        submitBaseFormResponse({ token, clientSubmissionId: randomUUID(), values }),
        (error: unknown) =>
          isRequestError(error, new RegExp(`${type} question: This question is required`)),
      );
    }

    assert.deepEqual(await counts(detail.form.id), { records: 0, submissions: 0 });
  });

  test("omits optional empty answers but preserves meaningful false and zero values", async () => {
    const questionMap = questions(false);
    const { detail, token } = await publishForm(Object.values(questionMap), "Optional answers");
    const emptyValues: Record<string, PublicBaseFormValue> = {
      [questionMap.text.id]: "   ",
      [questionMap.longtext.id]: null,
      [questionMap.number.id]: null,
      [questionMap.checkbox.id]: null,
      [questionMap.date.id]: "",
      [questionMap.datetime.id]: null,
      [questionMap.email.id]: " ",
      [questionMap.url.id]: null,
      [questionMap.select.id]: "",
      [questionMap.multiselect.id]: [],
    };
    await submitBaseFormResponse({
      token,
      clientSubmissionId: randomUUID(),
      values: emptyValues,
    });
    await submitBaseFormResponse({
      token,
      clientSubmissionId: randomUUID(),
      values: {
        [questionMap.number.id]: 0,
        [questionMap.checkbox.id]: false,
      },
    });

    const rows = await AppDataSource.getRepository(BaseRecord).find({
      where: { tableId: table.id },
      order: { sortOrder: "ASC" },
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(JSON.parse(rows[0].dataJson), {});
    assert.deepEqual(JSON.parse(rows[1].dataJson), {
      [fields.number.id]: 0,
      [fields.checkbox.id]: false,
    });
    assert.deepEqual(await counts(detail.form.id), { records: 2, submissions: 2 });
  });

  test("rejects invalid scalar, calendar, address, URL, and choice values atomically", async () => {
    const questionMap = questions(false);
    const { detail, token } = await publishForm(Object.values(questionMap), "Invalid answers");
    const cases: Array<{
      type: PublicBaseFormFieldType;
      value: PublicBaseFormValue;
      message: RegExp;
    }> = [
      { type: "text", value: "x".repeat(2_001), message: /no longer than 2,000/ },
      { type: "longtext", value: "x".repeat(50_001), message: /no longer than 50,000/ },
      { type: "number", value: "42", message: /finite number/ },
      { type: "number", value: Number.POSITIVE_INFINITY, message: /finite number/ },
      { type: "number", value: Number.NaN, message: /finite number/ },
      { type: "checkbox", value: "true", message: /Choose yes or no/ },
      { type: "date", value: "2023-02-29", message: /valid date/ },
      { type: "date", value: "1900-02-29", message: /valid date/ },
      { type: "date", value: "2024-00-10", message: /valid date/ },
      { type: "date", value: "2024-04-31", message: /valid date/ },
      { type: "date", value: "2024-2-9", message: /valid date/ },
      { type: "datetime", value: "2024-02-30T12:00", message: /valid date and time/ },
      { type: "datetime", value: "2024-02-29 12:00", message: /valid date and time/ },
      { type: "datetime", value: "2024-02-29T24:00", message: /valid date and time/ },
      { type: "datetime", value: "2024-02-29T23:60", message: /valid date and time/ },
      { type: "datetime", value: "2024-02-29T23:59:60", message: /valid date and time/ },
      { type: "datetime", value: "2024-02-29T23:59:59.0000", message: /valid date and time/ },
      { type: "datetime", value: "2024-02-29T23:59Z", message: /valid date and time/ },
      { type: "email", value: "not-an-email", message: /valid email address/ },
      { type: "email", value: `${"a".repeat(310)}@example.com`, message: /valid email address/ },
      { type: "url", value: "/relative", message: /valid URL/ },
      { type: "url", value: "ftp://example.com", message: /http or https URL/ },
      { type: "url", value: "javascript:alert(1)", message: /http or https URL/ },
      {
        type: "url",
        value: `https://example.com/${"x".repeat(2_100)}`,
        message: /http or https URL/,
      },
      { type: "select", value: "enterprise", message: /available options/ },
      { type: "select", value: ["growth"], message: /available options/ },
      { type: "multiselect", value: "growth", message: /available options/ },
      {
        type: "multiselect",
        value: ["growth", "growth"],
        message: /available options/,
      },
      { type: "multiselect", value: ["missing"], message: /available options/ },
      {
        type: "multiselect",
        value: Array.from({ length: 101 }, (_, index) => `choice-${index}`),
        message: /available options/,
      },
    ];

    for (const invalid of cases) {
      await assert.rejects(
        submitBaseFormResponse({
          token,
          clientSubmissionId: randomUUID(),
          values: { [questionMap[invalid.type].id]: invalid.value },
        }),
        (error: unknown) => isRequestError(error, invalid.message),
        `${invalid.type}: ${String(invalid.value).slice(0, 80)}`,
      );
    }

    assert.deepEqual(await counts(detail.form.id), { records: 0, submissions: 0 });
  });

  test("rejects unknown question ids and the public route's strict response envelope", async () => {
    const questionMap = questions(false);
    const { detail, token } = await publishForm([questionMap.text], "Strict response body");
    await assert.rejects(
      submitBaseFormResponse({
        token,
        clientSubmissionId: randomUUID(),
        values: { [randomUUID()]: "unknown" },
      }),
      (error: unknown) => isRequestError(error, /unknown question/),
    );

    const payloads = [
      { submissionId: "not-a-uuid", values: {} },
      { submissionId: randomUUID(), values: {}, unexpected: true },
      { submissionId: randomUUID(), values: { "not-a-uuid": "answer" } },
      {
        submissionId: randomUUID(),
        values: Object.fromEntries(Array.from({ length: 101 }, () => [randomUUID(), "answer"])),
      },
      {
        submissionId: randomUUID(),
        values: { [questionMap.text.id]: "x".repeat(50_001) },
      },
    ];
    for (const payload of payloads) {
      const response = await publicCall("POST", `/api/forms/${token}/responses`, payload);
      assert.equal(response.status, 400);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    }
    assert.deepEqual(await counts(detail.form.id), { records: 0, submissions: 0 });
  });
});

describe("public Base Form availability and bearer privacy", () => {
  test("fails closed for draft, closed-write, archived, and malformed Forms", async () => {
    const questionMap = questions(false);
    const draft = await createBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: table.id,
      title: "Draft form",
      actorUserId: null,
    });
    const draftToken = tokenFromPublicUrl(draft.form.publicUrl);
    assert.equal(await resolvePublicBaseForm(draftToken), null);
    assert.equal((await publicCall("GET", `/api/forms/${draftToken}`)).status, 404);
    await assert.rejects(
      submitBaseFormResponse({
        token: draftToken,
        clientSubmissionId: randomUUID(),
        values: {},
      }),
      PublicBaseFormNotFoundError,
    );

    const { detail, token } = await publishForm([questionMap.text], "Availability form");
    await updateBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: table.id,
      formSlug: detail.form.slug,
      patch: { acceptingResponses: false },
      actorUserId: null,
    });
    const closed = await resolvePublicBaseForm(token);
    assert.ok(closed);
    assert.equal(publicBaseFormDto(closed).acceptingResponses, false);
    await assert.rejects(
      submitBaseFormResponse({
        token,
        clientSubmissionId: randomUUID(),
        values: {},
      }),
      PublicBaseFormClosedError,
    );

    await updateBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: table.id,
      formSlug: detail.form.slug,
      patch: { acceptingResponses: true },
      actorUserId: null,
    });
    table.archivedAt = new Date();
    await AppDataSource.getRepository(BaseTable).save(table);
    assert.equal(await resolvePublicBaseForm(token), null);
    await assert.rejects(
      submitBaseFormResponse({ token, clientSubmissionId: randomUUID(), values: {} }),
      PublicBaseFormNotFoundError,
    );

    table.archivedAt = null;
    await AppDataSource.getRepository(BaseTable).save(table);
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: detail.form.id,
    });
    stored.questionsJson = "{damaged";
    await AppDataSource.getRepository(BaseForm).save(stored);
    assert.equal(await resolvePublicBaseForm(token), null);
    assert.deepEqual(await counts(detail.form.id), { records: 0, submissions: 0 });
  });

  test("stores no plaintext bearer token and exposes no storage or tenant identifiers publicly", async () => {
    const questionMap = questions(false);
    const { detail, token } = await publishForm(
      [questionMap.text, questionMap.select],
      "Private bearer",
    );
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: detail.form.id,
    });
    assert.equal(stored.tokenHash, hashBaseFormToken(token));
    assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
    assert.notEqual(stored.tokenEncrypted, token);
    assert.equal(JSON.stringify(stored).includes(token), false);
    assert.equal(await baseFormTokenExists(token), true);
    assert.equal(await baseFormTokenExists(randomBytes(32).toString("base64url")), false);

    const context = await resolvePublicBaseForm(token);
    assert.ok(context);
    const dto = publicBaseFormDto(context);
    const serialized = JSON.stringify(dto);
    for (const privateValue of [
      token,
      stored.tokenHash,
      stored.tokenEncrypted,
      company.id,
      base.id,
      table.id,
      detail.form.id,
      fields.text.id,
      fields.select.id,
    ]) {
      assert.equal(serialized.includes(privateValue), false, privateValue);
    }
    assert.equal(serialized.includes(questionMap.text.id), true);
    assert.equal(serialized.includes(questionMap.select.id), true);

    const response = await publicCall<Record<string, unknown>>("GET", `/api/forms/${token}`);
    assert.equal(response.status, 200);
    assert.equal("token" in response.body, false);
    assert.equal("id" in response.body, false);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.equal(response.headers.get("pragma"), "no-cache");
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  });

  test("returns the same public 404 shape for random, draft, archived, and damaged links", async () => {
    const questionMap = questions(false);
    const draft = await createBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: table.id,
      title: "Hidden draft",
      actorUserId: null,
    });
    const { detail, token } = await publishForm([questionMap.text], "Hidden archived form");
    table.archivedAt = new Date();
    await AppDataSource.getRepository(BaseTable).save(table);

    const randomToken = randomBytes(32).toString("base64url");
    const draftResponse = await publicCall(
      "GET",
      `/api/forms/${tokenFromPublicUrl(draft.form.publicUrl)}`,
    );
    const archivedResponse = await publicCall("GET", `/api/forms/${token}`);

    table.archivedAt = null;
    await AppDataSource.getRepository(BaseTable).save(table);
    const stored = await AppDataSource.getRepository(BaseForm).findOneByOrFail({
      id: detail.form.id,
    });
    stored.questionsJson = "[]";
    await AppDataSource.getRepository(BaseForm).save(stored);
    const damagedResponse = await publicCall("GET", `/api/forms/${token}`);
    const randomResponse = await publicCall("GET", `/api/forms/${randomToken}`);

    for (const response of [draftResponse, archivedResponse, damagedResponse, randomResponse]) {
      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: "This form link is invalid or unavailable" });
    }
  });
});

describe("public Base Form idempotency, throttling, and atomicity", () => {
  test("deduplicates shared concurrent retries, permits distinct concurrent responses, and honors retries after close", async () => {
    const questionMap = questions(true);
    const { detail, token } = await publishForm([questionMap.text], "Concurrent form");
    const sharedSubmissionId = randomUUID();
    const shared = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        publicCall("POST", `/api/forms/${token}/responses`, {
          submissionId: sharedSubmissionId,
          values: { [questionMap.text.id]: `Shared answer ${index}` },
        }),
      ),
    );
    assert.ok(shared.every((response) => response.status === 200));

    const distinct = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        publicCall("POST", `/api/forms/${token}/responses`, {
          submissionId: randomUUID(),
          values: { [questionMap.text.id]: `Distinct answer ${index}` },
        }),
      ),
    );
    assert.ok(distinct.every((response) => response.status === 200));
    assert.deepEqual(await counts(detail.form.id), { records: 9, submissions: 9 });

    await updateBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: table.id,
      formSlug: detail.form.slug,
      patch: { acceptingResponses: false },
      actorUserId: null,
    });
    assert.deepEqual(
      await submitBaseFormResponse({
        token,
        clientSubmissionId: sharedSubmissionId,
        values: { [randomUUID()]: "A retry no longer needs to be revalidated" },
      }),
      { ok: true },
    );
    await assert.rejects(
      submitBaseFormResponse({
        token,
        clientSubmissionId: randomUUID(),
        values: { [questionMap.text.id]: "New response" },
      }),
      PublicBaseFormClosedError,
    );
    assert.deepEqual(await counts(detail.form.id), { records: 9, submissions: 9 });
    assert.equal(
      await AppDataSource.getRepository(AuditEvent).countBy({
        companyId: company.id,
        action: "form.submission.create",
      }),
      9,
    );
  });

  test("allows 30 new responses per minute, exempts a committed retry, and blocks the next new response", async () => {
    const questionMap = questions(true);
    const { detail, token } = await publishForm([questionMap.text], "Throttled form");
    const submissionIds: string[] = [];

    for (let index = 0; index < 30; index += 1) {
      const submissionId = randomUUID();
      submissionIds.push(submissionId);
      const response = await publicCall("POST", `/api/forms/${token}/responses`, {
        submissionId,
        values: { [questionMap.text.id]: `Response ${index + 1}` },
      });
      assert.equal(response.status, 200, `response ${index + 1}`);
    }

    const retry = await publicCall("POST", `/api/forms/${token}/responses`, {
      submissionId: submissionIds[0],
      values: { [questionMap.text.id]: "Ignored retry payload" },
    });
    assert.equal(retry.status, 200);

    const blocked = await publicCall<{ error: string }>("POST", `/api/forms/${token}/responses`, {
      submissionId: randomUUID(),
      values: { [questionMap.text.id]: "Thirty-first response" },
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "Too many responses. Try again shortly.");
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.deepEqual(await counts(detail.form.id), { records: 30, submissions: 30 });

    resetPublicFormSubmitThrottleForTests();
    const afterWindow = await publicCall("POST", `/api/forms/${token}/responses`, {
      submissionId: randomUUID(),
      values: { [questionMap.text.id]: "Response after a fresh window" },
    });
    assert.equal(afterWindow.status, 200);
    assert.deepEqual(await counts(detail.form.id), { records: 31, submissions: 31 });
  });

  test("rolls back the reserved lineage when row insertion fails, then safely accepts the retry", async () => {
    const questionMap = questions(true);
    const { detail, token } = await publishForm([questionMap.text], "Atomic form");
    const submissionId = randomUUID();
    await AppDataSource.query(`
      CREATE TRIGGER reject_public_form_row
      BEFORE INSERT ON base_records
      BEGIN
        SELECT RAISE(ABORT, 'forced Base row failure');
      END
    `);

    try {
      await assert.rejects(
        submitBaseFormResponse({
          token,
          clientSubmissionId: submissionId,
          values: { [questionMap.text.id]: "Should roll back" },
        }),
        /forced Base row failure/,
      );
      assert.deepEqual(await counts(detail.form.id), { records: 0, submissions: 0 });
      assert.equal(
        await AppDataSource.getRepository(AuditEvent).countBy({
          companyId: company.id,
          action: "form.submission.create",
        }),
        0,
      );
    } finally {
      await AppDataSource.query("DROP TRIGGER IF EXISTS reject_public_form_row");
    }

    assert.deepEqual(
      await submitBaseFormResponse({
        token,
        clientSubmissionId: submissionId,
        values: { [questionMap.text.id]: "Committed after rollback" },
      }),
      { ok: true },
    );
    assert.deepEqual(await counts(detail.form.id), { records: 1, submissions: 1 });
  });
});

describe("public Base Form deletion cleanup", () => {
  test("removes lineage with rows, retains rows with deleted Forms, and clears everything with its table", async () => {
    const questionMap = questions(true);
    const first = await publishForm([questionMap.text], "Row cleanup form");
    await submitBaseFormResponse({
      token: first.token,
      clientSubmissionId: randomUUID(),
      values: { [questionMap.text.id]: "Delete this row" },
    });
    const firstRow = await AppDataSource.getRepository(BaseRecord).findOneByOrFail({
      tableId: table.id,
    });
    await deleteBaseRecordWithContents(firstRow, company.id);
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({
        formId: first.detail.form.id,
      }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(BaseForm).countBy({ id: first.detail.form.id }),
      1,
    );

    await submitBaseFormResponse({
      token: first.token,
      clientSubmissionId: randomUUID(),
      values: { [questionMap.text.id]: "Keep this Base row" },
    });
    await deleteBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: table.id,
      formSlug: first.detail.form.slug,
      actorUserId: null,
    });
    assert.equal(
      await AppDataSource.getRepository(BaseForm).countBy({ id: first.detail.form.id }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({
        formId: first.detail.form.id,
      }),
      0,
    );
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 1);

    const nextQuestion = questions(true).text;
    const second = await publishForm([nextQuestion], "Table cleanup form");
    await submitBaseFormResponse({
      token: second.token,
      clientSubmissionId: randomUUID(),
      values: { [nextQuestion.id]: "Delete this whole table" },
    });

    const siblingTable = await insert(BaseTable, {
      baseId: base.id,
      name: "Sibling responses",
      slug: "sibling-responses",
      sortOrder: 2_000,
      archivedAt: null,
    });
    const siblingField = await insert(BaseField, {
      tableId: siblingTable.id,
      name: "Sibling answer",
      type: "text",
      configJson: "{}",
      isPrimary: true,
      sortOrder: 1_000,
    });
    const siblingQuestion: BaseFormQuestion = {
      id: randomUUID(),
      fieldId: siblingField.id,
      label: "Sibling question",
      description: "",
      required: true,
    };
    const siblingDraft = await createBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: siblingTable.id,
      title: "Sibling form",
      actorUserId: null,
    });
    const siblingForm = await updateBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: siblingTable.id,
      formSlug: siblingDraft.form.slug,
      patch: { questions: [siblingQuestion], published: true },
      actorUserId: null,
    });
    await submitBaseFormResponse({
      token: tokenFromPublicUrl(siblingForm.form.publicUrl),
      clientSubmissionId: randomUUID(),
      values: { [siblingQuestion.id]: "Keep the neighboring table" },
    });

    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 2);
    await deleteBaseTableWithContents(table, company.slug);

    assert.equal(await AppDataSource.getRepository(BaseTable).countBy({ id: table.id }), 0);
    assert.equal(await AppDataSource.getRepository(BaseField).countBy({ tableId: table.id }), 0);
    assert.equal(await AppDataSource.getRepository(BaseForm).countBy({ tableId: table.id }), 0);
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({
        formId: second.detail.form.id,
      }),
      0,
    );
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({ companyId: company.id }),
      1,
    );
    assert.equal(await AppDataSource.getRepository(BaseRecord).countBy({ tableId: table.id }), 0);
    assert.equal(await AppDataSource.getRepository(BaseTable).countBy({ id: siblingTable.id }), 1);
    assert.equal(await AppDataSource.getRepository(BaseField).countBy({ id: siblingField.id }), 1);
    assert.equal(
      await AppDataSource.getRepository(BaseForm).countBy({ id: siblingForm.form.id }),
      1,
    );
    assert.equal(
      await AppDataSource.getRepository(BaseFormSubmission).countBy({
        formId: siblingForm.form.id,
      }),
      1,
    );
    assert.equal(
      await AppDataSource.getRepository(BaseRecord).countBy({ tableId: siblingTable.id }),
      1,
    );
  });
});
