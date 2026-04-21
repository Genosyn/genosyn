import path from "node:path";
import fs from "node:fs";
import { config } from "../../config.js";

/**
 * Filesystem layout for runtime artifacts.
 *
 * Soul / Skill / Routine prose and Run logs live in the DB now. What remains
 * on disk under `data/companies/<co>/employees/<emp>/` is:
 *
 *   - `.claude` / `.codex` / `.opencode` — per-employee provider credentials
 *     (the CLIs need real files; we can't put these in the DB).
 *   - `.mcp.json` — materialized before each spawn so the CLI sees the tools.
 *   - anything the CLI writes into its cwd during a routine / chat run.
 */

export function dataRoot(): string {
  return path.resolve(config.dataDir);
}

export function companyDir(companySlug: string): string {
  return path.join(dataRoot(), "companies", companySlug);
}

export function employeeDir(companySlug: string, employeeSlug: string): string {
  return path.join(companyDir(companySlug), "employees", employeeSlug);
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
