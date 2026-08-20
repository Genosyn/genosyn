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
 * `data/companies/<co>/employees/<emp>/` is the employee's model-visible
 * working directory: materialized git repos and chat/tool artifacts. Browser
 * storage state is App-private under `data/.private/browser-state/` so neither
 * host file tools nor bubblewrapped bash can read authenticated cookies.
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
export function employeeBrowserStateFile(companyId: string, employeeId: string): string {
  return path.join(browserPrivateCompanyDir(companyId), `${employeeId}.json`);
}

export function browserPrivateCompanyDir(companyId: string): string {
  return path.join(dataRoot(), ".private", "browser-state", companyId);
}

/**
 * App-private browser recordings captured for Routine Runs.
 *
 * Recordings sit beside other private browser material, never in an AI
 * Employee's model-visible working directory. IDs are used instead of slugs
 * so renames cannot strand data and deletion can be scoped without a lookup.
 */
export function browserRecordingsCompanyDir(companyId: string): string {
  return path.join(dataRoot(), ".private", "browser-recordings", companyId);
}

export function browserRecordingRunDir(companyId: string, runId: string): string {
  return path.join(browserRecordingsCompanyDir(companyId), runId);
}

export function browserRecordingFile(
  companyId: string,
  runId: string,
  sessionId: string,
): string {
  return path.join(browserRecordingRunDir(companyId, runId), `${sessionId}.mp4`);
}

/**
 * The employee's own Chrome profile directory — cookies, cache, IndexedDB,
 * service workers, the lot.
 *
 * Deliberately a sibling of {@link employeeBrowserStateFile} under
 * `.private/browser-state/<companyId>/`, for two reasons. It inherits the
 * company-delete sweep that already removes that tree, and it stays out of
 * `employeeDir()` — the workspace an employee's own coding tools and
 * bubblewrapped bash can read. A raw Chrome profile is the most sensitive
 * artifact this app writes: the Cookies SQLite holds a live session for every
 * site the employee has ever signed into, and an employee that can read its own
 * profile can exfiltrate all of them.
 */
export function employeeBrowserProfileDir(companyId: string, employeeId: string): string {
  return path.join(browserPrivateCompanyDir(companyId), `${employeeId}.profile`);
}

/**
 * Where meeting recordings live.
 *
 * App-private, under `.private/`, rather than in the company tree an AI
 * Employee's coding tools can reach. A recording is the rawest customer data
 * this app holds — voices, names, prices, whatever got said before somebody
 * realised they were being recorded — and an employee should reach it through
 * the meeting tools that check a grant, never by listing a directory.
 */
export function meetingRecordingsCompanyDir(companyId: string): string {
  return path.join(dataRoot(), ".private", "meeting-recordings", companyId);
}

/**
 * App-private SSH host-key cache for server-owned repository operations.
 *
 * The directory name still says `code-repository-ssh` after the Code →
 * Repository rename. It is an on-disk path in every existing install and
 * renaming it would strand those caches for no user-visible gain.
 */
export function repositoryPrivateCompanyDir(companyId: string): string {
  return path.join(dataRoot(), ".private", "code-repository-ssh", companyId);
}

/**
 * Root of the App-owned checkout for one Repository — the working copy the
 * web UI reads, edits, commits, and pushes from.
 *
 * It lives under `.private/` for the same reason browser state does: nothing
 * a model can reach may ever write here. That is the whole basis on which
 * this tree is allowed to hold a credentialed `origin` and to run Git without
 * the coding-runtime gate (see `runWorkspaceGit`'s `serverOwned` option).
 * Employee checkouts stay where they were, under the employee's own working
 * directory, and are still materialized credential-free.
 *
 * Keyed by repository id rather than slug so a rename never orphans a
 * checkout. The checkout itself is the `checkout/` child, leaving the parent
 * free as the workspace root that clone/fetch pin their containment checks
 * against.
 */
export function repositoryWorkspaceRoot(companyId: string, repositoryId: string): string {
  return path.join(dataRoot(), ".private", "repositories", companyId, repositoryId);
}

export function repositoryWorkspaceCheckout(companyId: string, repositoryId: string): string {
  return path.join(repositoryWorkspaceRoot(companyId, repositoryId), "checkout");
}

export function repositoryWorkspaceCompanyDir(companyId: string): string {
  return path.join(dataRoot(), ".private", "repositories", companyId);
}

export function employeeRepositoryKnownHostsFile(companyId: string, employeeId: string): string {
  return path.join(repositoryPrivateCompanyDir(companyId), `${employeeId}.known_hosts`);
}

/** Pre-1.94 location, used only for one-way secure migration and cleanup. */
export function legacyEmployeeBrowserStateFile(companySlug: string, employeeSlug: string): string {
  return path.join(employeeDir(companySlug, employeeSlug), ".browser-state.json");
}
