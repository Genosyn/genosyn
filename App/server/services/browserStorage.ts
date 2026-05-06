import fs from "node:fs/promises";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { employeeBrowserStateFile, employeeDir, ensureDir } from "./paths.js";

/**
 * Per-employee Playwright `storageState()` persistence.
 *
 * We snapshot cookies + localStorage + sessionStorage to a single hidden
 * JSON file under the employee's data dir. Loaded on every browser-context
 * launch and saved on every clean teardown — so logging into X.com once
 * survives container restarts, idle teardown, and fresh conversations
 * with the same employee. IndexedDB and service workers aren't covered;
 * sites that key their auth off those will still need a re-login.
 */

type StorageState = {
  cookies: unknown[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
};

async function resolveSlugs(
  companyId: string,
  employeeId: string,
): Promise<{ companySlug: string; employeeSlug: string } | null> {
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  if (!co) return null;
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({ id: employeeId });
  if (!emp) return null;
  return { companySlug: co.slug, employeeSlug: emp.slug };
}

/**
 * Read the saved storage state for this employee, or `undefined` if no
 * snapshot exists yet (or the file is unreadable / unparseable). Callers
 * pass the result straight into `browser.newContext({ storageState })`.
 */
export async function loadStorageState(
  companyId: string,
  employeeId: string,
): Promise<StorageState | undefined> {
  const slugs = await resolveSlugs(companyId, employeeId);
  if (!slugs) return undefined;
  const file = employeeBrowserStateFile(slugs.companySlug, slugs.employeeSlug);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    // No snapshot yet — first launch for this employee.
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as StorageState;
    if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) {
      return undefined;
    }
    return parsed;
  } catch {
    // Corrupt file — start clean rather than crash the browser launch.
    return undefined;
  }
}

/**
 * Snapshot the live context's storage state and write it to disk. Best-
 * effort: any failure (slug missing, fs error, context already torn down)
 * is swallowed so it can't break the shutdown path it's called from.
 *
 * Atomic via tmp + rename so a crash mid-write can't leave a half-written
 * file that fails to load next time.
 */
export async function saveStorageState(
  companyId: string,
  employeeId: string,
  context: unknown,
): Promise<void> {
  try {
    const slugs = await resolveSlugs(companyId, employeeId);
    if (!slugs) return;
    const cx = context as { storageState: () => Promise<StorageState> } | null;
    if (!cx) return;
    const state = await cx.storageState();
    ensureDir(employeeDir(slugs.companySlug, slugs.employeeSlug));
    const file = employeeBrowserStateFile(slugs.companySlug, slugs.employeeSlug);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, file);
    // Best-effort tighten on the final file too — ensureDir doesn't touch
    // its mode and the tmp file's mode only applies on first create on
    // some filesystems.
    try {
      await fs.chmod(file, 0o600);
    } catch {
      // ignore
    }
  } catch {
    // Persistence is a UX optimization, not a correctness gate. Don't let
    // a stat / write hiccup take down the browser teardown path.
  }
}

