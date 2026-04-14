import path from "node:path";
import fs from "node:fs";
import { config } from "../../config.js";

export function dataRoot(): string {
  return path.resolve(config.dataDir);
}

export function companyDir(companySlug: string): string {
  return path.join(dataRoot(), "companies", companySlug);
}

export function employeeDir(companySlug: string, employeeSlug: string): string {
  return path.join(companyDir(companySlug), "employees", employeeSlug);
}

export function soulPath(companySlug: string, employeeSlug: string): string {
  return path.join(employeeDir(companySlug, employeeSlug), "SOUL.md");
}

export function skillDir(companySlug: string, employeeSlug: string, skillSlug: string): string {
  return path.join(employeeDir(companySlug, employeeSlug), "skills", skillSlug);
}

export function skillReadme(companySlug: string, employeeSlug: string, skillSlug: string): string {
  return path.join(skillDir(companySlug, employeeSlug, skillSlug), "README.md");
}

export function routineDir(
  companySlug: string,
  employeeSlug: string,
  routineSlug: string,
): string {
  return path.join(employeeDir(companySlug, employeeSlug), "routines", routineSlug);
}

export function routineReadme(
  companySlug: string,
  employeeSlug: string,
  routineSlug: string,
): string {
  return path.join(routineDir(companySlug, employeeSlug, routineSlug), "README.md");
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
