import { In, Not } from "typeorm";

import { AppDataSource } from "../../db/datasource.js";
import { AIEmployee } from "../../db/entities/AIEmployee.js";
import { Company } from "../../db/entities/Company.js";
import {
  RecruitingApplication,
  type ApplicationSource,
} from "../../db/entities/RecruitingApplication.js";
import { RecruitingApplicationEvent } from "../../db/entities/RecruitingApplicationEvent.js";
import { RecruitingOpening } from "../../db/entities/RecruitingOpening.js";
import { RecruitingScorecard } from "../../db/entities/RecruitingScorecard.js";
import { normalizeEmail } from "../../lib/emailAddress.js";
import {
  RECRUITING_ACTIVE_STAGES,
  RECRUITING_STAGE_LABELS,
  type ApplicationAnswer,
  type OpeningFormSettings,
  type RecruitingStage,
} from "../../../shared/recruiting.js";
import type { SendEmailResult } from "../email.js";
import { andWhereTokens, tokenizeQuery } from "../likeSearch.js";
import { createNotification } from "../notifications.js";
import { emitResourceChange } from "../resourceEvents.js";
import { normalizeWebUrl, parseAnswers, parseCriteria, parseForm, parseQuestions, validateAnswers } from "./content.js";
import { sendApplicationConfirmation, sendRejectionEmail } from "./emails.js";
import { RecruitingConflictError, RecruitingNotFoundError, RecruitingValidationError } from "./errors.js";
import { listApplicationEvents, recordApplicationEvent, type TimelineActor } from "./events.js";
import {
  deleteResume,
  extractResumeText,
  resumeMimeType,
  sniffResume,
  storeResume,
  RESUME_TEXT_CHAR_CAP,
} from "./files.js";
import { acceptingApplications, loadOpening, openingCompensation, type RecruitingActor } from "./openings.js";
import {
  hasScorecard,
  listScorecards,
  recordScorecard,
  scorecardDto,
  type ScorecardInput,
} from "./scorecards.js";
import { screenerFor } from "./screening.js";
import { enqueueScreen } from "./screeningQueue.js";
import { employeeRef, findRecruitingSettings } from "./settings.js";

/**
 * Applications: how people apply, how the company reads and moves them, and
 * the shapes they are read in.
 */

/** A refusal that names the field(s) at fault, so a form can mark them. */
export class ApplicationFieldError extends RecruitingValidationError {
  constructor(
    message: string,
    readonly fields: Record<string, string>,
  ) {
    super(message);
  }
}

export type UploadedResume = { buffer: Buffer; originalname: string };

export type ApplicationInput = {
  name: string;
  email: string;
  phone?: string;
  location?: string;
  linkedinUrl?: string;
  websiteUrl?: string;
  coverLetter?: string;
  answers?: Record<string, unknown>;
};

export type PublicApplicationInput = ApplicationInput & {
  consent: boolean;
  clientSubmissionId: string;
};

const MAX_COVER_LETTER_CHARS = 10_000;

/** A bare address, lower-cased, or null. Never a display name, never two addresses. */
export function normalizeCandidateEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  // eslint-disable-next-line no-control-regex
  if (!trimmed || trimmed.length > 254 || /[\u0000-\u001f\u007f\s<>"',;]/.test(trimmed)) return null;
  if (!/^[^@]+@[^@]+\.[a-z]{2,}$/.test(trimmed)) return null;
  return normalizeEmail(trimmed) === trimmed ? trimmed : null;
}

function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 40 || !/^[+\d().\-\s/x]+$/i.test(trimmed)) return null;
  return (trimmed.match(/\d/g)?.length ?? 0) >= 6 ? trimmed : null;
}

type ValidatedFields = {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  websiteUrl: string;
  coverLetter: string;
  answers: ApplicationAnswer[];
};

/**
 * Check what a candidate typed against the Opening's form. Every problem is
 * collected, so the form can mark all of them at once instead of one per try.
 */
export function validateApplicationFields(
  input: ApplicationInput,
  form: OpeningFormSettings,
  questions: ReturnType<typeof parseQuestions>,
  options: { enforceForm: boolean },
): { fields: ValidatedFields; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name) errors.name = "Enter your name.";
  else if (name.length > 120) errors.name = "Keep your name under 120 characters.";
  const email = normalizeCandidateEmail(input.email);
  if (!email) errors.email = "Enter an email address, like ada@example.com.";

  const field = (
    key: "phone" | "location" | "linkedin" | "website" | "coverLetter",
    value: string | undefined,
  ): string => {
    const mode = options.enforceForm ? form[key] : "optional";
    if (mode === "hidden") return "";
    const text = (value ?? "").trim();
    if (!text && mode === "required") {
      errors[key] = "This is required.";
      return "";
    }
    return text;
  };

  const phoneText = field("phone", input.phone);
  const phone = normalizePhone(phoneText);
  if (phone === null) errors.phone = "Enter a phone number, like +1 415 555 0100.";

  const location = field("location", input.location).slice(0, 160);

  const linkedinText = field("linkedin", input.linkedinUrl);
  const linkedinUrl = linkedinText ? normalizeWebUrl(linkedinText) : "";
  if (linkedinUrl === null) errors.linkedin = "Enter a link, like https://www.linkedin.com/in/you.";

  const websiteText = field("website", input.websiteUrl);
  const websiteUrl = websiteText ? normalizeWebUrl(websiteText) : "";
  if (websiteUrl === null) errors.website = "Enter a link, like https://example.com.";

  const coverLetter = field("coverLetter", input.coverLetter).replace(/\r\n?/g, "\n");
  if (coverLetter.length > MAX_COVER_LETTER_CHARS) {
    errors.coverLetter = `Keep this under ${MAX_COVER_LETTER_CHARS.toLocaleString("en-US")} characters.`;
  }

  const answered = validateAnswers(
    options.enforceForm ? questions : questions.map((question) => ({ ...question, required: false })),
    input.answers ?? {},
  );
  for (const [questionId, message] of Object.entries(answered.errors)) {
    errors[`answers.${questionId}`] = message;
  }

  return {
    fields: {
      name,
      email: email ?? "",
      phone: phone ?? "",
      location,
      linkedinUrl: linkedinUrl ?? "",
      websiteUrl: websiteUrl ?? "",
      coverLetter,
      answers: answered.answers,
    },
    errors,
  };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code ?? "";
  const message = error instanceof Error ? error.message : "";
  return code === "23505" || code.startsWith("SQLITE_CONSTRAINT") || /UNIQUE constraint/i.test(message);
}

type StoredResume = {
  key: string;
  fileName: string;
  mimeType: string;
  size: number;
  text: string;
  textStatus: "extracted" | "unreadable";
};

async function storeUpload(companyId: string, file: UploadedResume): Promise<StoredResume> {
  const kind = await sniffResume(file.buffer, file.originalname);
  const text = await extractResumeText(file.buffer, kind);
  const key = await storeResume(companyId, file.buffer, kind);
  return {
    key,
    fileName: file.originalname.replace(/[\r\n"\\]/g, "").slice(0, 200) || `resume.${kind}`,
    mimeType: resumeMimeType(kind),
    size: file.buffer.length,
    text: text ?? "",
    textStatus: text ? "extracted" : "unreadable",
  };
}

function newApplicationRow(args: {
  companyId: string;
  openingId: string;
  fields: ValidatedFields;
  source: ApplicationSource;
  sourceDetail?: string;
  resume: StoredResume | null;
  resumeText?: string;
  applicantUserId?: string | null;
  createdByUserId?: string | null;
  createdByEmployeeId?: string | null;
  consentAt?: Date | null;
  clientSubmissionId?: string | null;
}): RecruitingApplication {
  const resumeText = args.resume?.text ?? (args.resumeText ?? "").slice(0, RESUME_TEXT_CHAR_CAP);
  return AppDataSource.getRepository(RecruitingApplication).create({
    companyId: args.companyId,
    openingId: args.openingId,
    candidateName: args.fields.name,
    candidateEmail: args.fields.email,
    candidatePhone: args.fields.phone,
    candidateLocation: args.fields.location,
    linkedinUrl: args.fields.linkedinUrl,
    websiteUrl: args.fields.websiteUrl,
    source: args.source,
    sourceDetail: (args.sourceDetail ?? "").slice(0, 500),
    applicantUserId: args.applicantUserId ?? null,
    createdByUserId: args.createdByUserId ?? null,
    createdByEmployeeId: args.createdByEmployeeId ?? null,
    stage: "applied",
    stageChangedAt: new Date(),
    rejectionReason: "",
    screenStatus: "none",
    screenAttempts: 0,
    screenQueuedAt: null,
    screenStartedAt: null,
    score: null,
    scoreLabel: null,
    scoredAt: null,
    latestScorecardId: null,
    injectionFlag: false,
    confirmationEmailStatus: "",
    consentAt: args.consentAt ?? null,
    clientSubmissionId: args.clientSubmissionId ?? null,
    resumeFileKey: args.resume?.key ?? null,
    resumeFileName: args.resume?.fileName ?? "",
    resumeMimeType: args.resume?.mimeType ?? "",
    resumeSize: args.resume?.size ?? 0,
    resumeTextStatus: args.resume ? args.resume.textStatus : resumeText ? "extracted" : "none",
    screenError: "",
    answersJson: JSON.stringify(args.fields.answers),
    coverLetter: args.fields.coverLetter,
    resumeText,
  });
}

/**
 * Take one application from the careers site. Safe to retry: the same
 * `clientSubmissionId` returns the Application it already created, and sends
 * nothing twice. The caller follows up with {@link afterApplicationReceived},
 * so the person applying is answered before any email or screen runs.
 */
export async function submitApplication(args: {
  opening: RecruitingOpening;
  input: PublicApplicationInput;
  file: UploadedResume | null;
  source: "careers_site" | "internal";
  applicantUserId?: string | null;
}): Promise<{ application: RecruitingApplication; duplicate: boolean }> {
  const repo = AppDataSource.getRepository(RecruitingApplication);
  const existing = await repo.findOneBy({
    openingId: args.opening.id,
    clientSubmissionId: args.input.clientSubmissionId,
  });
  if (existing) return { application: existing, duplicate: true };
  if (!acceptingApplications(args.opening)) {
    throw new RecruitingValidationError("This opening is no longer taking applications.");
  }

  const form = parseForm(args.opening.formJson);
  const { fields, errors } = validateApplicationFields(
    args.input,
    form,
    parseQuestions(args.opening.questionsJson),
    { enforceForm: true },
  );
  if (form.resume === "required" && !args.file) errors.resume = "Attach your resume.";
  if (!args.input.consent) errors.consent = "Agree to how your application will be used to continue.";
  if (Object.keys(errors).length > 0) {
    throw new ApplicationFieldError("Some answers need another look.", errors);
  }

  let resume: StoredResume | null = null;
  if (args.file) {
    try {
      resume = await storeUpload(args.opening.companyId, args.file);
    } catch (error) {
      if (error instanceof RecruitingValidationError) {
        throw new ApplicationFieldError(error.message, { resume: error.message });
      }
      throw error;
    }
  }

  try {
    const application = await repo.save(
      newApplicationRow({
        companyId: args.opening.companyId,
        openingId: args.opening.id,
        fields,
        source: args.source,
        resume,
        applicantUserId: args.applicantUserId ?? null,
        consentAt: new Date(),
        clientSubmissionId: args.input.clientSubmissionId,
      }),
    );
    await recordApplicationEvent({
      application,
      kind: "applied",
      actor: { kind: "candidate", name: application.candidateName },
      meta: { source: args.source },
    });
    return { application, duplicate: false };
  } catch (error) {
    if (resume) await deleteResume(args.opening.companyId, resume.key);
    if (isUniqueViolation(error)) {
      const winner = await repo.findOneBy({
        openingId: args.opening.id,
        clientSubmissionId: args.input.clientSubmissionId,
      });
      if (winner) return { application: winner, duplicate: true };
    }
    throw error;
  }
}

/**
 * Everything that follows an Application in: the confirmation email, the AI
 * screen, and — when no screener is watching — a note to the Opening's owner.
 * Never throws; each part records its own outcome.
 */
export async function afterApplicationReceived(
  applicationId: string,
  options: { confirm: boolean },
): Promise<void> {
  try {
    const application = await AppDataSource.getRepository(RecruitingApplication).findOneBy({
      id: applicationId,
    });
    if (!application) return;
    const [opening, company, settings] = await Promise.all([
      AppDataSource.getRepository(RecruitingOpening).findOneBy({ id: application.openingId }),
      AppDataSource.getRepository(Company).findOneBy({ id: application.companyId }),
      findRecruitingSettings(application.companyId),
    ]);
    if (!opening || !company) return;
    if (options.confirm) {
      await sendApplicationConfirmation({ application, opening, company, settings }).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[recruiting] confirmation for ${application.id} failed:`, err);
      });
    }
    const screener = await screenerFor(company.id, opening);
    if (screener && settings?.autoScreen !== false) {
      await enqueueScreen(application.id, { fresh: true });
      return;
    }
    // Nobody needs telling about a candidate they added themselves.
    if (opening.ownerUserId && opening.ownerUserId !== application.createdByUserId) {
      const applied = application.source === "careers_site";
      await createNotification({
        companyId: company.id,
        userId: opening.ownerUserId,
        kind: "recruiting_application",
        title: `${applied ? "New applicant" : "New candidate"} for ${opening.title}`,
        body: applied ? `${application.candidateName} applied.` : `${application.candidateName} was added.`,
        link: `/recruiting/applicants/${application.id}`,
        actorKind: "system",
        entityKind: "recruiting_application",
        entityId: application.id,
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[recruiting] follow-up for application ${applicationId} failed:`, err);
  }
}

/**
 * Add someone the company found itself — a referral a Member types in, or a
 * person an AI Employee sourced. No confirmation email: they did not apply.
 */
export async function addApplication(args: {
  companyId: string;
  openingId: string;
  input: ApplicationInput;
  file: UploadedResume | null;
  resumeText?: string;
  source: "manual" | "sourced";
  sourceDetail?: string;
  actor: RecruitingActor;
}): Promise<RecruitingApplication> {
  const opening = await loadOpening(args.companyId, args.openingId);
  const { fields, errors } = validateApplicationFields(
    args.input,
    parseForm(opening.formJson),
    parseQuestions(opening.questionsJson),
    { enforceForm: false },
  );
  if (Object.keys(errors).length > 0) {
    const [first] = Object.values(errors);
    throw new ApplicationFieldError(first ?? "Some details need another look.", errors);
  }
  const resume = args.file ? await storeUpload(args.companyId, args.file) : null;
  const repo = AppDataSource.getRepository(RecruitingApplication);
  try {
    const application = await repo.save(
      newApplicationRow({
        companyId: args.companyId,
        openingId: opening.id,
        fields,
        source: args.source,
        sourceDetail: args.sourceDetail,
        resume,
        resumeText: args.resumeText,
        createdByUserId: args.actor.kind === "member" ? args.actor.userId : null,
        createdByEmployeeId: args.actor.kind === "employee" ? args.actor.employeeId : null,
      }),
    );
    await recordApplicationEvent({
      application,
      kind: "added",
      actor: args.actor,
      body: args.sourceDetail ?? "",
      meta: { source: args.source },
    });
    return application;
  } catch (error) {
    if (resume) await deleteResume(args.companyId, resume.key);
    throw error;
  }
}

export async function loadApplication(companyId: string, applicationId: string): Promise<RecruitingApplication> {
  const application = await AppDataSource.getRepository(RecruitingApplication).findOneBy({
    id: applicationId,
    companyId,
  });
  if (!application) throw new RecruitingNotFoundError("Application not found");
  return application;
}

/** The columns a list needs — never the resume, the cover letter or the answers. */
const SUMMARY_COLUMNS = [
  "id",
  "companyId",
  "openingId",
  "candidateName",
  "candidateEmail",
  "candidateLocation",
  "source",
  "stage",
  "stageChangedAt",
  "rejectionReason",
  "screenStatus",
  "score",
  "scoreLabel",
  "scoredAt",
  "injectionFlag",
  "confirmationEmailStatus",
  "resumeFileKey",
  "resumeTextStatus",
  "createdAt",
  "updatedAt",
] as const;

export type ApplicationSummary = {
  id: string;
  openingId: string;
  opening: { id: string; title: string; slug: string } | null;
  candidateName: string;
  candidateEmail: string;
  candidateLocation: string;
  source: ApplicationSource;
  stage: RecruitingStage;
  stageLabel: string;
  stageChangedAt: string;
  rejectionReason: string;
  screenStatus: RecruitingApplication["screenStatus"];
  score: number | null;
  scoreLabel: RecruitingApplication["scoreLabel"];
  scoredAt: string | null;
  injectionFlag: boolean;
  confirmationEmailStatus: string;
  hasResume: boolean;
  resumeTextStatus: RecruitingApplication["resumeTextStatus"];
  createdAt: string;
  updatedAt: string;
};

function summaryDto(
  application: RecruitingApplication,
  openings: Map<string, Pick<RecruitingOpening, "id" | "title" | "slug">>,
): ApplicationSummary {
  const opening = openings.get(application.openingId);
  return {
    id: application.id,
    openingId: application.openingId,
    opening: opening ? { id: opening.id, title: opening.title, slug: opening.slug } : null,
    candidateName: application.candidateName,
    candidateEmail: application.candidateEmail,
    candidateLocation: application.candidateLocation,
    source: application.source,
    stage: application.stage,
    stageLabel: RECRUITING_STAGE_LABELS[application.stage] ?? application.stage,
    stageChangedAt: application.stageChangedAt.toISOString(),
    rejectionReason: application.rejectionReason,
    screenStatus: application.screenStatus,
    score: application.score,
    scoreLabel: application.scoreLabel,
    scoredAt: application.scoredAt?.toISOString() ?? null,
    injectionFlag: application.injectionFlag,
    confirmationEmailStatus: application.confirmationEmailStatus,
    hasResume: Boolean(application.resumeFileKey),
    resumeTextStatus: application.resumeTextStatus,
    createdAt: application.createdAt.toISOString(),
    updatedAt: application.updatedAt.toISOString(),
  };
}

export type ApplicationListFilters = {
  openingId?: string;
  stage?: RecruitingStage | "active";
  q?: string;
  sort?: "newest" | "oldest" | "score";
  screenStatus?: RecruitingApplication["screenStatus"];
  minScore?: number;
  limit?: number;
  offset?: number;
};

export async function listApplications(
  companyId: string,
  filters: ApplicationListFilters = {},
): Promise<{ rows: ApplicationSummary[]; total: number }> {
  const query = AppDataSource.getRepository(RecruitingApplication)
    .createQueryBuilder("application")
    .select(SUMMARY_COLUMNS.map((column) => `application.${column}`))
    .where("application.companyId = :companyId", { companyId });
  if (filters.openingId) query.andWhere("application.openingId = :openingId", { openingId: filters.openingId });
  if (filters.stage === "active") {
    query.andWhere("application.stage IN (:...stages)", { stages: RECRUITING_ACTIVE_STAGES });
  } else if (filters.stage) {
    query.andWhere("application.stage = :stage", { stage: filters.stage });
  }
  if (filters.screenStatus) {
    query.andWhere("application.screenStatus = :screenStatus", { screenStatus: filters.screenStatus });
  }
  if (typeof filters.minScore === "number") {
    query.andWhere("application.score >= :minScore", { minScore: filters.minScore });
  }
  // Every word must be in the name or the address, taken literally (the "_"
  // in "ada_lovelace@" is not a wildcard) and case-folded the same way on
  // SQLite and Postgres, so "Łukasz" finds Łukasz.
  if (filters.q) {
    andWhereTokens(query, ["application.candidateName", "application.candidateEmail"], tokenizeQuery(filters.q));
  }
  if (filters.sort === "score") {
    query.orderBy("application.score", "DESC", "NULLS LAST").addOrderBy("application.createdAt", "DESC");
  } else {
    query.orderBy("application.createdAt", filters.sort === "oldest" ? "ASC" : "DESC");
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const [rows, total] = await query
    .skip(Math.max(filters.offset ?? 0, 0))
    .take(limit)
    .getManyAndCount();
  const openingIds = [...new Set(rows.map((row) => row.openingId))];
  const openings = openingIds.length
    ? await AppDataSource.getRepository(RecruitingOpening).find({
        where: { id: In(openingIds), companyId },
        select: { id: true, title: true, slug: true },
      })
    : [];
  const byId = new Map(openings.map((opening) => [opening.id, opening]));
  return { rows: rows.map((row) => summaryDto(row, byId)), total };
}

/** One Application in full: everything a person or an AI Employee needs to judge it. */
export async function getApplicationDetail(companyId: string, applicationId: string) {
  const application = await loadApplication(companyId, applicationId);
  const opening = await loadOpening(companyId, application.openingId);
  const criteria = parseCriteria(opening.criteriaJson);
  const [scorecards, timeline, others, screener] = await Promise.all([
    listScorecards(application.id, application.latestScorecardId),
    listApplicationEvents(application.id),
    AppDataSource.getRepository(RecruitingApplication).find({
      where: { companyId, candidateEmail: application.candidateEmail, id: Not(application.id) },
      select: { id: true, openingId: true, stage: true, createdAt: true },
      order: { createdAt: "DESC" },
      take: 20,
    }),
    screenerFor(companyId, opening),
  ]);
  const otherOpenings = others.length
    ? await AppDataSource.getRepository(RecruitingOpening).find({
        where: { id: In([...new Set(others.map((row) => row.openingId))]), companyId },
        select: { id: true, title: true, slug: true },
      })
    : [];
  const openingTitles = new Map(otherOpenings.map((row) => [row.id, row.title]));
  const createdBy = application.createdByEmployeeId
    ? await AppDataSource.getRepository(AIEmployee).findOneBy({ id: application.createdByEmployeeId })
    : null;
  return {
    ...summaryDto(application, new Map([[opening.id, opening]])),
    candidatePhone: application.candidatePhone,
    linkedinUrl: application.linkedinUrl,
    websiteUrl: application.websiteUrl,
    sourceDetail: application.sourceDetail,
    createdByEmployee: employeeRef(createdBy),
    coverLetter: application.coverLetter,
    answers: parseAnswers(application.answersJson),
    resumeText: application.resumeText,
    resume: application.resumeFileKey
      ? {
          fileName: application.resumeFileName,
          mimeType: application.resumeMimeType,
          size: application.resumeSize,
        }
      : null,
    consentAt: application.consentAt?.toISOString() ?? null,
    screenError: application.screenError,
    screenAttempts: application.screenAttempts,
    screener: employeeRef(screener),
    openingDetail: {
      id: opening.id,
      title: opening.title,
      slug: opening.slug,
      status: opening.status,
      employmentType: opening.employmentType,
      workplace: opening.workplace,
      location: opening.location,
      compensation: openingCompensation(opening),
      criteria,
      criteriaSource: opening.criteriaSource,
    },
    scorecards: scorecards.map((row) => scorecardDto(row, criteria)),
    /** The AI reading `score` and `scoreLabel` come from; a person's Scorecard never is. */
    latestScorecardId: application.latestScorecardId,
    timeline,
    otherApplications: others.map((row) => ({
      id: row.id,
      openingId: row.openingId,
      openingTitle: openingTitles.get(row.openingId) ?? "An Opening",
      stage: row.stage,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export type ApplicationDetail = Awaited<ReturnType<typeof getApplicationDetail>>;

/** Why an AI Employee may not reject an Application nobody has scored. */
export const UNSCORED_REJECTION_MESSAGE =
  "This application has no Scorecard yet. Score it with score_application first, so a rejection rests on the criteria rather than on a missing or failed screen.";

/**
 * Move an Application to another stage, with the reason written on its
 * timeline. Rejecting can also send the company's rejection email; nothing
 * else here ever emails the candidate.
 *
 * An AI Employee rejects only an Application someone has scored — itself, the
 * AI screener or a person — so a missing or failed screen is never a reason
 * to turn anyone away. A person may decide without a Scorecard.
 */
export async function moveApplication(args: {
  company: Pick<Company, "id" | "name" | "slug">;
  applicationId: string;
  toStage: RecruitingStage;
  reason?: string;
  notifyCandidate?: boolean;
  actor: TimelineActor;
  triggeredByUserId?: string | null;
}): Promise<{ application: RecruitingApplication; email: SendEmailResult | null; changed: boolean }> {
  const application = await loadApplication(args.company.id, args.applicationId);
  const reason = (args.reason ?? "").trim().slice(0, 2_000);
  if (args.notifyCandidate && args.toStage !== "rejected") {
    throw new RecruitingValidationError("Only a rejection sends the candidate an email from here.");
  }
  if (
    args.actor.kind === "employee" &&
    args.toStage === "rejected" &&
    !(await hasScorecard(args.company.id, application.id))
  ) {
    throw new RecruitingConflictError(UNSCORED_REJECTION_MESSAGE);
  }
  if (application.stage === args.toStage) return { application, email: null, changed: false };
  const fromStage = application.stage;
  application.stage = args.toStage;
  application.stageChangedAt = new Date();
  application.rejectionReason = args.toStage === "rejected" ? reason.slice(0, 500) : "";
  const saved = await AppDataSource.getRepository(RecruitingApplication).save(application);
  await recordApplicationEvent({
    application: saved,
    kind: "stage_changed",
    actor: args.actor,
    fromStage,
    toStage: args.toStage,
    body: reason,
  });
  let email: SendEmailResult | null = null;
  if (args.toStage === "rejected" && args.notifyCandidate) {
    const [opening, settings] = await Promise.all([
      loadOpening(args.company.id, saved.openingId),
      findRecruitingSettings(args.company.id),
    ]);
    email = await sendRejectionEmail({
      application: saved,
      opening,
      company: args.company,
      settings,
      actor: args.actor,
      triggeredByUserId: args.triggeredByUserId,
    });
  }
  return { application: saved, email, changed: true };
}

export async function addApplicationNote(args: {
  companyId: string;
  applicationId: string;
  body: string;
  actor: TimelineActor;
}) {
  const application = await loadApplication(args.companyId, args.applicationId);
  const body = args.body.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new RecruitingValidationError("Write the note first.");
  if (body.length > 5_000) throw new RecruitingValidationError("Keep notes under 5,000 characters.");
  return recordApplicationEvent({ application, kind: "note", actor: args.actor, body });
}

/** Ask the AI screener for a fresh Scorecard. */
export async function requestScreen(companyId: string, applicationId: string): Promise<RecruitingApplication> {
  const application = await loadApplication(companyId, applicationId);
  const opening = await loadOpening(companyId, application.openingId);
  const screener = await screenerFor(companyId, opening);
  if (!screener) {
    throw new RecruitingValidationError(
      "No AI screener is appointed. Choose one at Recruiting → Settings first.",
    );
  }
  if (application.screenStatus === "queued" || application.screenStatus === "running") {
    return application;
  }
  await enqueueScreen(application.id, { fresh: true });
  return loadApplication(companyId, applicationId);
}

/** A person's own Scorecard. */
export async function addMemberScorecard(args: {
  companyId: string;
  applicationId: string;
  input: ScorecardInput;
  userId: string;
  userName: string;
}): Promise<RecruitingScorecard> {
  const application = await loadApplication(args.companyId, args.applicationId);
  const opening = await loadOpening(args.companyId, application.openingId);
  return recordScorecard({
    application,
    opening,
    author: { kind: "member", userId: args.userId, name: args.userName },
    input: args.input,
  });
}

/** An AI Employee's Scorecard, written through its own Recruiting tools. */
export async function addEmployeeScorecard(args: {
  companyId: string;
  applicationId: string;
  input: ScorecardInput;
  employee: Pick<AIEmployee, "id" | "name">;
}): Promise<RecruitingScorecard> {
  const application = await loadApplication(args.companyId, args.applicationId);
  const opening = await loadOpening(args.companyId, application.openingId);
  return recordScorecard({
    application,
    opening,
    author: { kind: "employee", employeeId: args.employee.id, name: args.employee.name },
    input: args.input,
  });
}

/**
 * Erase an Application: its row, every Scorecard and timeline line, and the
 * resume on disk. For a candidate's request to be forgotten, or a mistake.
 */
export async function deleteApplication(companyId: string, applicationId: string): Promise<RecruitingApplication> {
  const application = await loadApplication(companyId, applicationId);
  await AppDataSource.transaction(async (manager) => {
    await manager.delete(RecruitingScorecard, { applicationId: application.id });
    await manager.delete(RecruitingApplicationEvent, { applicationId: application.id });
    await manager.delete(RecruitingApplication, { id: application.id });
  });
  // Criteria deletes hand the live-sync subscriber no entity, so the boards
  // showing this Opening's applicants are told here.
  emitResourceChange(companyId, "recruiting_application", application.openingId);
  await deleteResume(companyId, application.resumeFileKey);
  return application;
}
