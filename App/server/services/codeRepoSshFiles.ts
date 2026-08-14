import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codeRepoPrivateCompanyDir, dataRoot, employeeCodeRepoKnownHostsFile } from "./paths.js";

const MAX_KNOWN_HOSTS_BYTES = 1024 * 1024;

/**
 * Read the host-key cache used by short-lived, server-owned SSH git commands.
 * No private key is ever persisted: the encrypted DB value is materialized
 * only inside workspaceGitRemote's App-private temporary directory.
 */
export function readCodeRepoKnownHosts(companyId: string, employeeId: string): string | undefined {
  const file = employeeCodeRepoKnownHostsFile(companyId, employeeId);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Code Repository known-host state is not a private regular file");
    }
    if (stat.size > MAX_KNOWN_HOSTS_BYTES) {
      throw new Error("SSH known-host data is too large.");
    }
    fs.chmodSync(file, 0o600);
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function persistCodeRepoKnownHosts(
  companyId: string,
  employeeId: string,
  value: string,
): void {
  if (Buffer.byteLength(value) > MAX_KNOWN_HOSTS_BYTES) {
    throw new Error("SSH known-host data is too large.");
  }
  const directory = codeRepoPrivateCompanyDir(companyId);
  ensurePrivateDirectory(directory);
  const file = employeeCodeRepoKnownHostsFile(companyId, employeeId);
  assertReplaceablePrivateFile(file);
  const temporary = path.join(directory, `.${employeeId}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Code Repository known-host state is not a private regular file");
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Remove App-private repository state when an AI Employee is deleted. */
export function removeCodeRepoPrivateStateForEmployee(companyId: string, employeeId: string): void {
  fs.rmSync(employeeCodeRepoKnownHostsFile(companyId, employeeId), { force: true });
}

/**
 * Delete the pre-1.94 workspace SSH directory before coding tools are built.
 * Hard-linked files fail closed: renaming or deleting the legacy name would
 * leave an arbitrary alias with the same private-key bytes.
 */
export function purgeLegacyCodeRepoSshFiles(workspaceRoot: string): void {
  const codeRepos = path.join(path.resolve(workspaceRoot), "code-repos");
  let codeReposStat: fs.Stats;
  try {
    codeReposStat = fs.lstatSync(codeRepos);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!codeReposStat.isDirectory() || codeReposStat.isSymbolicLink()) {
    throw new Error("Legacy Code Repository directory is not a private directory");
  }

  const legacy = path.join(codeRepos, ".ssh");
  let legacyStat: fs.Stats;
  try {
    legacyStat = fs.lstatSync(legacy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (legacyStat.isSymbolicLink()) {
    fs.unlinkSync(legacy);
    return;
  }
  if (!legacyStat.isDirectory()) {
    if (legacyStat.isFile() && legacyStat.nlink !== 1) {
      throw new Error("Legacy Code Repository SSH state has an unsafe hard link");
    }
    fs.rmSync(legacy, { force: true });
    return;
  }

  assertNoHardLinkedFiles(legacy);
  fs.rmSync(legacy, { recursive: true, force: true });
}

function assertNoHardLinkedFiles(directory: string): void {
  for (const entry of fs.readdirSync(directory)) {
    const child = path.join(directory, entry);
    const stat = fs.lstatSync(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      assertNoHardLinkedFiles(child);
      continue;
    }
    if (stat.isFile() && stat.nlink !== 1) {
      throw new Error("Legacy Code Repository SSH state has an unsafe hard link");
    }
  }
}

function ensurePrivateDirectory(directory: string): void {
  const root = dataRoot();
  fs.mkdirSync(root, { recursive: true });
  const relative = path.relative(root, directory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("Code Repository private state must stay inside the App data directory");
  }
  let current = root;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Code Repository private state is not a private directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Code Repository private state is not a private directory");
      }
    }
    fs.chmodSync(current, 0o700);
  }
}

function assertReplaceablePrivateFile(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Code Repository known-host state is not a private regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
