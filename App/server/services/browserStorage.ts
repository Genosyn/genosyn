import path from "node:path";
import fs from "node:fs/promises";
import { AppDataSource } from "../db/datasource.js";
import { Company } from "../db/entities/Company.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { dataRoot, employeeBrowserStateFile, legacyEmployeeBrowserStateFile } from "./paths.js";

/**
 * Per-employee Playwright `storageState()` persistence.
 *
 * We snapshot cookies + localStorage + sessionStorage to an App-private JSON
 * file outside the employee's model-visible workspace. Loaded on every
 * browser-context launch and saved on every clean teardown — so logging into
 * X.com once survives container restarts, idle teardown, and fresh
 * conversations with the same employee without making bearer cookies readable
 * by coding tools. IndexedDB and service workers aren't covered; sites that key
 * their auth off those will still need a re-login.
 */

export type StorageState = {
  cookies: unknown[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
};

/**
 * Does this cookie domain or origin belong to one of `domains`?
 *
 * Cookie domains may carry a leading dot (`.x.com` = "and all subdomains"),
 * and an origin is a URL. Both reduce to a hostname, which either equals a
 * listed domain or is a subdomain of it. Substring matching would be wrong
 * and dangerous here — `evil-x.com` must not match `x.com`.
 */
function hostMatchesDomains(host: string, domains: string[]): boolean {
  const normalized = host.replace(/^\./, "").toLowerCase();
  return domains.some((domain) => {
    const d = domain.replace(/^\./, "").toLowerCase();
    return normalized === d || normalized.endsWith(`.${d}`);
  });
}

function cookieMatchesDomains(cookie: unknown, domains: string[]): boolean {
  const domain = (cookie as { domain?: unknown } | null)?.domain;
  return typeof domain === "string" && hostMatchesDomains(domain, domains);
}

function originMatchesDomains(origin: string, domains: string[]): boolean {
  try {
    return hostMatchesDomains(new URL(origin).hostname, domains);
  } catch {
    return false;
  }
}

/**
 * Narrow a storage state to the sites in `domains`.
 *
 * An employee's jar accumulates cookies for everything they browse. A
 * browser-login Connection only has business with its own site, and its
 * state is persisted onto a Connection row that other employees may hold a
 * Grant for — so handing it the whole jar would put one employee's Gmail
 * session inside a Connection another employee can use. Both directions of
 * the share are scoped through here.
 */
export function filterStorageState(state: StorageState, domains: string[]): StorageState {
  return {
    cookies: state.cookies.filter((cookie) => cookieMatchesDomains(cookie, domains)),
    origins: state.origins.filter((origin) => originMatchesDomains(origin.origin, domains)),
  };
}

/**
 * Fold `incoming` into `base`, but only for `domains`: every base entry for
 * those sites is dropped and replaced wholesale, and everything else in
 * `base` is left exactly as it was.
 *
 * Replace-per-domain rather than merge-per-cookie because a sign-out is
 * expressed by a cookie's *absence*; merging key-by-key would resurrect a
 * dead session token. Untouched domains survive because a Connection
 * refreshing its own site must not clear the employee's other logins.
 */
export function mergeStorageState(
  base: StorageState | undefined,
  incoming: StorageState,
  domains: string[],
): StorageState {
  const scoped = filterStorageState(incoming, domains);
  if (!base) return scoped;
  return {
    cookies: [
      ...base.cookies.filter((cookie) => !cookieMatchesDomains(cookie, domains)),
      ...scoped.cookies,
    ],
    origins: [
      ...base.origins.filter((origin) => !originMatchesDomains(origin.origin, domains)),
      ...scoped.origins,
    ],
  };
}

/** Best-effort coercion of an unknown blob into a StorageState. */
export function asStorageState(value: unknown): StorageState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<StorageState>;
  if (!Array.isArray(record.cookies) || !Array.isArray(record.origins)) return undefined;
  return { cookies: record.cookies, origins: record.origins };
}

type BrowserStorageIdentity = {
  companySlug: string;
  employeeSlug: string;
};

async function resolveIdentity(
  companyId: string,
  employeeId: string,
): Promise<BrowserStorageIdentity | null> {
  const co = await AppDataSource.getRepository(Company).findOneBy({ id: companyId });
  if (!co) return null;
  const emp = await AppDataSource.getRepository(AIEmployee).findOneBy({
    id: employeeId,
    companyId,
  });
  if (!emp) return null;
  return { companySlug: co.slug, employeeSlug: emp.slug };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  const root = dataRoot();
  await fs.mkdir(root, { recursive: true });
  const relative = path.relative(root, directory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Browser storage directory must stay inside the App data directory");
  }
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Browser storage directory is not a private directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current, { mode: 0o700 }).catch((mkdirError) => {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
      });
      const created = await fs.lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) {
        throw new Error("Browser storage directory is not a private directory");
      }
    }
    await fs.chmod(current, 0o700);
  }
}

async function assertPrivateStateFile(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Browser storage state is not a private regular file");
    }
    await fs.chmod(file, 0o600);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Move the legacy workspace-visible snapshot before any coding tool is built.
 * Temporary/torn legacy snapshots are deleted too, so bubblewrapped bash never
 * inherits an old cookie file after an upgrade.
 */
export async function migrateLegacyBrowserStorage(
  companyId: string,
  employeeId: string,
): Promise<void> {
  const identity = await resolveIdentity(companyId, employeeId);
  if (!identity) return;
  const destination = employeeBrowserStateFile(companyId, employeeId);
  await ensurePrivateDirectory(path.dirname(destination));
  let destinationExists = await assertPrivateStateFile(destination);
  const legacy = legacyEmployeeBrowserStateFile(identity.companySlug, identity.employeeSlug);
  const legacyDirectory = path.dirname(legacy);
  let entries: string[];
  try {
    entries = await fs.readdir(legacyDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const artifacts = entries.filter((entry) => entry.startsWith(".browser-state.json"));
  for (const artifact of artifacts) {
    const source = path.join(legacyDirectory, artifact);
    let stat;
    try {
      stat = await fs.lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isFile() && stat.nlink !== 1) {
      throw new Error("Legacy Browser storage has an unsafe hard link");
    }
    if (artifact === ".browser-state.json" && !destinationExists && stat.isFile()) {
      try {
        await fs.rename(source, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      destinationExists = await assertPrivateStateFile(destination);
      if (destinationExists) continue;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error("Legacy Browser storage artifact is not a regular file");
    }
    await fs.unlink(source).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export async function removeBrowserStorageForEmployee(
  companyId: string,
  employeeId: string,
): Promise<void> {
  await fs.rm(employeeBrowserStateFile(companyId, employeeId), { force: true });
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
  const identity = await resolveIdentity(companyId, employeeId);
  if (!identity) return undefined;
  await migrateLegacyBrowserStorage(companyId, employeeId);
  const file = employeeBrowserStateFile(companyId, employeeId);
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
    const identity = await resolveIdentity(companyId, employeeId);
    if (!identity) return;
    await migrateLegacyBrowserStorage(companyId, employeeId);
    const cx = context as { storageState: () => Promise<StorageState> } | null;
    if (!cx) return;
    const state = await cx.storageState();
    const file = employeeBrowserStateFile(companyId, employeeId);
    await ensurePrivateDirectory(path.dirname(file));
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
