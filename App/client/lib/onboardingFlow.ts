import type { Company } from "./api";

export type OnboardingStep =
  | "company"
  | "employee"
  | "recommendations"
  | "email"
  | "first_request"
  | "done";

export function hasCompanyDirection(company: Pick<Company, "mission" | "vision">): boolean {
  return Boolean(company.mission.trim() && company.vision.trim());
}

/** Old bookmarks and skipped steps must still start with the company's direction. */
export function resolveOnboardingStep(
  raw: string | null,
  company: Pick<Company, "mission" | "vision">,
): OnboardingStep {
  if (!hasCompanyDirection(company) || raw === "intro" || raw === "company") return "company";
  if (["employee", "recommendations", "email", "first_request", "done"].includes(raw ?? "")) {
    return raw as OnboardingStep;
  }
  return "employee";
}
