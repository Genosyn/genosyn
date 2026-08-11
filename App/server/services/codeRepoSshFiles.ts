import path from "node:path";
import {
  closePinnedDirectory,
  openPinnedChildDirectory,
  openPinnedDirectory,
  readPinnedFile,
  writePinnedFileAtomic,
} from "./safeWorkspaceFs.js";
import type { PinnedDirectory } from "./safeWorkspaceFs.js";

const MAX_KNOWN_HOSTS_BYTES = 1024 * 1024;

export function persistCodeRepoSshKey(
  workspaceRoot: string,
  repositoryId: string,
  privateKey: string,
): string {
  assertRepositoryFilename(repositoryId);
  withSshDirectory(workspaceRoot, true, (directory) => {
    const value = privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`;
    writePinnedFileAtomic(directory, repositoryId, value);
  });
  return path.join(workspaceRoot, "code-repos", ".ssh", repositoryId);
}

export function readCodeRepoKnownHosts(workspaceRoot: string): string | undefined {
  return withSshDirectory(workspaceRoot, false, (directory) =>
    readPinnedFile(directory, "known_hosts", MAX_KNOWN_HOSTS_BYTES),
  );
}

export function persistCodeRepoKnownHosts(workspaceRoot: string, value: string): void {
  if (Buffer.byteLength(value) > MAX_KNOWN_HOSTS_BYTES) {
    throw new Error("SSH known-host data is too large.");
  }
  withSshDirectory(workspaceRoot, true, (directory) => {
    writePinnedFileAtomic(directory, "known_hosts", value);
  });
}

function withSshDirectory<T>(
  workspaceRoot: string,
  create: boolean,
  action: (directory: PinnedDirectory) => T,
): T | undefined {
  const root = openPinnedDirectory(workspaceRoot, workspaceRoot, "Employee workspace");
  let codeRepos: PinnedDirectory | undefined;
  let sshDirectory: PinnedDirectory | undefined;
  try {
    try {
      codeRepos = openPinnedChildDirectory(root, "code-repos", {
        create,
        mode: 0o700,
        label: "Code Repository directory",
      });
      sshDirectory = openPinnedChildDirectory(codeRepos, ".ssh", {
        create,
        mode: 0o700,
        label: "Code Repository SSH directory",
      });
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return action(sshDirectory);
  } finally {
    if (sshDirectory) closePinnedDirectory(sshDirectory);
    if (codeRepos) closePinnedDirectory(codeRepos);
    closePinnedDirectory(root);
  }
}

function assertRepositoryFilename(repositoryId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(repositoryId)) {
    throw new Error("Code Repository ID cannot be used as an SSH key filename.");
  }
}
