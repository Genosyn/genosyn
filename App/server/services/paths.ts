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

/**
 * Where an employee's per-provider credentials live. Set as the provider's
 * config-dir env var when spawning the CLI so each employee has its own
 * signed-in session, scoped to the employee's directory. Firing the employee
 * (or disconnecting the model) removes this.
 *
 * - claude-code → <employee>/.claude
 * - codex       → <employee>/.codex
 * - opencode    → <employee>/.opencode   (treated as XDG_DATA_HOME)
 */
export function employeeClaudeDir(
  companySlug: string,
  employeeSlug: string,
): string {
  return path.join(employeeDir(companySlug, employeeSlug), ".claude");
}

export function claudeCredsPath(
  companySlug: string,
  employeeSlug: string,
): string {
  return path.join(employeeClaudeDir(companySlug, employeeSlug), ".credentials.json");
}

export function employeeCodexDir(
  companySlug: string,
  employeeSlug: string,
): string {
  return path.join(employeeDir(companySlug, employeeSlug), ".codex");
}

export function codexCredsPath(
  companySlug: string,
  employeeSlug: string,
): string {
  // Codex CLI writes auth.json inside $CODEX_HOME once `codex login` succeeds.
  return path.join(employeeCodexDir(companySlug, employeeSlug), "auth.json");
}

export function employeeOpencodeDir(
  companySlug: string,
  employeeSlug: string,
): string {
  return path.join(employeeDir(companySlug, employeeSlug), ".opencode");
}

export function opencodeCredsPath(
  companySlug: string,
  employeeSlug: string,
): string {
  // opencode follows XDG conventions: with XDG_DATA_HOME=<dir>, auth lands at
  // <dir>/opencode/auth.json. We point XDG_DATA_HOME at `.opencode` so the
  // creds file ends up at `.opencode/opencode/auth.json`.
  return path.join(employeeOpencodeDir(companySlug, employeeSlug), "opencode", "auth.json");
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
