import { In } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import { Membership } from "../../db/entities/Membership.js";
import { RecruitingApplication } from "../../db/entities/RecruitingApplication.js";
import { RecruitingOpening, type CriteriaSource } from "../../db/entities/RecruitingOpening.js";
import type { RecruitingSettings } from "../../db/entities/RecruitingSettings.js";
import { User } from "../../db/entities/User.js";
import { toSlug } from "../../lib/slug.js";
import {
  COMPENSATION_PERIODS,
  RECRUITING_ACTIVE_STAGES,
  RECRUITING_STAGES,
  criteriaFingerprint,
  formatCompensation,
  type CompensationPeriod,
  type EmploymentType,
  type OpeningStatus,
  type OpeningVisibility,
  type RecruitingStage,
  type WorkplaceType,
} from "../../../shared/recruiting.js";
import { andWhereTokens, tokenizeQuery } from "../likeSearch.js";
import {
  filterFingerprint,
  keysetPage,
  type Page,
  type PageLimits,
  type PageRequest,
} from "../listPaging.js";
import { emitResourceChange } from "../resourceEvents.js";
import {
  mergeForm,
  normalizeCriteria,
  normalizeQuestions,
  parseCriteria,
  parseForm,
  parseQuestions,
  type CriterionInput,
  type FormInput,
  type QuestionInput,
} from "./content.js";
import {
  RecruitingConflictError,
  RecruitingNotFoundError,
  RecruitingValidationError,
} from "./errors.js";
import { assertCompanyEmployee, employeeRef, findRecruitingSettings } from "./settings.js";
import { openingPublicUrl } from "./urls.js";

/**
 * Openings: drafting, editing, publishing and closing the roles a company
 * hires for, and the shapes the App and the AI tools read them in.
 */

export type RecruitingActor =
  | { kind: "member"; userId: string; name?: string }
  | { kind: "employee"; employeeId: string; name?: string }
  | { kind: "system"; name?: string };

export type CompensationInput = {
  min: number | null;
  max: number | null;
  currency: string;
  period: CompensationPeriod;
};

export type OpeningInput = {
  title?: string;
  summary?: string;
  description?: string;
  department?: string;
  location?: string;
  workplace?: WorkplaceType;
  employmentType?: EmploymentType;
  visibility?: OpeningVisibility;
  compensation?: CompensationInput | null;
  headcount?: number;
  applyBy?: string | null;
  screenerEmployeeId?: string | null;
  ownerUserId?: string | null;
  criteria?: CriterionInput[];
  questions?: QuestionInput[];
  form?: FormInput;
};

/** Paths a slug may not take, because the careers site routes them itself. */
const RESERVED_OPENING_SLUGS = new Set(["new", "feed", "sitemap", "apply", "api", "assets"]);

async function uniqueOpeningSlug(companyId: string, title: string): Promise<string> {
  const root = (toSlug(title) || "opening").slice(0, 80);
  const repo = AppDataSource.getRepository(RecruitingOpening);
  let slug = RESERVED_OPENING_SLUGS.has(root) ? `${root}-opening` : root;
  let n = 1;
  while (await repo.exists({ where: { companyId, slug } })) {
    n += 1;
    slug = `${root}-${n}`;
  }
  return slug;
}

function toMinor(amount: number | null, field: string): number | null {
  if (amount === null) return null;
  if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000_000) {
    throw new RecruitingValidationError(`${field} must be a positive amount.`);
  }
  return Math.round(amount * 100);
}

function applyCompensation(opening: RecruitingOpening, input: CompensationInput | null): void {
  if (input === null) {
    opening.compensationMinMinor = null;
    opening.compensationMaxMinor = null;
    return;
  }
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new RecruitingValidationError("Use a three-letter currency code, like USD or EUR.");
  }
  if (!(COMPENSATION_PERIODS as readonly string[]).includes(input.period)) {
    throw new RecruitingValidationError("Pick how often the pay is counted.");
  }
  const min = toMinor(input.min, "The lowest pay");
  const max = toMinor(input.max, "The highest pay");
  if (min !== null && max !== null && min > max) {
    throw new RecruitingValidationError("The lowest pay is above the highest.");
  }
  opening.compensationMinMinor = min;
  opening.compensationMaxMinor = max;
  opening.compensationCurrency = currency;
  opening.compensationPeriod = input.period;
}

async function assertOwner(companyId: string, userId: string): Promise<void> {
  const member = await AppDataSource.getRepository(Membership).findOneBy({ companyId, userId });
  if (!member) throw new RecruitingValidationError("The owner must be a Member of this company.");
}

async function applyInput(
  opening: RecruitingOpening,
  input: OpeningInput,
  actor: RecruitingActor,
): Promise<void> {
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new RecruitingValidationError("Give the Opening a title.");
    opening.title = title.slice(0, 160);
  }
  if (input.summary !== undefined) opening.summary = input.summary.trim().slice(0, 500);
  if (input.description !== undefined) {
    opening.description = input.description.replace(/\r\n?/g, "\n").trim().slice(0, 30_000);
  }
  if (input.department !== undefined) opening.department = input.department.trim().slice(0, 120);
  if (input.location !== undefined) opening.location = input.location.trim().slice(0, 160);
  if (input.workplace !== undefined) opening.workplace = input.workplace;
  if (input.employmentType !== undefined) opening.employmentType = input.employmentType;
  if (input.visibility !== undefined) opening.visibility = input.visibility;
  if (input.compensation !== undefined) applyCompensation(opening, input.compensation);
  if (input.headcount !== undefined) {
    if (!Number.isInteger(input.headcount) || input.headcount < 1 || input.headcount > 1000) {
      throw new RecruitingValidationError("Headcount must be a whole number from 1 to 1,000.");
    }
    opening.headcount = input.headcount;
  }
  if (input.applyBy !== undefined) {
    if (input.applyBy === null) {
      opening.applyBy = null;
    } else {
      const date = new Date(input.applyBy);
      if (Number.isNaN(date.getTime())) {
        throw new RecruitingValidationError("The closing date is not a date.");
      }
      opening.applyBy = date;
    }
  }
  if (input.screenerEmployeeId !== undefined) {
    if (input.screenerEmployeeId) await assertCompanyEmployee(opening.companyId, input.screenerEmployeeId);
    opening.screenerEmployeeId = input.screenerEmployeeId;
  }
  if (input.ownerUserId !== undefined) {
    if (input.ownerUserId) await assertOwner(opening.companyId, input.ownerUserId);
    opening.ownerUserId = input.ownerUserId;
  }
  if (input.criteria !== undefined) {
    const before = criteriaFingerprint(parseCriteria(opening.criteriaJson));
    const criteria = normalizeCriteria(input.criteria);
    opening.criteriaJson = JSON.stringify(criteria);
    if (criteriaFingerprint(criteria) !== before) {
      const source: CriteriaSource =
        actor.kind === "employee" ? "employee" : actor.kind === "system" ? "screener" : "member";
      opening.criteriaSource = source;
      opening.criteriaByEmployeeId = actor.kind === "employee" ? actor.employeeId : null;
      opening.criteriaUpdatedAt = new Date();
    }
  }
  if (input.questions !== undefined) {
    opening.questionsJson = JSON.stringify(normalizeQuestions(input.questions));
  }
  if (input.form !== undefined) {
    opening.formJson = JSON.stringify(mergeForm(parseForm(opening.formJson), input.form));
  }
}

export async function createOpening(
  companyId: string,
  input: OpeningInput & { title: string },
  actor: RecruitingActor,
): Promise<RecruitingOpening> {
  const repo = AppDataSource.getRepository(RecruitingOpening);
  const opening = repo.create({
    companyId,
    title: "",
    slug: "",
    status: "draft",
    visibility: "public",
    employmentType: "full_time",
    workplace: "onsite",
    department: "",
    location: "",
    compensationMinMinor: null,
    compensationMaxMinor: null,
    compensationCurrency: "USD",
    compensationPeriod: "year",
    headcount: 1,
    applyBy: null,
    screenerEmployeeId: null,
    ownerUserId: actor.kind === "member" ? actor.userId : null,
    createdByUserId: actor.kind === "member" ? actor.userId : null,
    createdByEmployeeId: actor.kind === "employee" ? actor.employeeId : null,
    criteriaSource: "member",
    criteriaByEmployeeId: null,
    criteriaUpdatedAt: null,
    publishedAt: null,
    closedAt: null,
    summary: "",
    formJson: "{}",
    criteriaJson: "[]",
    questionsJson: "[]",
    description: "",
  });
  await applyInput(opening, input, actor);
  opening.slug = await uniqueOpeningSlug(companyId, opening.title);
  return repo.save(opening);
}

export async function loadOpening(companyId: string, openingId: string): Promise<RecruitingOpening> {
  const opening = await AppDataSource.getRepository(RecruitingOpening).findOneBy({
    id: openingId,
    companyId,
  });
  if (!opening) throw new RecruitingNotFoundError("Opening not found");
  return opening;
}

export async function updateOpening(
  companyId: string,
  openingId: string,
  input: OpeningInput,
  actor: RecruitingActor,
): Promise<RecruitingOpening> {
  const opening = await loadOpening(companyId, openingId);
  await applyInput(opening, input, actor);
  return AppDataSource.getRepository(RecruitingOpening).save(opening);
}

/** Why this Opening cannot be published yet, or null. */
export function publishProblem(opening: RecruitingOpening): string | null {
  if (!opening.title.trim()) return "Give the Opening a title before publishing it.";
  if (opening.description.trim().length < 40) {
    return "Describe the role before publishing it: what the work is, and who would thrive in it.";
  }
  if (opening.applyBy && opening.applyBy.getTime() <= Date.now()) {
    return "The closing date has passed. Move it, or clear it, before publishing.";
  }
  return null;
}

export async function publishOpening(companyId: string, openingId: string): Promise<RecruitingOpening> {
  const opening = await loadOpening(companyId, openingId);
  const problem = publishProblem(opening);
  if (problem) throw new RecruitingValidationError(problem);
  opening.status = "open";
  opening.publishedAt = opening.publishedAt ?? new Date();
  opening.closedAt = null;
  return AppDataSource.getRepository(RecruitingOpening).save(opening);
}

export async function closeOpening(companyId: string, openingId: string): Promise<RecruitingOpening> {
  const opening = await loadOpening(companyId, openingId);
  if (opening.status === "draft") {
    throw new RecruitingValidationError("A draft is not open, so there is nothing to close.");
  }
  opening.status = "closed";
  opening.closedAt = new Date();
  return AppDataSource.getRepository(RecruitingOpening).save(opening);
}

/**
 * Delete an Opening nobody has applied to. Once people have applied, their
 * Applications are the company's record of having considered them, so the
 * Opening is closed instead.
 */
export async function deleteOpening(companyId: string, openingId: string): Promise<RecruitingOpening> {
  const opening = await loadOpening(companyId, openingId);
  const applications = await AppDataSource.getRepository(RecruitingApplication).count({
    where: { openingId: opening.id },
  });
  if (applications > 0) {
    throw new RecruitingConflictError(
      `${applications} ${applications === 1 ? "person has" : "people have"} applied to this Opening. Close it instead; their applications stay on record.`,
    );
  }
  await AppDataSource.getRepository(RecruitingOpening).delete({ id: opening.id });
  // A criteria `delete()` hands the live-sync subscriber no entity to resolve
  // a company from, so the open Openings pages are told here.
  emitResourceChange(opening.companyId, "recruiting_opening", opening.id);
  return opening;
}

/** Whether a published Opening takes Applications at this moment. */
export function acceptingApplications(opening: RecruitingOpening, now = new Date()): boolean {
  return opening.status === "open" && (!opening.applyBy || opening.applyBy.getTime() > now.getTime());
}

export type StageCounts = Record<RecruitingStage, number>;

function emptyCounts(): StageCounts {
  return Object.fromEntries(RECRUITING_STAGES.map((stage) => [stage, 0])) as StageCounts;
}

/** Applications per stage for each Opening, in one grouped query. */
export async function stageCountsByOpening(openingIds: string[]): Promise<Map<string, StageCounts>> {
  const result = new Map<string, StageCounts>();
  if (openingIds.length === 0) return result;
  const rows: Array<{ openingId: string; stage: string; count: string | number }> =
    await AppDataSource.getRepository(RecruitingApplication)
      .createQueryBuilder("application")
      .select("application.openingId", "openingId")
      .addSelect("application.stage", "stage")
      .addSelect("COUNT(*)", "count")
      .where("application.openingId IN (:...ids)", { ids: openingIds })
      .groupBy("application.openingId")
      .addGroupBy("application.stage")
      .getRawMany();
  for (const id of openingIds) result.set(id, emptyCounts());
  for (const row of rows) {
    const counts = result.get(row.openingId);
    if (counts && (RECRUITING_STAGES as readonly string[]).includes(row.stage)) {
      counts[row.stage as RecruitingStage] = Number(row.count);
    }
  }
  return result;
}

type PersonRef = { id: string; name: string };

async function peopleFor(openings: RecruitingOpening[]) {
  const employeeIds = [
    ...new Set(
      openings.flatMap((o) => [o.screenerEmployeeId, o.createdByEmployeeId, o.criteriaByEmployeeId]),
    ),
  ].filter((id): id is string => Boolean(id));
  const userIds = [...new Set(openings.flatMap((o) => [o.ownerUserId, o.createdByUserId]))].filter(
    (id): id is string => Boolean(id),
  );
  const [employees, users] = await Promise.all([
    employeeIds.length
      ? AppDataSource.getRepository(AIEmployee).findBy({ id: In(employeeIds) })
      : Promise.resolve([]),
    userIds.length ? AppDataSource.getRepository(User).findBy({ id: In(userIds) }) : Promise.resolve([]),
  ]);
  return {
    employees: new Map(employees.map((e) => [e.id, e])),
    users: new Map(users.map((u) => [u.id, { id: u.id, name: u.name || u.email } satisfies PersonRef])),
  };
}

export function openingCompensation(opening: RecruitingOpening) {
  return {
    min: opening.compensationMinMinor === null ? null : opening.compensationMinMinor / 100,
    max: opening.compensationMaxMinor === null ? null : opening.compensationMaxMinor / 100,
    currency: opening.compensationCurrency,
    period: opening.compensationPeriod,
    label: formatCompensation({
      minMinor: opening.compensationMinMinor,
      maxMinor: opening.compensationMaxMinor,
      currency: opening.compensationCurrency,
      period: opening.compensationPeriod,
    }),
  };
}

export type OpeningDto = Awaited<ReturnType<typeof openingDtos>>[number];

/** Openings as the App and the AI tools read them, with counts and links. */
export async function openingDtos(
  company: Pick<Company, "id" | "slug">,
  openings: RecruitingOpening[],
  settings?: RecruitingSettings | null,
) {
  const site = settings === undefined ? await findRecruitingSettings(company.id) : settings;
  const [counts, people] = await Promise.all([
    stageCountsByOpening(openings.map((o) => o.id)),
    peopleFor(openings),
  ]);
  const defaultScreener = site?.screenerEmployeeId
    ? (await AppDataSource.getRepository(AIEmployee).findOneBy({
        id: site.screenerEmployeeId,
        companyId: company.id,
      })) ?? null
    : null;
  const now = new Date();
  return openings.map((opening) => {
    const stageCounts = counts.get(opening.id) ?? emptyCounts();
    const criteria = parseCriteria(opening.criteriaJson);
    const screener = opening.screenerEmployeeId
      ? people.employees.get(opening.screenerEmployeeId) ?? null
      : defaultScreener;
    return {
      id: opening.id,
      slug: opening.slug,
      title: opening.title,
      status: opening.status,
      visibility: opening.visibility,
      accepting: acceptingApplications(opening, now),
      employmentType: opening.employmentType,
      workplace: opening.workplace,
      department: opening.department,
      location: opening.location,
      compensation: openingCompensation(opening),
      headcount: opening.headcount,
      applyBy: opening.applyBy?.toISOString() ?? null,
      summary: opening.summary,
      description: opening.description,
      criteria,
      criteriaFingerprint: criteriaFingerprint(criteria),
      criteriaSource: opening.criteriaSource,
      criteriaBy: employeeRef(
        opening.criteriaByEmployeeId ? people.employees.get(opening.criteriaByEmployeeId) : null,
      ),
      criteriaUpdatedAt: opening.criteriaUpdatedAt?.toISOString() ?? null,
      questions: parseQuestions(opening.questionsJson),
      form: parseForm(opening.formJson),
      screener: employeeRef(screener),
      screenerIsDefault: !opening.screenerEmployeeId,
      owner: opening.ownerUserId ? people.users.get(opening.ownerUserId) ?? null : null,
      createdBy: creatorOf(opening, people),
      stageCounts,
      applicationCount: Object.values(stageCounts).reduce((sum, n) => sum + n, 0),
      activeCount: RECRUITING_ACTIVE_STAGES.reduce((sum, stage) => sum + stageCounts[stage], 0),
      publicUrl:
        opening.status === "draft" ? null : openingPublicUrl(companySlug(company), site, opening.slug),
      publishedAt: opening.publishedAt?.toISOString() ?? null,
      closedAt: opening.closedAt?.toISOString() ?? null,
      createdAt: opening.createdAt.toISOString(),
      updatedAt: opening.updatedAt.toISOString(),
    };
  });
}

function companySlug(company: Pick<Company, "slug">): string {
  return company.slug;
}

/** Who posted the Opening: an AI Employee, a Member, or nobody still on record. */
function creatorOf(
  opening: RecruitingOpening,
  people: Awaited<ReturnType<typeof peopleFor>>,
): { kind: "employee" | "member"; id: string; name: string } | null {
  const employee = opening.createdByEmployeeId
    ? people.employees.get(opening.createdByEmployeeId)
    : undefined;
  if (employee) return { kind: "employee", id: employee.id, name: employee.name };
  const user = opening.createdByUserId ? people.users.get(opening.createdByUserId) : undefined;
  if (user) return { kind: "member", id: user.id, name: user.name };
  return null;
}

const STATUS_RANK: Record<OpeningStatus, number> = { open: 0, draft: 1, closed: 2 };

export async function openingDto(company: Pick<Company, "id" | "slug">, opening: RecruitingOpening) {
  const [dto] = await openingDtos(company, [opening]);
  return dto;
}

export type OpeningListFilters = {
  status?: OpeningStatus;
  q?: string;
};

/** The WHERE every Opening list shares: the filters, never an order. */
function openingListQuery(companyId: string, filters: OpeningListFilters) {
  const query = AppDataSource.getRepository(RecruitingOpening)
    .createQueryBuilder("opening")
    .where("opening.companyId = :companyId", { companyId });
  if (filters.status) query.andWhere("opening.status = :status", { status: filters.status });
  // Every word must be in the title, taken literally ("100%" is not a
  // wildcard) and case-folded the same way on SQLite and Postgres.
  if (filters.q) andWhereTokens(query, ["opening.title"], tokenizeQuery(filters.q));
  return query;
}

export async function listOpenings(
  company: Pick<Company, "id" | "slug">,
  filters: OpeningListFilters = {},
) {
  const openings = await openingListQuery(company.id, filters)
    .orderBy("opening.updatedAt", "DESC")
    .take(500)
    .getMany();
  // Open first, then drafts, then closed; newest change first within each.
  openings.sort((a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3));
  return openingDtos(company, openings);
}

/** 50 Openings a page by default, at most 100. */
export const OPENING_PAGE: PageLimits = { defaultLimit: 50, maxLimit: 100 };

/** {@link STATUS_RANK} as SQL, so the status order is the query's, before a page is cut. */
const STATUS_RANK_SQL = `CASE opening.status ${Object.entries(STATUS_RANK)
  .map(([status, rank]) => `WHEN '${status}' THEN ${rank}`)
  .join(" ")} ELSE 3 END`;

/**
 * Openings one page at a time (`services/listPaging.ts`) — what the
 * `list_openings` AI tool reads: open first, then drafts, then closed, the
 * newest posted first within each. The tool used to read the newest 500 and
 * sort them by status afterwards, so past 500 an open Opening could be missing
 * while closed ones filled the answer. A cursor names the last one shown; an
 * Opening published or closed between pages moves to its new group.
 */
export async function pageOpenings<Out>(
  company: Pick<Company, "id" | "slug">,
  filters: OpeningListFilters,
  page: PageRequest & { budgetChars?: number },
  present: (openings: OpeningDto[]) => Out[] | Promise<Out[]>,
): Promise<Page<Out>> {
  return keysetPage({
    query: () => openingListQuery(company.id, filters),
    keys: [
      { column: STATUS_RANK_SQL, direction: "ASC", type: "number" },
      { column: "opening.createdAt", direction: "DESC", type: "timestamp" },
      { column: "opening.id", direction: "DESC", type: "string" },
    ],
    scope: "recruiting.openings",
    fingerprint: filterFingerprint(company.id, {
      status: filters.status,
      q: filters.q?.trim() ? tokenizeQuery(filters.q).map((token) => token.raw) : undefined,
    }),
    noun: "Openings",
    limits: OPENING_PAGE,
    page,
    present: async (openings) => present(await openingDtos(company, openings)),
  });
}

export async function companyForId(companyId: string): Promise<Company> {
  const company = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  if (!company) throw new RecruitingNotFoundError("Company not found");
  return company;
}
