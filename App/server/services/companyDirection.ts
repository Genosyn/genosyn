import type { Company } from "../db/entities/Company.js";

/** Company direction is required before the next AI Employee is hired. */
export function hasCompanyDirection(company: Pick<Company, "mission" | "vision"> | null): boolean {
  return Boolean(company?.mission?.trim() && company?.vision?.trim());
}
