import { api } from "./api";
import { instructionsEdit, type InstructionsEditState } from "./instructionsEdit";
import {
  MAX_SCREENING_INSTRUCTIONS_LENGTH,
  MAX_SCREENING_INSTRUCTION_LINES,
  RECRUITING_STAGE_LABELS,
  SCORE_LABEL_TEXT,
  type CompensationPeriod,
  type CriterionImportance,
  type EmploymentType,
  type OpeningCriterion,
  type OpeningFormSettings,
  type OpeningQuestion,
  type OpeningStatus,
  type OpeningVisibility,
  type RecruitingAccessLevel,
  type RecruitingStage,
  type ScoreLabel,
  type SiteVisibility,
  type WorkplaceType,
} from "../../shared/recruiting";

/**
 * Recruiting in the App: the shapes the server returns
 * (`server/services/recruiting/*`), the calls that fetch and change them, and
 * the small decisions every Recruiting screen makes the same way — what a
 * stage, a score or a screen status is called and how it is colored.
 */

export type EmployeeRef = {
  id: string;
  name: string;
  slug: string;
  role: string;
  avatarKey: string | null;
};

export type StageCounts = Record<RecruitingStage, number>;

export type Opening = {
  id: string;
  slug: string;
  title: string;
  status: OpeningStatus;
  visibility: OpeningVisibility;
  accepting: boolean;
  employmentType: EmploymentType;
  workplace: WorkplaceType;
  department: string;
  location: string;
  compensation: {
    min: number | null;
    max: number | null;
    currency: string;
    period: CompensationPeriod;
    label: string | null;
  };
  headcount: number;
  applyBy: string | null;
  summary: string;
  description: string;
  criteria: OpeningCriterion[];
  criteriaFingerprint: string;
  criteriaSource: "member" | "employee" | "screener";
  criteriaBy: EmployeeRef | null;
  criteriaUpdatedAt: string | null;
  questions: OpeningQuestion[];
  form: OpeningFormSettings;
  screener: EmployeeRef | null;
  screenerIsDefault: boolean;
  owner: { id: string; name: string } | null;
  createdBy: { kind: "employee" | "member"; id: string; name: string } | null;
  stageCounts: StageCounts;
  applicationCount: number;
  activeCount: number;
  publicUrl: string | null;
  publishedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ScreenStatus = "none" | "queued" | "running" | "scored" | "failed";

export type ApplicationSummary = {
  id: string;
  openingId: string;
  opening: { id: string; title: string; slug: string } | null;
  candidateName: string;
  candidateEmail: string;
  candidateLocation: string;
  source: "careers_site" | "internal" | "manual" | "sourced";
  stage: RecruitingStage;
  stageLabel: string;
  stageChangedAt: string;
  rejectionReason: string;
  screenStatus: ScreenStatus;
  score: number | null;
  scoreLabel: ScoreLabel | null;
  scoredAt: string | null;
  injectionFlag: boolean;
  confirmationEmailStatus: string;
  hasResume: boolean;
  resumeTextStatus: "none" | "extracted" | "unreadable";
  createdAt: string;
  updatedAt: string;
};

export type ScorecardRating = {
  criterionId: string;
  name: string;
  importance: CriterionImportance;
  rating: number | null;
  evidence: Array<{ quote: string; found: boolean }>;
  note: string;
};

export type Scorecard = {
  id: string;
  authorKind: "screener" | "employee" | "member";
  authorName: string;
  authorEmployeeId: string | null;
  authorUserId: string | null;
  score: number | null;
  label: ScoreLabel | null;
  labelText: string | null;
  summary: string;
  ratings: ScorecardRating[];
  strengths: string[];
  concerns: string[];
  interviewQuestions: string[];
  missingMustHaves: string[];
  partialMustHaves: string[];
  unverifiedQuotes: number;
  injectionDetected: boolean;
  modelLabel: string;
  criteriaChanged: boolean;
  createdAt: string;
};

export type TimelineEvent = {
  id: string;
  kind:
    | "applied"
    | "added"
    | "stage_changed"
    | "note"
    | "scored"
    | "screen_failed"
    | "email_sent"
    | "email_failed"
    | "email_skipped"
    | "criteria_drafted";
  actorKind: "candidate" | "member" | "employee" | "system";
  actorName: string;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  fromStage: string | null;
  toStage: string | null;
  body: string;
  meta: Record<string, unknown>;
  occurredAt: string;
};

export type ApplicationDetail = ApplicationSummary & {
  candidatePhone: string;
  linkedinUrl: string;
  websiteUrl: string;
  sourceDetail: string;
  createdByEmployee: EmployeeRef | null;
  coverLetter: string;
  answers: Array<{ questionId: string; label: string; kind: string; value: unknown }>;
  resumeText: string;
  resume: { fileName: string; mimeType: string; size: number } | null;
  consentAt: string | null;
  screenError: string;
  screenAttempts: number;
  screener: EmployeeRef | null;
  openingDetail: {
    id: string;
    title: string;
    slug: string;
    status: OpeningStatus;
    employmentType: EmploymentType;
    workplace: WorkplaceType;
    location: string;
    compensation: Opening["compensation"];
    criteria: OpeningCriterion[];
    criteriaSource: Opening["criteriaSource"];
  };
  scorecards: Scorecard[];
  /**
   * The AI reading the Application's score came from — the screener's or an
   * AI Employee's Scorecard, never a person's. Null until one has scored it.
   */
  latestScorecardId: string | null;
  timeline: TimelineEvent[];
  otherApplications: Array<{
    id: string;
    openingId: string;
    openingTitle: string;
    stage: RecruitingStage;
    createdAt: string;
  }>;
};

export type RecruitingSettingsDto = {
  site: {
    enabled: boolean;
    visibility: SiteVisibility;
    title: string;
    effectiveTitle: string;
    headline: string;
    intro: string;
    websiteUrl: string;
    privacyPolicyUrl: string;
    accentColor: string;
    logoUrl: string | null;
    allowIndexing: boolean;
    url: string;
    installUrl: string;
    feedUrl: string;
  };
  domain: {
    name: string | null;
    verifiedAt: string | null;
    checkedAt: string | null;
    error: string;
    live: boolean;
    record: { type: "TXT"; name: string; value: string } | null;
    cnameTarget: string;
  };
  screening: {
    screener: EmployeeRef | null;
    autoScreen: boolean;
    instructions: string | null;
    effectiveInstructions: string;
    defaultInstructions: string;
  };
  emails: {
    confirmationEnabled: boolean;
    confirmationSubject: string | null;
    confirmationBody: string | null;
    effectiveConfirmation: { subject: string; body: string };
    defaultConfirmation: { subject: string; body: string };
    rejectionSubject: string | null;
    rejectionBody: string | null;
    effectiveRejection: { subject: string; body: string };
    defaultRejection: { subject: string; body: string };
    sender: { source: "company_provider" | "global_smtp" | "console"; fromAddress: string; delivers: boolean };
  };
};

export type RecruitingOverview = {
  counts: {
    openOpenings: number;
    draftOpenings: number;
    newThisWeek: number;
    awaitingReview: number;
    interviewing: number;
    offers: number;
    hiredThisMonth: number;
    screening: number;
    failedScreens: number;
  };
  topMatches: ApplicationSummary[];
  recent: ApplicationSummary[];
  setup: {
    siteEnabled: boolean;
    siteUrl: string;
    siteVisibility: SiteVisibility;
    customDomain: string | null;
    customDomainLive: boolean;
    screenerAppointed: boolean;
    autoScreen: boolean;
    emailDelivers: boolean;
    hasOpenOpening: boolean;
  };
};

export type RecruitingGrantRow = {
  employee: EmployeeRef;
  grant: { id: string; accessLevel: RecruitingAccessLevel; createdAt: string } | null;
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
  compensation?: { min: number | null; max: number | null; currency: string; period: CompensationPeriod } | null;
  headcount?: number;
  applyBy?: string | null;
  screenerEmployeeId?: string | null;
  ownerUserId?: string | null;
  criteria?: Array<Partial<OpeningCriterion> & Pick<OpeningCriterion, "name" | "importance">>;
  questions?: Array<Partial<OpeningQuestion> & Pick<OpeningQuestion, "label" | "kind">>;
  form?: Partial<OpeningFormSettings>;
};

export type ApplicationQuery = {
  openingId?: string;
  stage?: RecruitingStage | "active";
  q?: string;
  sort?: "newest" | "oldest" | "score";
  screenStatus?: ScreenStatus;
  limit?: number;
  offset?: number;
};

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

export function recruitingApi(companyId: string) {
  const base = `/api/companies/${companyId}/recruiting`;
  return {
    overview: () => api.get<RecruitingOverview>(`${base}/overview`),
    settings: () => api.get<RecruitingSettingsDto>(`${base}/settings`),
    updateSettings: (patch: Record<string, unknown>) => api.patch<RecruitingSettingsDto>(`${base}/settings`, patch),
    uploadLogo: (file: File) => api.uploadFile<RecruitingSettingsDto>(`${base}/settings/logo`, file),
    removeLogo: () => api.del<RecruitingSettingsDto>(`${base}/settings/logo`),
    setDomain: (domain: string | null) => api.put<RecruitingSettingsDto>(`${base}/settings/domain`, { domain }),
    verifyDomain: () =>
      api.post<{
        settings: RecruitingSettingsDto;
        check: { verified: boolean; cnameTargets: string[]; pointsHere: boolean };
      }>(`${base}/settings/domain/verify`, {}),
    openings: (params: { status?: OpeningStatus; q?: string } = {}) =>
      api.get<{ rows: Opening[] }>(`${base}/openings${query(params)}`),
    opening: (openingId: string) => api.get<Opening>(`${base}/openings/${openingId}`),
    createOpening: (input: OpeningInput & { title: string }) => api.post<Opening>(`${base}/openings`, input),
    updateOpening: (openingId: string, patch: OpeningInput) =>
      api.patch<Opening>(`${base}/openings/${openingId}`, patch),
    deleteOpening: (openingId: string) => api.del<void>(`${base}/openings/${openingId}`),
    publishOpening: (openingId: string) => api.post<Opening>(`${base}/openings/${openingId}/publish`, {}),
    closeOpening: (openingId: string) => api.post<Opening>(`${base}/openings/${openingId}/close`, {}),
    suggestCriteria: (openingId: string, employeeId: string) =>
      api.post<{ criteria: Array<Pick<OpeningCriterion, "name" | "description" | "importance">> }>(
        `${base}/openings/${openingId}/suggest-criteria`,
        { employeeId },
      ),
    applications: (params: ApplicationQuery = {}) =>
      api.get<{ rows: ApplicationSummary[]; total: number }>(
        `${base}/applications${query(params as Record<string, string | number | undefined>)}`,
      ),
    application: (applicationId: string) => api.get<ApplicationDetail>(`${base}/applications/${applicationId}`),
    move: (applicationId: string, body: { stage: RecruitingStage; reason?: string; notifyCandidate?: boolean }) =>
      api.post<{ application: ApplicationDetail; email: { status: string; error: string } | null }>(
        `${base}/applications/${applicationId}/move`,
        body,
      ),
    note: (applicationId: string, body: string) =>
      api.post<ApplicationDetail>(`${base}/applications/${applicationId}/notes`, { body }),
    score: (
      applicationId: string,
      body: {
        ratings: Array<{ criterionId: string; rating: number | null; evidence?: string[]; note?: string }>;
        summary: string;
        strengths?: string[];
        concerns?: string[];
        interviewQuestions?: string[];
      },
    ) => api.post<ApplicationDetail>(`${base}/applications/${applicationId}/scorecards`, body),
    screen: (applicationId: string) => api.post<ApplicationDetail>(`${base}/applications/${applicationId}/screen`, {}),
    deleteApplication: (applicationId: string) => api.del<void>(`${base}/applications/${applicationId}`),
    resumeUrl: (applicationId: string, download = false) =>
      `${base}/applications/${applicationId}/resume${download ? "?download=1" : ""}`,
    grants: () => api.get<{ rows: RecruitingGrantRow[] }>(`${base}/ai-access`),
    setGrant: (employeeId: string, accessLevel: RecruitingAccessLevel) =>
      api.put(`${base}/ai-access/${employeeId}`, { accessLevel }),
    removeGrant: (grantId: string) => api.del(`${base}/ai-access/${grantId}`),
  };
}

/** Upload a manually added candidate, with an optional resume file. */
export async function addCandidate(
  companyId: string,
  openingId: string,
  fields: Record<string, string>,
  resume: File | null,
): Promise<ApplicationDetail> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    // Name and email go even when blank: the route requires both keys, and
    // only once they arrive does the server say which one is missing.
    if (value || key === "name" || key === "email") form.append(key, value);
  }
  if (resume) form.append("resume", resume, resume.name);
  const res = await fetch(`/api/companies/${companyId}/recruiting/openings/${openingId}/applications`, {
    method: "POST",
    credentials: "same-origin",
    body: form,
  });
  const text = await res.text();
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = JSON.parse(text) as { error?: string; fields?: Record<string, string> };
      const field = data.fields ? Object.values(data.fields)[0] : undefined;
      message = field || data.error || message;
    } catch {
      // keep the status message
    }
    throw new Error(message);
  }
  return JSON.parse(text) as ApplicationDetail;
}

// ── How things are called and colored ──────────────────────────────────────

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "accent";

export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/25",
  warn: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/25",
  bad: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/25",
  info: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/25",
  accent: "bg-indigo-50 text-indigo-700 ring-indigo-200 dark:bg-indigo-500/10 dark:text-indigo-300 dark:ring-indigo-500/25",
};

export function stageTone(stage: RecruitingStage): Tone {
  switch (stage) {
    case "applied":
      return "info";
    case "screening":
      return "accent";
    case "interview":
      return "warn";
    case "offer":
      return "good";
    case "hired":
      return "good";
    case "rejected":
      return "bad";
    case "withdrawn":
      return "neutral";
  }
}

export function stageLabel(stage: RecruitingStage): string {
  return RECRUITING_STAGE_LABELS[stage] ?? stage;
}

export function scoreTone(label: ScoreLabel | null): Tone {
  if (label === "strong") return "good";
  if (label === "good") return "accent";
  if (label === "possible") return "warn";
  if (label === "weak") return "bad";
  return "neutral";
}

/** Tailwind classes for a score bar's fill. */
export function scoreBarClass(label: ScoreLabel | null): string {
  if (label === "strong") return "bg-emerald-500";
  if (label === "good") return "bg-indigo-500";
  if (label === "possible") return "bg-amber-500";
  if (label === "weak") return "bg-rose-500";
  return "bg-slate-300";
}

export function scoreLabelText(label: ScoreLabel | null): string {
  return label ? SCORE_LABEL_TEXT[label] : "Not scored";
}

/**
 * What the AI screen's state means for one Application, in a few words — and
 * never a score it does not have: a failed or missing screen reads as "not
 * scored", not as a low number.
 */
export function screenSummary(application: Pick<ApplicationSummary, "screenStatus" | "score" | "scoreLabel">): {
  text: string;
  tone: Tone;
} {
  switch (application.screenStatus) {
    case "queued":
      return { text: "Waiting to be scored", tone: "neutral" };
    case "running":
      return { text: "Scoring now", tone: "info" };
    case "failed":
      return { text: "Could not be scored", tone: "warn" };
    case "scored":
      return {
        text: `${application.score ?? "—"} · ${scoreLabelText(application.scoreLabel)}`,
        tone: scoreTone(application.scoreLabel),
      };
    default:
      return application.score !== null
        ? { text: `${application.score} · ${scoreLabelText(application.scoreLabel)}`, tone: scoreTone(application.scoreLabel) }
        : { text: "Not scored", tone: "neutral" };
  }
}

export const SOURCE_LABELS: Record<ApplicationSummary["source"], string> = {
  careers_site: "Careers site",
  internal: "Internal",
  manual: "Added by a Member",
  sourced: "Sourced by AI",
};

/** "3m", "2h", "5d", "Mar 3" — compact, for lists. */
export function shortAgo(iso: string | null, now = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso);
  const seconds = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 30 * 86_400) return `${Math.floor(seconds / 86_400)}d`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "just now", "3d ago", "on Mar 3" — `shortAgo` worded to sit inside a sentence. */
export function agoLabel(iso: string | null, now = new Date()): string {
  const short = shortAgo(iso, now);
  if (short === "—") return short;
  if (short === "now") return "just now";
  if (/^\d+[mhd]$/.test(short)) return `${short} ago`;
  return `on ${short}`;
}

/** One sentence for one line of an Application's timeline. */
export function describeEvent(event: TimelineEvent): string {
  switch (event.kind) {
    case "applied":
      return `${event.actorName} applied${event.meta.source === "internal" ? " as a Member" : " through the careers site"}`;
    case "added":
      return `${event.actorName} added this candidate`;
    case "stage_changed":
      return `${event.actorName} moved them from ${stageLabel(event.fromStage as RecruitingStage)} to ${stageLabel(
        event.toStage as RecruitingStage,
      )}`;
    case "note":
      return `${event.actorName} wrote a note`;
    case "scored": {
      const score = typeof event.meta.score === "number" ? event.meta.score : null;
      return `${event.actorName} scored them${score !== null ? ` ${score}` : ""}`;
    }
    case "screen_failed":
      return "The AI screen could not finish";
    case "email_sent":
      return `Emailed the candidate: ${event.body}`;
    case "email_failed":
      return "An email to the candidate failed";
    case "email_skipped":
      return "An email to the candidate was not sent";
    case "criteria_drafted":
      return `${event.actorName} drafted the Opening's criteria`;
  }
}

/** The hiring principles box at Recruiting → Settings while someone edits it. */
export function screeningInstructionsEdit(args: {
  draft: string;
  saved: string;
  usingDefault: boolean;
}): InstructionsEditState {
  return instructionsEdit({
    ...args,
    limits: { maxLength: MAX_SCREENING_INSTRUCTIONS_LENGTH, maxLines: MAX_SCREENING_INSTRUCTION_LINES },
    emptyLabel: "No principles of your own — the fairness rule still applies",
  });
}

/**
 * The closed line over an applicant email's editor at Recruiting → Settings:
 * whose wording it is and its subject, so the email reads true while its big
 * editor is tucked away, and an unsaved edit is named (AGENTS.md §8).
 *
 *   { usingDefault: true, subject: "We received…" } → "Default wording · “We received…”"
 */
export function describeApplicantEmail(args: {
  usingDefault: boolean;
  /** The subject as saved (or the default's). */
  subject: string;
  dirty?: boolean;
}): string {
  const parts = [args.usingDefault ? "Default wording" : "Your wording"];
  if (args.subject.trim()) parts.push(`“${args.subject.trim()}”`);
  if (args.dirty) parts.push("unsaved changes");
  return parts.join(" · ");
}

/** Sample values for previewing an applicant email before anyone applies. */
export function sampleEmailValues(companyName: string, siteUrl: string) {
  return {
    first_name: "Ada",
    full_name: "Ada Lovelace",
    opening_title: "Senior Backend Engineer",
    company_name: companyName,
    opening_url: `${siteUrl}/openings/senior-backend-engineer`,
  };
}
