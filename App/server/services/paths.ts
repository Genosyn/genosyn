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
 * - goose       → <employee>/.goose      (treated as XDG_CONFIG_HOME)
 * - openclaw    → <employee>/.openclaw   (OPENCLAW_STATE_DIR; OPENCLAW_CONFIG_PATH points at openclaw.json inside it)
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

export function employeeGooseDir(
  companySlug: string,
  employeeSlug: string,
): string {
  return path.join(employeeDir(companySlug, employeeSlug), ".goose");
}

export function gooseCredsPath(
  companySlug: string,
  employeeSlug: string,
): string {
  // goose follows XDG conventions for its config: with XDG_CONFIG_HOME=<dir>,
  // it reads/writes <dir>/goose/config.yaml. We point XDG_CONFIG_HOME at the
  // employee's `.goose` so the file lands at `.goose/goose/config.yaml`.
  // Spawns also set GOOSE_DISABLE_KEYRING=1 so provider keys end up in this
  // file rather than the host's OS keychain — without that the per-employee
  // isolation breaks, since the keychain is shared across all employees.
  return path.join(employeeGooseDir(companySlug, employeeSlug), "goose", "config.yaml");
}

export function employeeOpenclawDir(
  companySlug: string,
  employeeSlug: string,
): string {
  return path.join(employeeDir(companySlug, employeeSlug), ".openclaw");
}

export function openclawConfigPath(
  companySlug: string,
  employeeSlug: string,
): string {
  // OpenClaw reads OPENCLAW_CONFIG_PATH as an absolute file path (not a dir).
  // We materialize a per-employee openclaw.json inside the state dir so the
  // CLI's auth profiles, agent UUIDs, and runtime state all stay isolated.
  return path.join(employeeOpenclawDir(companySlug, employeeSlug), "openclaw.json");
}

export function openclawCredsPath(
  companySlug: string,
  employeeSlug: string,
): string {
  // OpenClaw writes per-agent auth into <state_dir>/agents/<agentId>/agent/auth-profiles.json.
  // We don't know the agentId up front — it's allocated at first run — so the
  // canonical "creds present" signal is openclaw.json itself, which the CLI
  // creates the first time an API key is saved through it.
  return openclawConfigPath(companySlug, employeeSlug);
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
