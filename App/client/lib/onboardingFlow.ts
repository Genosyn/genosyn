import type { Company } from "./api";

export type OnboardingStep =
  | "company"
  | "employee"
  | "recommendations"
  | "email"
  | "access"
  | "first_request"
  | "done";

/** What the guide reads from a company to know whether it has said where it is going. */
export type CompanyDirection = Pick<Company, "mission" | "vision" | "hasGoal">;

/**
 * Whether the company has direction, which an AI Employee needs before it is
 * hired: a Goal, or a mission and a vision. The server applies the same rule
 * to the hire itself (`server/services/companyDirection.ts`), so the guide and
 * the route never disagree about whether a company can go on.
 */
export function hasCompanyDirection(company: CompanyDirection): boolean {
  return Boolean(company.hasGoal) || Boolean(company.mission.trim() && company.vision.trim());
}

/** Old bookmarks and skipped steps must still start with the company's direction. */
export function resolveOnboardingStep(
  raw: string | null,
  company: CompanyDirection,
): OnboardingStep {
  if (!hasCompanyDirection(company) || raw === "intro" || raw === "company") return "company";
  if (
    ["employee", "recommendations", "email", "access", "first_request", "done"].includes(raw ?? "")
  ) {
    return raw as OnboardingStep;
  }
  return "employee";
}
