import crypto from "node:crypto";

import { EntityManager } from "typeorm";
import { z } from "zod";

import { AppDataSource } from "../db/datasource.js";
import { Base } from "../db/entities/Base.js";
import { BaseField, type BaseFieldType } from "../db/entities/BaseField.js";
import { BaseForm } from "../db/entities/BaseForm.js";
import { BaseFormSubmission } from "../db/entities/BaseFormSubmission.js";
import { BaseTable } from "../db/entities/BaseTable.js";
import { Company } from "../db/entities/Company.js";
import { decryptSecret, encryptSecret } from "../lib/secret.js";
import { toSlug } from "../lib/slug.js";
import { createBaseRecordRow, hydrateField, safeBaseSelectOptions } from "./bases.js";
import { recordAudit } from "./audit.js";
import { getPublicUrl, isPublicUrlConfigured } from "./publicUrl.js";

export const PUBLIC_BASE_FORM_FIELD_TYPES = [
  "text",
  "longtext",
  "number",
  "checkbox",
  "date",
  "datetime",
  "email",
  "url",
  "select",
  "multiselect",
] as const satisfies readonly BaseFieldType[];

export type PublicBaseFormFieldType = (typeof PUBLIC_BASE_FORM_FIELD_TYPES)[number];

export const baseFormQuestionSchema = z
  .object({
    id: z.string().uuid(),
    fieldId: z.string().uuid(),
    label: z.string().trim().min(1).max(200),
    description: z.string().max(2_000),
    required: z.boolean(),
  })
  .strict();

export const baseFormQuestionsSchema = z
  .array(baseFormQuestionSchema)
  .max(100)
  .superRefine((questions, ctx) => {
    const questionIds = new Set<string>();
    const fieldIds = new Set<string>();
    for (const [index, question] of questions.entries()) {
      if (questionIds.has(question.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "id"],
          message: "Question ids must be unique",
        });
      }
      if (fieldIds.has(question.fieldId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "fieldId"],
          message: "A Base field can only appear once in a Form",
        });
      }
      questionIds.add(question.id);
      fieldIds.add(question.fieldId);
    }
  });

export type BaseFormQuestion = z.infer<typeof baseFormQuestionSchema>;

export type PublicBaseFormValue = string | number | boolean | string[] | null;

export type BaseFormPatch = {
  title?: string;
  description?: string;
  submitLabel?: string;
  successTitle?: string;
  successMessage?: string;
  allowAnotherResponse?: boolean;
  published?: boolean;
  acceptingResponses?: boolean;
  questions?: BaseFormQuestion[];
};

export class BaseFormRequestError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "BaseFormRequestError";
  }
}

/** Public callers intentionally receive one response for every unusable link. */
export class PublicBaseFormNotFoundError extends Error {
  constructor() {
    super("This form link is invalid or unavailable");
    this.name = "PublicBaseFormNotFoundError";
  }
}

export class PublicBaseFormClosedError extends Error {
  constructor() {
    super("This form is not accepting responses");
    this.name = "PublicBaseFormClosedError";
  }
}

type FormScope = {
  company: Company;
  base: Base;
  table: BaseTable;
};

type PublicFormContext = FormScope & {
  form: BaseForm;
  questions: BaseFormQuestion[];
  fieldsById: Map<string, BaseField>;
};

function managerOrDefault(manager?: EntityManager): EntityManager {
  return manager ?? AppDataSource.manager;
}

function parseQuestions(value: string): BaseFormQuestion[] | null {
  try {
    const parsed = baseFormQuestionsSchema.safeParse(JSON.parse(value || "[]"));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function isPublicFieldType(type: BaseFieldType): type is PublicBaseFormFieldType {
  return (PUBLIC_BASE_FORM_FIELD_TYPES as readonly string[]).includes(type);
}

function validateQuestionFields(
  questions: BaseFormQuestion[],
  fields: BaseField[],
  options: { requireQuestion: boolean },
): Map<string, BaseField> {
  if (options.requireQuestion && questions.length === 0) {
    throw new BaseFormRequestError(400, "Add at least one question before publishing");
  }
  const available = new Map(fields.map((field) => [field.id, field]));
  const result = new Map<string, BaseField>();
  for (const question of questions) {
    const field = available.get(question.fieldId);
    if (!field) {
      throw new BaseFormRequestError(400, `Question "${question.label}" uses a missing field`);
    }
    if (!isPublicFieldType(field.type)) {
      throw new BaseFormRequestError(
        400,
        `Question "${question.label}" uses a field type that cannot be public`,
      );
    }
    if (
      options.requireQuestion &&
      question.required &&
      (field.type === "select" || field.type === "multiselect") &&
      safeBaseSelectOptions(field).length === 0
    ) {
      throw new BaseFormRequestError(
        400,
        `Question "${question.label}" needs at least one choice before publishing`,
      );
    }
    result.set(question.id, field);
  }
  return result;
}

async function loadScope(
  companyId: string,
  baseSlug: string,
  tableId: string,
  manager?: EntityManager,
): Promise<FormScope> {
  const m = managerOrDefault(manager);
  const [company, base] = await Promise.all([
    m.getRepository(Company).findOneBy({ id: companyId }),
    m.getRepository(Base).findOneBy({ companyId, slug: baseSlug }),
  ]);
  if (!company || !base) throw new BaseFormRequestError(404, "Base not found");
  const table = await m.getRepository(BaseTable).findOneBy({ id: tableId, baseId: base.id });
  if (!table) throw new BaseFormRequestError(404, "Table not found");
  return { company, base, table };
}

async function loadMemberForm(
  companyId: string,
  baseSlug: string,
  tableId: string,
  formSlug: string,
  manager?: EntityManager,
): Promise<FormScope & { form: BaseForm }> {
  const m = managerOrDefault(manager);
  const scope = await loadScope(companyId, baseSlug, tableId, m);
  const form = await m.getRepository(BaseForm).findOneBy({
    companyId,
    tableId: scope.table.id,
    slug: formSlug,
  });
  if (!form) throw new BaseFormRequestError(404, "Form not found");
  return { ...scope, form };
}

async function fieldsForTable(tableId: string, manager?: EntityManager): Promise<BaseField[]> {
  return managerOrDefault(manager)
    .getRepository(BaseField)
    .find({
      where: { tableId },
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
}

export function generateBaseFormToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashBaseFormToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function tokenColumns(companyId: string): { tokenHash: string; tokenEncrypted: string } {
  const token = generateBaseFormToken();
  return {
    tokenHash: hashBaseFormToken(token),
    tokenEncrypted: encryptSecret(token, `company:${companyId}`),
  };
}

const BASE_FORM_SLUG_UNIQUE_INDEX = "IDX_317e303d475dabbcaa53845bb2";
const BASE_FORM_CREATE_MAX_ATTEMPTS = 50;

/**
 * TypeORM leaves constraint failures in each driver's native shape. Only the
 * `(tableId, slug)` collision is expected here: a concurrent create may pick
 * the same available suffix between our lookup and insert. Keep token-hash or
 * unrelated database failures out of the retry path.
 */
function isBaseFormSlugConflict(error: unknown): boolean {
  const codes: string[] = [];
  const messages: string[] = [];
  const constraints: string[] = [];
  const seen = new Set<object>();

  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const candidate = value as {
      code?: unknown;
      errno?: unknown;
      message?: unknown;
      constraint?: unknown;
      driverError?: unknown;
      cause?: unknown;
    };
    for (const code of [candidate.code, candidate.errno]) {
      if (typeof code === "string" || typeof code === "number") {
        codes.push(String(code).toUpperCase());
      }
    }
    if (typeof candidate.message === "string") {
      messages.push(candidate.message.toUpperCase());
    }
    if (typeof candidate.constraint === "string") {
      constraints.push(candidate.constraint.toUpperCase());
    }
    collect(candidate.driverError);
    collect(candidate.cause);
  };
  collect(error);

  const uniqueViolation =
    codes.some(
      (code) => code === "23505" || code === "2067" || code.startsWith("SQLITE_CONSTRAINT"),
    ) ||
    messages.some(
      (message) => message.includes("UNIQUE CONSTRAINT") || message.includes("DUPLICATE KEY"),
    );
  if (!uniqueViolation) return false;

  const index = BASE_FORM_SLUG_UNIQUE_INDEX.toUpperCase();
  return (
    constraints.includes(index) ||
    messages.some(
      (message) =>
        message.includes(index) ||
        (message.includes("BASE_FORMS.TABLEID") && message.includes("BASE_FORMS.SLUG")),
    )
  );
}

async function uniqueFormSlug(tableId: string, title: string): Promise<string> {
  const repo = AppDataSource.getRepository(BaseForm);
  const maxLength = 120;
  const seed = toSlug(title).slice(0, maxLength).replace(/-+$/, "") || "form";
  let slug = seed;
  let suffix = 1;
  while (await repo.findOneBy({ tableId, slug })) {
    suffix += 1;
    const tail = `-${suffix}`;
    const prefix = seed.slice(0, maxLength - tail.length).replace(/-+$/, "") || "form";
    slug = `${prefix}${tail}`;
  }
  return slug;
}

function memberPublicUrl(form: BaseForm): string | null {
  try {
    const token = decryptSecret(form.tokenEncrypted);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    if (hashBaseFormToken(token) !== form.tokenHash) return null;
    return `${getPublicUrl()}/forms/${token}`;
  } catch {
    // A damaged credential fails closed. Regenerating the link repairs it.
    return null;
  }
}

async function memberFormDto(form: BaseForm, manager?: EntityManager) {
  const m = managerOrDefault(manager);
  const [responseCount, lastResponse] = await Promise.all([
    m.getRepository(BaseFormSubmission).countBy({ formId: form.id }),
    m.getRepository(BaseFormSubmission).findOne({
      where: { formId: form.id },
      order: { createdAt: "DESC" },
    }),
  ]);
  return {
    id: form.id,
    tableId: form.tableId,
    slug: form.slug,
    title: form.title,
    description: form.description,
    submitLabel: form.submitLabel,
    successTitle: form.successTitle,
    successMessage: form.successMessage,
    allowAnotherResponse: form.allowAnotherResponse,
    publishedAt: form.publishedAt?.toISOString() ?? null,
    acceptingResponses: form.acceptingResponses,
    publicUrl: memberPublicUrl(form),
    publicUrlConfigured: isPublicUrlConfigured(),
    responseCount,
    lastResponseAt: lastResponse?.createdAt.toISOString() ?? null,
    questions: parseQuestions(form.questionsJson) ?? [],
    createdAt: form.createdAt.toISOString(),
    updatedAt: form.updatedAt.toISOString(),
  };
}

async function memberDetail(scope: FormScope, form: BaseForm, manager?: EntityManager) {
  const fields = await fieldsForTable(scope.table.id, manager);
  return {
    form: await memberFormDto(form, manager),
    fields: fields.map(hydrateField),
  };
}

export async function listBaseForms(args: {
  companyId: string;
  baseSlug: string;
  tableId: string;
}) {
  const scope = await loadScope(args.companyId, args.baseSlug, args.tableId);
  const forms = await AppDataSource.getRepository(BaseForm).find({
    where: { companyId: args.companyId, tableId: scope.table.id },
    order: { createdAt: "DESC" },
  });
  return Promise.all(
    forms.map(async (form) => {
      const { questions: _questions, ...summary } = await memberFormDto(form);
      return summary;
    }),
  );
}

export async function createBaseForm(args: {
  companyId: string;
  baseSlug: string;
  tableId: string;
  title: string;
  actorUserId: string | null;
}) {
  const scope = await loadScope(args.companyId, args.baseSlug, args.tableId);
  if (scope.table.archivedAt) {
    throw new BaseFormRequestError(409, "Restore this table before creating a Form");
  }
  const repo = AppDataSource.getRepository(BaseForm);
  let form: BaseForm | null = null;
  for (let attempt = 0; attempt < BASE_FORM_CREATE_MAX_ATTEMPTS; attempt += 1) {
    try {
      form = await repo.save(
        repo.create({
          companyId: args.companyId,
          tableId: scope.table.id,
          slug: await uniqueFormSlug(scope.table.id, args.title),
          title: args.title,
          description: "",
          submitLabel: "Submit",
          successTitle: "Response submitted",
          successMessage: "Thanks for your response.",
          allowAnotherResponse: false,
          questionsJson: "[]",
          publishedAt: null,
          acceptingResponses: true,
          ...tokenColumns(args.companyId),
          createdById: args.actorUserId,
        }),
      );
      break;
    } catch (error) {
      if (!isBaseFormSlugConflict(error)) throw error;
      // The winning insert committed a real slug. Re-read the first available
      // suffix and try again; every retry remains bounded by uniqueFormSlug.
      if (attempt === BASE_FORM_CREATE_MAX_ATTEMPTS - 1) {
        throw new BaseFormRequestError(
          409,
          "Several Forms were created at the same time. Try again.",
        );
      }
    }
  }
  if (!form) {
    throw new BaseFormRequestError(409, "Several Forms were created at the same time. Try again.");
  }
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    action: "form.create",
    targetType: "base_form",
    targetId: form.id,
    targetLabel: form.title,
    metadata: { baseId: scope.base.id, tableId: scope.table.id },
  });
  return memberDetail(scope, form);
}

export async function getBaseForm(args: {
  companyId: string;
  baseSlug: string;
  tableId: string;
  formSlug: string;
}) {
  const { form, ...scope } = await loadMemberForm(
    args.companyId,
    args.baseSlug,
    args.tableId,
    args.formSlug,
  );
  return memberDetail(scope, form);
}

export async function updateBaseForm(args: {
  companyId: string;
  baseSlug: string;
  tableId: string;
  formSlug: string;
  patch: BaseFormPatch;
  actorUserId: string | null;
}) {
  const { form, ...scope } = await loadMemberForm(
    args.companyId,
    args.baseSlug,
    args.tableId,
    args.formSlug,
  );
  const fields = await fieldsForTable(scope.table.id);
  const currentQuestions = parseQuestions(form.questionsJson);
  const questions = args.patch.questions ?? currentQuestions;
  if (!questions) throw new BaseFormRequestError(409, "This Form's questions are damaged");

  const remainsPublished = args.patch.published ?? form.publishedAt !== null;
  if (args.patch.questions !== undefined || args.patch.published === true) {
    validateQuestionFields(questions, fields, { requireQuestion: remainsPublished });
  }
  if (args.patch.published === true && scope.table.archivedAt) {
    throw new BaseFormRequestError(409, "Restore this table before publishing its Form");
  }

  const changes: string[] = [];
  if (args.patch.title !== undefined && args.patch.title !== form.title) changes.push("title");
  if (args.patch.description !== undefined && args.patch.description !== form.description) {
    changes.push("description");
  }
  if (args.patch.submitLabel !== undefined && args.patch.submitLabel !== form.submitLabel) {
    changes.push("submitLabel");
  }
  if (args.patch.successTitle !== undefined && args.patch.successTitle !== form.successTitle) {
    changes.push("successTitle");
  }
  if (
    args.patch.successMessage !== undefined &&
    args.patch.successMessage !== form.successMessage
  ) {
    changes.push("successMessage");
  }
  if (
    args.patch.allowAnotherResponse !== undefined &&
    args.patch.allowAnotherResponse !== form.allowAnotherResponse
  ) {
    changes.push("allowAnotherResponse");
  }
  if (
    args.patch.questions !== undefined &&
    JSON.stringify(args.patch.questions) !== JSON.stringify(currentQuestions)
  ) {
    changes.push("questions");
  }
  if (args.patch.published !== undefined && args.patch.published !== (form.publishedAt !== null)) {
    changes.push(args.patch.published ? "publish" : "unpublish");
  }
  if (
    args.patch.acceptingResponses !== undefined &&
    args.patch.acceptingResponses !== form.acceptingResponses
  ) {
    changes.push(args.patch.acceptingResponses ? "reopen" : "close");
  }

  if (args.patch.title !== undefined) form.title = args.patch.title;
  if (args.patch.description !== undefined) form.description = args.patch.description;
  if (args.patch.submitLabel !== undefined) form.submitLabel = args.patch.submitLabel;
  if (args.patch.successTitle !== undefined) form.successTitle = args.patch.successTitle;
  if (args.patch.successMessage !== undefined) form.successMessage = args.patch.successMessage;
  if (args.patch.allowAnotherResponse !== undefined) {
    form.allowAnotherResponse = args.patch.allowAnotherResponse;
  }
  if (args.patch.acceptingResponses !== undefined) {
    form.acceptingResponses = args.patch.acceptingResponses;
  }
  if (args.patch.questions !== undefined) form.questionsJson = JSON.stringify(questions);
  if (args.patch.published === true && !form.publishedAt) form.publishedAt = new Date();
  if (args.patch.published === false) form.publishedAt = null;

  await AppDataSource.getRepository(BaseForm).save(form);
  if (changes.length > 0) {
    await recordAudit({
      companyId: args.companyId,
      actorUserId: args.actorUserId,
      action: "form.update",
      targetType: "base_form",
      targetId: form.id,
      targetLabel: form.title,
      metadata: {
        baseId: scope.base.id,
        tableId: scope.table.id,
        changes,
        published: form.publishedAt !== null,
        acceptingResponses: form.acceptingResponses,
      },
    });
  }
  return memberDetail(scope, form);
}

export async function deleteBaseForm(args: {
  companyId: string;
  baseSlug: string;
  tableId: string;
  formSlug: string;
  actorUserId: string | null;
}): Promise<void> {
  const { form, base, table } = await loadMemberForm(
    args.companyId,
    args.baseSlug,
    args.tableId,
    args.formSlug,
  );
  await AppDataSource.transaction(async (manager) => {
    await manager.delete(BaseFormSubmission, { formId: form.id });
    await manager.delete(BaseForm, { id: form.id, companyId: args.companyId });
  });
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    action: "form.delete",
    targetType: "base_form",
    targetId: form.id,
    targetLabel: form.title,
    metadata: { baseId: base.id, tableId: table.id },
  });
}

export async function rotateBaseFormLink(args: {
  companyId: string;
  baseSlug: string;
  tableId: string;
  formSlug: string;
  actorUserId: string | null;
}) {
  const { form, ...scope } = await loadMemberForm(
    args.companyId,
    args.baseSlug,
    args.tableId,
    args.formSlug,
  );
  Object.assign(form, tokenColumns(args.companyId));
  await AppDataSource.getRepository(BaseForm).save(form);
  await recordAudit({
    companyId: args.companyId,
    actorUserId: args.actorUserId,
    action: "form.public_link.rotate",
    targetType: "base_form",
    targetId: form.id,
    targetLabel: form.title,
    metadata: { baseId: scope.base.id, tableId: scope.table.id },
  });
  return memberDetail(scope, form);
}

async function loadPublicFormContext(
  token: string,
  manager?: EntityManager,
): Promise<PublicFormContext | null> {
  const m = managerOrDefault(manager);
  const form = await m.getRepository(BaseForm).findOneBy({ tokenHash: hashBaseFormToken(token) });
  if (!form?.publishedAt) return null;
  const table = await m.getRepository(BaseTable).findOneBy({ id: form.tableId });
  if (!table || table.archivedAt) return null;
  const base = await m.getRepository(Base).findOneBy({ id: table.baseId });
  if (!base || base.companyId !== form.companyId) return null;
  const company = await m.getRepository(Company).findOneBy({ id: form.companyId });
  if (!company) return null;
  const questions = parseQuestions(form.questionsJson);
  if (!questions) return null;
  const fields = await fieldsForTable(table.id, m);
  let fieldsById: Map<string, BaseField>;
  try {
    fieldsById = validateQuestionFields(questions, fields, { requireQuestion: true });
  } catch {
    return null;
  }
  return { form, company, base, table, questions, fieldsById };
}

export async function resolvePublicBaseForm(token: string): Promise<PublicFormContext | null> {
  return loadPublicFormContext(token);
}

/**
 * Distinguish a real but currently unavailable Form from a random bearer-token
 * probe without changing the intentionally generic public response.
 */
export async function baseFormTokenExists(
  token: string,
  manager?: EntityManager,
): Promise<boolean> {
  return (
    (await managerOrDefault(manager)
      .getRepository(BaseForm)
      .countBy({ tokenHash: hashBaseFormToken(token) })) > 0
  );
}

export function publicBaseFormDto(context: PublicFormContext) {
  return {
    companyName: context.company.name,
    color: context.base.color,
    title: context.form.title,
    description: context.form.description,
    submitLabel: context.form.submitLabel,
    successTitle: context.form.successTitle,
    successMessage: context.form.successMessage,
    allowAnotherResponse: context.form.allowAnotherResponse,
    acceptingResponses: context.form.acceptingResponses,
    questions: context.questions.map((question) => {
      const field = context.fieldsById.get(question.id)!;
      return {
        id: question.id,
        label: question.label,
        description: question.description,
        required: question.required,
        type: field.type as PublicBaseFormFieldType,
        options: safeBaseSelectOptions(field),
      };
    }),
  };
}

function invalidAnswer(question: BaseFormQuestion, detail: string): BaseFormRequestError {
  return new BaseFormRequestError(400, `${question.label}: ${detail}`);
}

function requiredValuePresent(
  type: PublicBaseFormFieldType,
  value: PublicBaseFormValue | undefined,
): boolean {
  if (type === "checkbox") return value === true;
  if (type === "multiselect") return Array.isArray(value) && value.length > 0;
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string" && value.trim().length > 0;
}

function validCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysByMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysByMonth[month - 1];
}

/** Browser `datetime-local`: date + T + minute, with optional seconds/fraction. */
function validLocalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(
    value,
  );
  if (!match) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  return (
    validCalendarDate(`${match[1]}-${match[2]}-${match[3]}`) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59
  );
}

function normalizeAnswers(
  context: PublicFormContext,
  values: Record<string, PublicBaseFormValue>,
): Record<string, unknown> {
  const questionsById = new Map(context.questions.map((question) => [question.id, question]));
  for (const key of Object.keys(values)) {
    if (!questionsById.has(key)) {
      throw new BaseFormRequestError(400, "The response contains an unknown question");
    }
  }

  const data: Record<string, unknown> = {};
  for (const question of context.questions) {
    const field = context.fieldsById.get(question.id)!;
    const type = field.type as PublicBaseFormFieldType;
    const value = values[question.id];
    if (question.required && !requiredValuePresent(type, value)) {
      throw invalidAnswer(question, "This question is required");
    }
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;

    switch (type) {
      case "text":
        if (typeof value !== "string" || value.length > 2_000) {
          throw invalidAnswer(question, "Enter text no longer than 2,000 characters");
        }
        data[field.id] = value;
        break;
      case "longtext":
        if (typeof value !== "string" || value.length > 50_000) {
          throw invalidAnswer(question, "Enter text no longer than 50,000 characters");
        }
        data[field.id] = value;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) {
          throw invalidAnswer(question, "Enter a finite number");
        }
        data[field.id] = value;
        break;
      case "checkbox":
        if (typeof value !== "boolean") throw invalidAnswer(question, "Choose yes or no");
        data[field.id] = value;
        break;
      case "date": {
        if (typeof value !== "string" || !validCalendarDate(value.trim())) {
          throw invalidAnswer(question, "Enter a valid date");
        }
        data[field.id] = value.trim();
        break;
      }
      case "datetime": {
        const candidate = typeof value === "string" ? value : "";
        if (!validLocalDateTime(candidate)) {
          throw invalidAnswer(question, "Enter a valid date and time");
        }
        data[field.id] = candidate;
        break;
      }
      case "email": {
        const candidate = typeof value === "string" ? value.trim() : "";
        if (candidate.length > 320 || !z.string().email().safeParse(candidate).success) {
          throw invalidAnswer(question, "Enter a valid email address");
        }
        data[field.id] = candidate;
        break;
      }
      case "url": {
        const candidate = typeof value === "string" ? value.trim() : "";
        let url: URL;
        try {
          url = new URL(candidate);
        } catch {
          throw invalidAnswer(question, "Enter a valid URL");
        }
        if (candidate.length > 2_048 || (url.protocol !== "http:" && url.protocol !== "https:")) {
          throw invalidAnswer(question, "Enter an http or https URL");
        }
        data[field.id] = candidate;
        break;
      }
      case "select": {
        const optionIds = new Set(safeBaseSelectOptions(field).map((option) => option.id));
        if (typeof value !== "string" || !optionIds.has(value)) {
          throw invalidAnswer(question, "Choose one of the available options");
        }
        data[field.id] = value;
        break;
      }
      case "multiselect": {
        const optionIds = new Set(safeBaseSelectOptions(field).map((option) => option.id));
        if (
          !Array.isArray(value) ||
          value.length > 100 ||
          new Set(value).size !== value.length ||
          value.some((item) => typeof item !== "string" || !optionIds.has(item))
        ) {
          throw invalidAnswer(question, "Choose only the available options");
        }
        data[field.id] = value;
        break;
      }
    }
  }
  return data;
}

type SubmitResult = {
  created: boolean;
  companyId: string;
  formId: string;
  tableId: string;
  recordId: string;
  fieldCount: number;
};

async function existingSubmissionResult(
  form: BaseForm,
  clientSubmissionId: string,
  manager?: EntityManager,
): Promise<SubmitResult | null> {
  const existing = await managerOrDefault(manager).getRepository(BaseFormSubmission).findOneBy({
    formId: form.id,
    clientSubmissionId,
  });
  if (!existing) return null;
  return {
    created: false,
    companyId: form.companyId,
    formId: form.id,
    tableId: form.tableId,
    recordId: existing.recordId,
    fieldCount: 0,
  };
}

/**
 * Public-route idempotency preflight. A closed Form still honors a retry of a
 * response that already committed, before applying the new-response throttle
 * or returning the closed-state conflict. The transaction repeats this check
 * so the preflight is never relied on for write integrity.
 */
export async function baseFormResponseExists(
  formId: string,
  clientSubmissionId: string,
): Promise<boolean> {
  return (
    (await AppDataSource.getRepository(BaseFormSubmission).countBy({
      formId,
      clientSubmissionId,
    })) > 0
  );
}

export async function submitBaseFormResponse(args: {
  token: string;
  clientSubmissionId: string;
  values: Record<string, PublicBaseFormValue>;
}): Promise<{ ok: true }> {
  let result: SubmitResult;
  try {
    result = await AppDataSource.transaction(async (manager) => {
      const context = await loadPublicFormContext(args.token, manager);
      if (!context) throw new PublicBaseFormNotFoundError();

      const existing = await existingSubmissionResult(
        context.form,
        args.clientSubmissionId,
        manager,
      );
      if (existing) return existing;
      if (!context.form.acceptingResponses) throw new PublicBaseFormClosedError();

      const data = normalizeAnswers(context, args.values);
      // Reserve the idempotency key before inserting the BaseRecord. A losing
      // concurrent retry then rolls back without even emitting a transient
      // BaseRecord change event from a row that cannot commit.
      const recordId = crypto.randomUUID();
      const submissions = manager.getRepository(BaseFormSubmission);
      await submissions.save(
        submissions.create({
          companyId: context.company.id,
          formId: context.form.id,
          recordId,
          clientSubmissionId: args.clientSubmissionId,
        }),
      );
      const record = await createBaseRecordRow(context.table.id, data, manager, recordId);
      return {
        created: true,
        companyId: context.company.id,
        formId: context.form.id,
        tableId: context.table.id,
        recordId: record.id,
        fieldCount: Object.keys(data).length,
      };
    });
  } catch (error) {
    // Concurrent retries race only at the unique idempotency index. The losing
    // transaction rolls its BaseRecord back; after the winner commits, return
    // the same successful outcome instead of surfacing a driver-specific 500.
    const form = await AppDataSource.getRepository(BaseForm).findOneBy({
      tokenHash: hashBaseFormToken(args.token),
    });
    const existing = form ? await existingSubmissionResult(form, args.clientSubmissionId) : null;
    if (!existing) throw error;
    result = existing;
  }

  if (result.created) {
    await recordAudit({
      companyId: result.companyId,
      actorKind: "webhook",
      action: "form.submission.create",
      targetType: "base_record",
      targetId: result.recordId,
      targetLabel: "Form response",
      metadata: {
        formId: result.formId,
        tableId: result.tableId,
        fieldCount: result.fieldCount,
      },
    });
  }
  return { ok: true };
}
