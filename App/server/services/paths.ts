import path from "node:path";
import fs from "node:fs";
import { config } from "../../config.js";

/**
 * Filesystem layout for runtime artifacts.
 *
 * Soul / Skill / Routine prose and Run logs live in the DB; model credentials
 * (API keys / custom-endpoint URLs) live encrypted in `AIModel.configJson`.
 * There are no per-provider credential dirs any more — the agent talks to model
 * APIs in-process. What remains on disk under
 * `data/companies/<co>/employees/<emp>/` is the employee's working directory:
 * materialized git repos, chat/tool artifacts, and the browser storage-state
 * snapshot.
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

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Per-employee browser-storage snapshot. We persist Playwright's
 * `storageState()` here (cookies + localStorage + sessionStorage) so an
 * employee that logged into X.com once stays logged in for every future
 * conversation and routine, even across container restarts. One file per
 * employee — concurrent sessions of the same employee race on save and
 * last-writer-wins, which is fine for "is the user logged in" state.
 */
export function employeeBrowserStateFile(
  companySlug: string,
  employeeSlug: string,
): string {
  return path.join(employeeDir(companySlug, employeeSlug), ".browser-state.json");
}
