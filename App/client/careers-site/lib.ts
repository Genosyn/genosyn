import {
  EMPLOYMENT_TYPE_LABELS,
  RESUME_EXTENSIONS,
  RESUME_MAX_BYTES,
  WORKPLACE_TYPE_LABELS,
  type EmploymentType,
  type OpeningFormSettings,
  type OpeningQuestion,
  type WorkplaceType,
} from "../../shared/recruiting";
import type { CareersBootstrap, PublicOpeningCard } from "./types";

/**
 * The careers site's pure logic: reading the server's first data, filtering
 * and grouping Openings, wording dates, and checking an application before it
 * is sent. The server checks everything again; these exist so a candidate
 * learns about a missing field before they wait for a round trip.
 */

/** The JSON block the server wrote into the page, or null when there is none. */
export function parseBootstrap(text: string | null | undefined): CareersBootstrap | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as CareersBootstrap;
    if (!value || typeof value !== "object" || typeof value.kind !== "string") return null;
    return {
      kind: value.kind,
      basePath: typeof value.basePath === "string" ? value.basePath : "",
      site: value.site ?? null,
      openings: Array.isArray(value.openings) ? value.openings : [],
      opening: value.opening ?? null,
      signInUrl: typeof value.signInUrl === "string" ? value.signInUrl : "/login",
    };
  } catch {
    return null;
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "Posted today", "Posted 3 days ago", "Posted 2 weeks ago", "Posted Mar 3". */
export function postedLabel(iso: string | null, now = new Date()): string {
  if (!iso) return "";
  const posted = new Date(iso);
  if (Number.isNaN(posted.getTime())) return "";
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(posted)) / DAY_MS);
  if (days <= 0) return "Posted today";
  if (days === 1) return "Posted yesterday";
  if (days < 7) return `Posted ${days} days ago`;
  if (days < 28) {
    const weeks = Math.floor(days / 7);
    return `Posted ${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
  }
  return `Posted ${posted.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: posted.getFullYear() === now.getFullYear() ? undefined : "numeric",
  })}`;
}

/** "Apply by March 3" — or null when the Opening has no closing date. */
export function applyByLabel(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `Apply by ${date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`;
}

export type OpeningFilters = {
  query: string;
  department: string;
  location: string;
  workplace: WorkplaceType | "";
  employmentType: EmploymentType | "";
};

export const EMPTY_FILTERS: OpeningFilters = {
  query: "",
  department: "",
  location: "",
  workplace: "",
  employmentType: "",
};

function fold(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** The Openings matching every filter; the query matches title, summary, department and location. */
export function filterOpenings(openings: PublicOpeningCard[], filters: OpeningFilters): PublicOpeningCard[] {
  const words = fold(filters.query).split(/\s+/).filter(Boolean);
  return openings.filter((opening) => {
    if (filters.department && opening.department !== filters.department) return false;
    if (filters.location && opening.location !== filters.location) return false;
    if (filters.workplace && opening.workplace !== filters.workplace) return false;
    if (filters.employmentType && opening.employmentType !== filters.employmentType) return false;
    if (words.length === 0) return true;
    const haystack = fold(
      [
        opening.title,
        opening.summary,
        opening.department,
        opening.location,
        WORKPLACE_TYPE_LABELS[opening.workplace],
        EMPLOYMENT_TYPE_LABELS[opening.employmentType],
      ].join(" "),
    );
    return words.every((word) => haystack.includes(word));
  });
}

export function hasActiveFilters(filters: OpeningFilters): boolean {
  return Object.values(filters).some((value) => value !== "");
}

/** The distinct non-empty values of one field, sorted, for a filter's choices. */
export function distinctValues(
  openings: PublicOpeningCard[],
  key: "department" | "location" | "workplace" | "employmentType",
): string[] {
  return [...new Set(openings.map((opening) => opening[key]).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

export type OpeningGroup = { department: string; openings: PublicOpeningCard[] };

/**
 * Openings grouped by department, departments alphabetical, the unnamed group
 * last. A site whose Openings name no department gets one untitled group.
 */
export function groupByDepartment(openings: PublicOpeningCard[]): OpeningGroup[] {
  const groups = new Map<string, PublicOpeningCard[]>();
  for (const opening of openings) {
    const key = opening.department.trim();
    groups.set(key, [...(groups.get(key) ?? []), opening]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([department, items]) => ({ department, openings: items }));
}

/**
 * A version-4 UUID for one submit. `crypto.randomUUID` exists only in secure
 * contexts, and a careers domain may be served over plain HTTP while its
 * certificate is set up, so this builds one from `getRandomValues`, which
 * exists everywhere.
 */
export function newSubmissionId(
  random: Pick<Crypto, "getRandomValues"> = globalThis.crypto,
): string {
  const bytes = random.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A brand color at an opacity, for tints the accent itself would be too loud for. */
export function hexToRgba(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  const value = match ? match[1] : "4f46e5";
  const channel = (offset: number) => parseInt(value.slice(offset, offset + 2), 16);
  return `rgba(${channel(0)}, ${channel(2)}, ${channel(4)}, ${alpha})`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = Math.round(bytes / 1024);
  if (kilobytes < 1024) return `${kilobytes} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Why this file cannot be sent as a resume, or null. */
export function resumeFileProblem(file: { name: string; size: number }): string | null {
  const dot = file.name.lastIndexOf(".");
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!(RESUME_EXTENSIONS as readonly string[]).includes(extension)) {
    return "Use a PDF, Word document, OpenDocument, RTF or plain text file.";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > RESUME_MAX_BYTES) return "Keep the resume under 10 MB.";
  return null;
}

export type ApplicationValues = {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedinUrl: string;
  websiteUrl: string;
  coverLetter: string;
  answers: Record<string, string | string[] | boolean>;
  consent: boolean;
};

export const EMPTY_APPLICATION: ApplicationValues = {
  name: "",
  email: "",
  phone: "",
  location: "",
  linkedinUrl: "",
  websiteUrl: "",
  coverLetter: "",
  answers: {},
  consent: false,
};

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;

function looksLikeLink(value: string): boolean {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * Every problem with an application, keyed the way the server names fields,
 * so the server's answer and this check mark the same inputs.
 */
export function validateApplication(
  values: ApplicationValues,
  form: OpeningFormSettings,
  questions: OpeningQuestion[],
  resume: { name: string; size: number } | null,
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!values.name.trim()) errors.name = "Enter your name.";
  if (!EMAIL.test(values.email.trim())) errors.email = "Enter an email address, like ada@example.com.";
  const required = (key: "phone" | "location" | "linkedin" | "website" | "coverLetter", value: string) => {
    if (form[key] === "required" && !value.trim()) errors[key] = "This is required.";
  };
  required("phone", values.phone);
  required("location", values.location);
  required("linkedin", values.linkedinUrl);
  required("website", values.websiteUrl);
  required("coverLetter", values.coverLetter);
  if (values.phone.trim() && (values.phone.match(/\d/g)?.length ?? 0) < 6) {
    errors.phone = "Enter a phone number, like +1 415 555 0100.";
  }
  if (values.linkedinUrl.trim() && !looksLikeLink(values.linkedinUrl.trim())) {
    errors.linkedin = "Enter a link, like https://www.linkedin.com/in/you.";
  }
  if (values.websiteUrl.trim() && !looksLikeLink(values.websiteUrl.trim())) {
    errors.website = "Enter a link, like https://example.com.";
  }
  if (form.resume === "required" && !resume) errors.resume = "Attach your resume.";
  if (resume) {
    const problem = resumeFileProblem(resume);
    if (problem) errors.resume = problem;
  }
  for (const question of questions) {
    const answer = values.answers[question.id];
    const empty =
      answer === undefined ||
      (typeof answer === "string" && !answer.trim()) ||
      (Array.isArray(answer) && answer.length === 0);
    if (empty) {
      if (question.required) errors[`answers.${question.id}`] = "This question needs an answer.";
      continue;
    }
    if (question.kind === "number" && typeof answer === "string" && !Number.isFinite(Number(answer.trim()))) {
      errors[`answers.${question.id}`] = "Answer with a number.";
    }
    if (question.kind === "url" && typeof answer === "string" && !looksLikeLink(answer.trim())) {
      errors[`answers.${question.id}`] = "Answer with a web address, like https://example.com.";
    }
  }
  if (!values.consent) errors.consent = "Agree to how your application will be used to continue.";
  return errors;
}

/** The answers as the server takes them: numbers as numbers, yes/no as booleans. */
export function answersPayload(
  questions: OpeningQuestion[],
  answers: ApplicationValues["answers"],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer === undefined) continue;
    if (question.kind === "number" && typeof answer === "string") {
      payload[question.id] = answer.trim() === "" ? null : Number(answer.trim());
    } else {
      payload[question.id] = answer;
    }
  }
  return payload;
}
