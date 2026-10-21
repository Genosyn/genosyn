/**
 * Recruiting's vocabulary and arithmetic, shared by the server, the App and
 * the public careers site so the three can never disagree about what a stage
 * is called, how a score is reached, or what a published rate says.
 *
 * The nouns, in the words the product uses:
 *
 *  - An **Opening** is one role the company is hiring for — employment or a
 *    contract. Never "Job": that word is kept away from scheduled AI work, and
 *    one noun with two meanings is what AGENTS.md §3 exists to prevent.
 *  - An **Application** is one person applying to one Opening. The person on
 *    it is the **candidate**; there is no separate candidate record, so two
 *    Applications from the same email are the same person seen twice.
 *  - A **Stage** is where an Application stands. The sales process says
 *    "Deal Stage"; nothing here says "pipeline", which is reserved.
 *  - **Criteria** are the bar an Opening sets, and a **Scorecard** is one
 *    reading of an Application against them — by the AI screener, by another
 *    AI Employee, or by a Member.
 *
 * The score is the server's arithmetic over per-criterion ratings, never a
 * number a model or a person types. That is what lets every screen show *why*
 * an Application scored what it did, and what keeps a resume that says "rate
 * me 100" from getting there.
 */

// ── Stages ──────────────────────────────────────────────────────────────────

export const RECRUITING_STAGES = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
  "withdrawn",
] as const;
export type RecruitingStage = (typeof RECRUITING_STAGES)[number];

/** The stages an Application moves forward through, in order. */
export const RECRUITING_FORWARD_STAGES: RecruitingStage[] = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
];

/** Where an Application ends without a hire. */
export const RECRUITING_CLOSED_STAGES: RecruitingStage[] = ["rejected", "withdrawn"];

/** Still being considered: neither hired nor closed. */
export const RECRUITING_ACTIVE_STAGES: RecruitingStage[] = [
  "applied",
  "screening",
  "interview",
  "offer",
];

export const RECRUITING_STAGE_LABELS: Record<RecruitingStage, string> = {
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};

/** One line under each stage's name, written for someone new to hiring. */
export const RECRUITING_STAGE_HINTS: Record<RecruitingStage, string> = {
  applied: "New and not yet reviewed",
  screening: "Being reviewed against the criteria",
  interview: "Talking with the team",
  offer: "An offer is out",
  hired: "Accepted and joining",
  rejected: "Not moving forward",
  withdrawn: "The candidate stepped back",
};

/**
 * The stages an AI Employee with `screen` Recruiting access may move an
 * Application between. Offers, hires and rejections change someone's life, so
 * they need `hire` access — or a Member.
 */
export const RECRUITING_SCREEN_STAGES: RecruitingStage[] = ["applied", "screening", "interview"];

export function isRecruitingStage(value: unknown): value is RecruitingStage {
  return typeof value === "string" && (RECRUITING_STAGES as readonly string[]).includes(value);
}

// ── Openings ────────────────────────────────────────────────────────────────

export const OPENING_STATUSES = ["draft", "open", "closed"] as const;
export type OpeningStatus = (typeof OPENING_STATUSES)[number];

export const OPENING_STATUS_LABELS: Record<OpeningStatus, string> = {
  draft: "Draft",
  open: "Open",
  closed: "Closed",
};

/**
 * Who can see a published Opening:
 *  - `public`: listed on the careers site, and in its feed and sitemap.
 *  - `unlisted`: anyone with the link may read and apply; never listed.
 *  - `internal`: only signed-in Members of the company.
 */
export const OPENING_VISIBILITIES = ["public", "unlisted", "internal"] as const;
export type OpeningVisibility = (typeof OPENING_VISIBILITIES)[number];

export const OPENING_VISIBILITY_LABELS: Record<OpeningVisibility, string> = {
  public: "Public",
  unlisted: "Unlisted",
  internal: "Internal",
};

export const OPENING_VISIBILITY_HINTS: Record<OpeningVisibility, string> = {
  public: "Listed on the careers site for anyone to find",
  unlisted: "Anyone with the link can apply; not listed",
  internal: "Only Members of the company can see and apply",
};

export const EMPLOYMENT_TYPES = [
  "full_time",
  "part_time",
  "contract",
  "internship",
  "temporary",
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contract: "Contract",
  internship: "Internship",
  temporary: "Temporary",
};

/** schema.org `employmentType` values, for the JSON-LD job search engines read. */
export const EMPLOYMENT_TYPE_SCHEMA_ORG: Record<EmploymentType, string> = {
  full_time: "FULL_TIME",
  part_time: "PART_TIME",
  contract: "CONTRACTOR",
  internship: "INTERN",
  temporary: "TEMPORARY",
};

export const WORKPLACE_TYPES = ["onsite", "hybrid", "remote"] as const;
export type WorkplaceType = (typeof WORKPLACE_TYPES)[number];

export const WORKPLACE_TYPE_LABELS: Record<WorkplaceType, string> = {
  onsite: "On-site",
  hybrid: "Hybrid",
  remote: "Remote",
};

export const COMPENSATION_PERIODS = ["hour", "day", "week", "month", "year", "project"] as const;
export type CompensationPeriod = (typeof COMPENSATION_PERIODS)[number];

export const COMPENSATION_PERIOD_LABELS: Record<CompensationPeriod, string> = {
  hour: "per hour",
  day: "per day",
  week: "per week",
  month: "per month",
  year: "per year",
  project: "for the project",
};

/** schema.org `unitText` for a `baseSalary` QuantitativeValue. */
export const COMPENSATION_PERIOD_SCHEMA_ORG: Record<CompensationPeriod, string | null> = {
  hour: "HOUR",
  day: "DAY",
  week: "WEEK",
  month: "MONTH",
  year: "YEAR",
  project: null,
};

export type OpeningCompensation = {
  /** Minor units (cents), so an hourly rate of 37.50 is exact. Null when unpublished. */
  minMinor: number | null;
  maxMinor: number | null;
  currency: string;
  period: CompensationPeriod;
};

function formatMoney(minor: number, currency: string): string {
  const major = minor / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(major) ? 0 : 2,
      minimumFractionDigits: Number.isInteger(major) ? 0 : 2,
    }).format(major);
  } catch {
    return `${major.toLocaleString("en-US")} ${currency}`;
  }
}

/**
 * The published rate as one phrase — "$120,000 – $150,000 per year",
 * "From $45 per hour", "$8,000 for the project" — or null when the Opening
 * publishes none.
 */
export function formatCompensation(compensation: OpeningCompensation): string | null {
  const { minMinor, maxMinor, currency, period } = compensation;
  const suffix = COMPENSATION_PERIOD_LABELS[period] ?? "";
  if (minMinor === null && maxMinor === null) return null;
  if (minMinor !== null && maxMinor !== null) {
    if (minMinor === maxMinor) return `${formatMoney(minMinor, currency)} ${suffix}`.trim();
    return `${formatMoney(minMinor, currency)} – ${formatMoney(maxMinor, currency)} ${suffix}`.trim();
  }
  if (minMinor !== null) return `From ${formatMoney(minMinor, currency)} ${suffix}`.trim();
  return `Up to ${formatMoney(maxMinor as number, currency)} ${suffix}`.trim();
}

/** "Full-time · Remote · Berlin" — the line under an Opening's title. */
export function openingMetaLine(opening: {
  employmentType: EmploymentType;
  workplace: WorkplaceType;
  location: string;
  department?: string;
}): string {
  return [
    opening.department?.trim() || null,
    EMPLOYMENT_TYPE_LABELS[opening.employmentType] ?? null,
    WORKPLACE_TYPE_LABELS[opening.workplace] ?? null,
    opening.location.trim() || null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── The application form ───────────────────────────────────────────────────

/** Whether a standard field on the form is asked for, and whether it must be answered. */
export const FORM_FIELD_MODES = ["required", "optional", "hidden"] as const;
export type FormFieldMode = (typeof FORM_FIELD_MODES)[number];

export type OpeningFormSettings = {
  phone: FormFieldMode;
  location: FormFieldMode;
  linkedin: FormFieldMode;
  website: FormFieldMode;
  /** Never "hidden": a recruiting product that cannot take a resume is not one. */
  resume: Exclude<FormFieldMode, "hidden">;
  coverLetter: FormFieldMode;
};

export const DEFAULT_OPENING_FORM: OpeningFormSettings = {
  phone: "optional",
  location: "optional",
  linkedin: "optional",
  website: "optional",
  resume: "required",
  coverLetter: "optional",
};

/** Fill a stored form object's gaps from the defaults; unknown values fall back too. */
export function normalizeOpeningForm(value: unknown): OpeningFormSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const mode = (key: keyof OpeningFormSettings): FormFieldMode => {
    const candidate = raw[key];
    return typeof candidate === "string" &&
      (FORM_FIELD_MODES as readonly string[]).includes(candidate)
      ? (candidate as FormFieldMode)
      : DEFAULT_OPENING_FORM[key];
  };
  const resume = mode("resume");
  return {
    phone: mode("phone"),
    location: mode("location"),
    linkedin: mode("linkedin"),
    website: mode("website"),
    resume: resume === "hidden" ? "optional" : resume,
    coverLetter: mode("coverLetter"),
  };
}

export const OPENING_QUESTION_KINDS = [
  "short_text",
  "long_text",
  "yes_no",
  "single_select",
  "multi_select",
  "number",
  "url",
] as const;
export type OpeningQuestionKind = (typeof OPENING_QUESTION_KINDS)[number];

export const OPENING_QUESTION_KIND_LABELS: Record<OpeningQuestionKind, string> = {
  short_text: "Short answer",
  long_text: "Paragraph",
  yes_no: "Yes / No",
  single_select: "One choice",
  multi_select: "Several choices",
  number: "Number",
  url: "Link",
};

export type OpeningQuestion = {
  id: string;
  label: string;
  help: string;
  kind: OpeningQuestionKind;
  required: boolean;
  /** Choices for the two select kinds; empty otherwise. */
  options: string[];
};

export const MAX_OPENING_QUESTIONS = 20;
export const MAX_QUESTION_OPTIONS = 20;
export const MAX_ANSWER_CHARS = 5_000;

export type ApplicationAnswer = {
  questionId: string;
  /** The question as it was asked, so a later edit cannot change what was answered. */
  label: string;
  kind: OpeningQuestionKind;
  value: string | number | boolean | string[] | null;
};

/** An answer as one readable line, for timelines, emails and AI prompts. */
export function formatAnswerValue(answer: Pick<ApplicationAnswer, "kind" | "value">): string {
  const { value } = answer;
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

// ── Criteria and scoring ────────────────────────────────────────────────────

export const CRITERION_IMPORTANCES = ["must_have", "important", "nice_to_have"] as const;
export type CriterionImportance = (typeof CRITERION_IMPORTANCES)[number];

export const CRITERION_IMPORTANCE_LABELS: Record<CriterionImportance, string> = {
  must_have: "Must have",
  important: "Important",
  nice_to_have: "Nice to have",
};

/** How much each criterion counts toward the score. */
export const CRITERION_WEIGHTS: Record<CriterionImportance, number> = {
  must_have: 3,
  important: 2,
  nice_to_have: 1,
};

export type OpeningCriterion = {
  id: string;
  name: string;
  /** What meeting the bar looks like, in a sentence or two. */
  description: string;
  importance: CriterionImportance;
};

export const MAX_OPENING_CRITERIA = 12;

/**
 * Four points, each with a meaning a person can apply the same way twice. A
 * finer scale reads as precise and is not: nobody agrees on a 6 versus a 7.
 */
export const CRITERION_RATINGS = [0, 1, 2, 3] as const;
export type CriterionRating = (typeof CRITERION_RATINGS)[number];

export const CRITERION_RATING_LABELS: Record<CriterionRating, string> = {
  0: "Not shown",
  1: "Partly",
  2: "Meets",
  3: "Exceeds",
};

export const CRITERION_RATING_HINTS: Record<CriterionRating, string> = {
  0: "The application shows no evidence of this, or evidence against it",
  1: "Some related evidence, but below the bar",
  2: "Clear evidence that meets the bar",
  3: "Clear evidence well beyond the bar",
};

export const MAX_RATING = 3;

export const SCORE_LABELS = ["strong", "good", "possible", "weak"] as const;
export type ScoreLabel = (typeof SCORE_LABELS)[number];

export const SCORE_LABEL_TEXT: Record<ScoreLabel, string> = {
  strong: "Strong match",
  good: "Good match",
  possible: "Possible match",
  weak: "Weak match",
};

/** The lowest score that earns each label, before must-haves cap it. */
export const SCORE_LABEL_FLOORS: Record<Exclude<ScoreLabel, "weak">, number> = {
  strong: 80,
  good: 60,
  possible: 40,
};

export type CriterionRatingInput = {
  criterionId: string;
  rating: CriterionRating;
};

export type ScoreBreakdownRow = {
  criterionId: string;
  name: string;
  importance: CriterionImportance;
  weight: number;
  rating: CriterionRating | null;
  /** Points this criterion earned toward the total, out of `possible`. */
  earned: number;
  possible: number;
};

export type ScoreResult = {
  /** 0–100, or null when the Opening has no criteria to score against. */
  score: number | null;
  label: ScoreLabel | null;
  rows: ScoreBreakdownRow[];
  /** Must-haves rated "Not shown": the label is Weak whatever the score. */
  missingMustHaves: string[];
  /** Must-haves rated "Partly": the label is at most Possible. */
  partialMustHaves: string[];
  /** Criteria the scorecard left unrated; they earn nothing. */
  unrated: string[];
};

/** The label a score earns on its own, before must-haves are considered. */
export function labelForScore(score: number): ScoreLabel {
  if (score >= SCORE_LABEL_FLOORS.strong) return "strong";
  if (score >= SCORE_LABEL_FLOORS.good) return "good";
  if (score >= SCORE_LABEL_FLOORS.possible) return "possible";
  return "weak";
}

const LABEL_RANK: Record<ScoreLabel, number> = { strong: 3, good: 2, possible: 1, weak: 0 };

/**
 * The score for a set of ratings against an Opening's criteria:
 * `round(100 × Σ weight × rating ÷ (3 × Σ weight))`.
 *
 * A must-have rated "Not shown" makes the label Weak whatever the total, and
 * one rated "Partly" caps it at Possible — a candidate cannot average their
 * way past a bar the Opening said is not negotiable. A criterion with no
 * rating earns nothing and is listed, so a thin scorecard reads as thin.
 * Ratings for criteria the Opening no longer has are ignored.
 */
export function computeScore(
  criteria: OpeningCriterion[],
  ratings: CriterionRatingInput[],
): ScoreResult {
  if (criteria.length === 0) {
    return {
      score: null,
      label: null,
      rows: [],
      missingMustHaves: [],
      partialMustHaves: [],
      unrated: [],
    };
  }
  const byId = new Map<string, CriterionRating>();
  for (const entry of ratings) {
    if ((CRITERION_RATINGS as readonly number[]).includes(entry.rating)) {
      byId.set(entry.criterionId, entry.rating);
    }
  }
  let earned = 0;
  let possible = 0;
  const rows: ScoreBreakdownRow[] = [];
  const missingMustHaves: string[] = [];
  const partialMustHaves: string[] = [];
  const unrated: string[] = [];
  for (const criterion of criteria) {
    const weight = CRITERION_WEIGHTS[criterion.importance] ?? 1;
    const rating = byId.has(criterion.id) ? (byId.get(criterion.id) as CriterionRating) : null;
    const rowPossible = weight * MAX_RATING;
    const rowEarned = rating === null ? 0 : weight * rating;
    earned += rowEarned;
    possible += rowPossible;
    rows.push({
      criterionId: criterion.id,
      name: criterion.name,
      importance: criterion.importance,
      weight,
      rating,
      earned: rowEarned,
      possible: rowPossible,
    });
    if (rating === null) unrated.push(criterion.name);
    if (criterion.importance === "must_have") {
      if (rating === 0) missingMustHaves.push(criterion.name);
      else if (rating === 1) partialMustHaves.push(criterion.name);
    }
  }
  const score = possible > 0 ? Math.round((100 * earned) / possible) : 0;
  let label = labelForScore(score);
  if (missingMustHaves.length > 0) label = "weak";
  else if (partialMustHaves.length > 0 && LABEL_RANK[label] > LABEL_RANK.possible) {
    label = "possible";
  }
  return { score, label, rows, missingMustHaves, partialMustHaves, unrated };
}

/**
 * A stable fingerprint of the criteria a Scorecard was written against, so a
 * screen can say "the criteria changed since this was scored" instead of
 * silently comparing a score to a bar it never saw. Order does not count: the
 * score does not depend on it, so moving a criterion up or down moves no bar.
 */
export function criteriaFingerprint(criteria: OpeningCriterion[]): string {
  const canonical = [...criteria]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((criterion) =>
      [criterion.id, criterion.name.trim(), criterion.description.trim(), criterion.importance].join(
        "\u0001",
      ),
    )
    .join("\u0002");
  // FNV-1a, 32-bit: a fingerprint, not a security boundary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ── Access ─────────────────────────────────────────────────────────────────

/**
 * What an AI Employee may do in Recruiting, granted at Recruiting → AI access:
 *  - `read`: see Openings, Applications, resumes and Scorecards.
 *  - `screen`: also score Applications, write notes, move them between
 *    Applied, Screening and Interview, and draft Openings.
 *  - `hire`: also publish and close Openings, and make offers, hires and
 *    rejections — including the rejection email the company wrote.
 */
export const RECRUITING_ACCESS_LEVELS = ["read", "screen", "hire"] as const;
export type RecruitingAccessLevel = (typeof RECRUITING_ACCESS_LEVELS)[number];

export const RECRUITING_ACCESS_RANK: Record<RecruitingAccessLevel, number> = {
  read: 0,
  screen: 1,
  hire: 2,
};

export const RECRUITING_ACCESS_LABELS: Record<RecruitingAccessLevel, string> = {
  read: "Read",
  screen: "Screen",
  hire: "Hire",
};

export const RECRUITING_ACCESS_HINTS: Record<RecruitingAccessLevel, string> = {
  read: "See Openings, applicants, resumes and scores.",
  screen: "Also score applicants, write notes, move them up to Interview, and draft Openings.",
  hire: "Also publish and close Openings, make offers, hires and rejections, and take any of them back.",
};

// ── Applicant emails ───────────────────────────────────────────────────────

export const DEFAULT_CONFIRMATION_EMAIL_SUBJECT = "We received your application for {{opening_title}}";

export const DEFAULT_CONFIRMATION_EMAIL_BODY = [
  "Hi {{first_name}},",
  "",
  "Thank you for applying for the {{opening_title}} role at {{company_name}}. We have received your application, and we will get back to you as soon as we can.",
  "",
  "You can read the opening again at any time: {{opening_url}}",
  "",
  "The {{company_name}} team",
].join("\n");

export const DEFAULT_REJECTION_EMAIL_SUBJECT = "Your application for {{opening_title}}";

export const DEFAULT_REJECTION_EMAIL_BODY = [
  "Hi {{first_name}},",
  "",
  "Thank you for your interest in the {{opening_title}} role at {{company_name}}, and for the time you put into applying. After careful review, we have decided not to move forward with your application.",
  "",
  "We are grateful you considered us, and we wish you the very best.",
  "",
  "The {{company_name}} team",
].join("\n");

export const EMAIL_TEMPLATE_PLACEHOLDERS = [
  "first_name",
  "full_name",
  "opening_title",
  "company_name",
  "opening_url",
] as const;
export type EmailTemplatePlaceholder = (typeof EMAIL_TEMPLATE_PLACEHOLDERS)[number];

export const MAX_EMAIL_SUBJECT_CHARS = 200;
export const MAX_EMAIL_BODY_CHARS = 5_000;

/** The first word of a name, for "Hi Ada,"; "there" when nobody gave one. */
export function firstNameOf(fullName: string): string {
  const first = fullName.trim().split(/\s+/)[0] ?? "";
  return first || "there";
}

/**
 * Fill `{{placeholder}}` slots. Unknown placeholders are left as written, so a
 * typo shows up in the preview instead of vanishing from a sent email.
 */
export function renderEmailTemplate(
  template: string,
  values: Record<EmailTemplatePlaceholder, string>,
): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (match, key: string) =>
    (EMAIL_TEMPLATE_PLACEHOLDERS as readonly string[]).includes(key)
      ? values[key as EmailTemplatePlaceholder]
      : match,
  );
}

/** Null keeps following the current default; an empty string is a deliberate choice. */
export function effectiveTemplate(stored: string | null | undefined, fallback: string): string {
  return stored === null || stored === undefined ? fallback : stored;
}

// ── The screener's instructions ─────────────────────────────────────────────

/**
 * What the AI screener follows until an owner or admin writes the company's
 * own. The fairness rule is also built into every screening prompt, so a
 * company that deletes these lines cannot turn it off.
 */
export const DEFAULT_SCREENING_INSTRUCTIONS = [
  "Judge only what the application shows about each criterion: skills, experience and work the person describes.",
  "Never consider age, gender, race, religion, nationality, disability, family status, or anything that hints at them.",
  "Do not hold career gaps, career changes or an unusual path against anyone; look at what the person can do.",
  "When the application says nothing about a criterion, rate it Not shown instead of guessing.",
].join("\n");

export const MAX_SCREENING_INSTRUCTIONS_LENGTH = 4_000;
export const MAX_SCREENING_INSTRUCTION_LINES = 30;

// ── Careers site ───────────────────────────────────────────────────────────

export const SITE_VISIBILITIES = ["public", "internal"] as const;
export type SiteVisibility = (typeof SITE_VISIBILITIES)[number];

export const DEFAULT_ACCENT_COLOR = "#4f46e5";

/** `#rgb` or `#rrggbb`, normalized to lower-case six digits, or null. */
export function normalizeAccentColor(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(trimmed);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  return /^#[0-9a-f]{6}$/.test(trimmed) ? trimmed : null;
}

/**
 * Black or white, whichever reads better on the accent — the button text on a
 * company's brand color. WCAG relative luminance, with the usual 0.179 cut.
 */
export function accentForeground(hex: string): "#000000" | "#ffffff" {
  const normalized = normalizeAccentColor(hex) ?? DEFAULT_ACCENT_COLOR;
  const channel = (offset: number) => {
    const value = parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  return luminance > 0.179 ? "#000000" : "#ffffff";
}

/** Application files a careers site accepts, by extension. */
export const RESUME_EXTENSIONS = [".pdf", ".docx", ".doc", ".txt", ".md", ".rtf", ".odt"] as const;
export const RESUME_MAX_BYTES = 10 * 1024 * 1024;
