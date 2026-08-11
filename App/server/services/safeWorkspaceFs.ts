import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

type FileIdentity = {
  dev: bigint;
  ino: bigint;
};

/**
 * A directory whose inode stays open for the lifetime of a sensitive
 * filesystem operation. Linux production deployments address children via
 * `/proc/self/fd`, so replacing any pathname component cannot redirect a
 * later read, write or rename outside the validated directory.
 *
 * Non-Linux host mode has no same-UID isolation boundary. It still rejects
 * pre-existing symlinks, revalidates directory identities around operations,
 * and never follows a final file symlink or hard link while overwriting it.
 */
export type PinnedDirectory = {
  readonly fd: number;
  readonly accessPath: string;
  readonly originalPath: string;
  readonly resolvedPath: string;
  readonly containmentRoot: string;
  readonly identity: FileIdentity;
  readonly label: string;
};

const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const CREATE_FLAGS =
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const USE_LINUX_FD_PATHS = process.platform === "linux";

export function openPinnedDirectory(
  candidate: string,
  containmentRoot: string,
  label: string,
): PinnedDirectory {
  const root = fs.realpathSync(containmentRoot);
  const originalPath = path.resolve(candidate);
  const resolvedPath = fs.realpathSync(originalPath);
  assertContained(root, resolvedPath, label);
  const before = fs.statSync(resolvedPath, { bigint: true });
  if (!before.isDirectory()) throw new Error(`${label} is not a directory.`);

  const fd = fs.openSync(resolvedPath, DIRECTORY_FLAGS);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const after = fs.statSync(resolvedPath, { bigint: true });
    if (
      !opened.isDirectory() ||
      !sameDirectoryIdentity(opened, before) ||
      !sameDirectoryIdentity(opened, after)
    ) {
      throw new Error(`${label} changed while it was being validated.`);
    }
    const accessPath = USE_LINUX_FD_PATHS ? `/proc/self/fd/${fd}` : resolvedPath;
    if (USE_LINUX_FD_PATHS) {
      const openedPath = fs.realpathSync(accessPath);
      assertContained(root, openedPath, label);
      if (!sameDirectoryIdentity(fs.statSync(openedPath, { bigint: true }), opened)) {
        throw new Error(`${label} changed while it was being pinned.`);
      }
    }
    return {
      fd,
      accessPath,
      originalPath,
      resolvedPath,
      containmentRoot: root,
      identity: identityOf(opened),
      label,
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function openPinnedChildDirectory(
  parent: PinnedDirectory,
  name: string,
  options: { create?: boolean; mode?: number; label: string },
): PinnedDirectory {
  assertChildName(name);
  if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(parent);
  const accessPath = path.join(parent.accessPath, name);
  if (options.create) {
    try {
      fs.mkdirSync(accessPath, { mode: options.mode ?? 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  const fd = fs.openSync(accessPath, DIRECTORY_FLAGS);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory()) throw new Error(`${options.label} is not a directory.`);
    const childAccessPath = USE_LINUX_FD_PATHS
      ? `/proc/self/fd/${fd}`
      : fs.realpathSync(accessPath);
    const resolvedPath = fs.realpathSync(childAccessPath);
    assertContained(parent.containmentRoot, resolvedPath, options.label);
    if (!sameDirectoryIdentity(fs.statSync(resolvedPath, { bigint: true }), opened)) {
      throw new Error(`${options.label} changed while it was being pinned.`);
    }
    if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(parent);
    return {
      fd,
      accessPath: childAccessPath,
      originalPath: path.join(parent.originalPath, name),
      resolvedPath,
      containmentRoot: parent.containmentRoot,
      identity: identityOf(opened),
      label: options.label,
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export function closePinnedDirectory(directory: PinnedDirectory): void {
  fs.closeSync(directory.fd);
}

export function assertPinnedDirectoryCurrent(directory: PinnedDirectory): void {
  assertPinnedDirectoryAtPath(directory, directory.originalPath);
}

export function assertPinnedDirectoryAtPath(directory: PinnedDirectory, candidate: string): void {
  let resolved: string;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new Error(`${directory.label} changed during repository synchronization.`);
  }
  assertContained(directory.containmentRoot, resolved, directory.label);
  const current = fs.statSync(resolved, { bigint: true });
  if (!current.isDirectory() || !sameDirectoryIdentity(current, directory.identity)) {
    throw new Error(`${directory.label} changed during repository synchronization.`);
  }
}

export function readPinnedFile(
  directory: PinnedDirectory,
  name: string,
  maxBytes: number,
): string | undefined {
  assertChildName(name);
  if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(directory);
  let fd: number;
  try {
    fd = fs.openSync(path.join(directory.accessPath, name), READ_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
      throw new Error("Workspace file has an unsafe filesystem representation.");
    }
    if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(directory);
    return readLimitedFileDescriptor(fd, maxBytes);
  } finally {
    fs.closeSync(fd);
  }
}

export function writePinnedFileAtomic(
  directory: PinnedDirectory,
  name: string,
  value: string | Buffer,
  mode = 0o600,
): void {
  assertChildName(name);
  if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(directory);
  const temporaryName = `.${name}.${crypto.randomUUID()}.tmp`;
  const temporaryPath = path.join(directory.accessPath, temporaryName);
  const destinationPath = path.join(directory.accessPath, name);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporaryPath, CREATE_FLAGS, mode);
    if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(directory);
    fs.writeFileSync(fd, value);
    fs.fchmodSync(fd, mode);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(directory);
    // rename replaces a symlink or hard link as a directory entry; it never
    // opens or truncates that entry's target.
    fs.renameSync(temporaryPath, destinationPath);
    if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(directory);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      removePinnedEntryIfSafe(directory, temporaryName);
    } catch {
      // Never replace the primary write error with best-effort cleanup.
    }
  }
}

function removePinnedEntryIfSafe(
  directory: PinnedDirectory,
  name: string,
  options: { recursive?: boolean } = {},
): boolean {
  assertChildName(name);
  if (!USE_LINUX_FD_PATHS) {
    try {
      assertPinnedDirectoryCurrent(directory);
    } catch {
      return false;
    }
  }
  const candidate = path.join(directory.accessPath, name);
  try {
    if (options.recursive) fs.rmSync(candidate, { recursive: true, force: true });
    else fs.unlinkSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

export function linkOrCopyPinnedFileAtomic(
  sourceDirectory: PinnedDirectory,
  sourceName: string,
  destinationDirectory: PinnedDirectory,
  destinationName: string,
): void {
  assertChildName(sourceName);
  assertChildName(destinationName);
  if (!USE_LINUX_FD_PATHS) {
    assertPinnedDirectoryCurrent(sourceDirectory);
    assertPinnedDirectoryCurrent(destinationDirectory);
  }

  const destinationPath = path.join(destinationDirectory.accessPath, destinationName);
  try {
    const existing = fs.lstatSync(destinationPath);
    if (existing.isFile()) return;
    if (!existing.isSymbolicLink()) {
      throw new Error("Git object storage contains an unsupported filesystem entry.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(destinationDirectory);

  const sourcePath = path.join(sourceDirectory.accessPath, sourceName);
  const sourceFd = fs.openSync(sourcePath, READ_FLAGS);
  let sourceStat: fs.BigIntStats;
  try {
    sourceStat = fs.fstatSync(sourceFd, { bigint: true });
    if (!sourceStat.isFile()) {
      throw new Error("Git object storage contains an unsupported filesystem entry.");
    }
    if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(sourceDirectory);
  } catch (error) {
    fs.closeSync(sourceFd);
    throw error;
  }

  const temporaryName = `.${destinationName}.${crypto.randomUUID()}.tmp`;
  const temporaryPath = path.join(destinationDirectory.accessPath, temporaryName);
  let temporaryFd: number | undefined;
  try {
    let linked = false;
    let linkCreated = false;
    try {
      fs.linkSync(sourcePath, temporaryPath);
      linkCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw error;
    }
    if (linkCreated) {
      if (!USE_LINUX_FD_PATHS) {
        assertPinnedDirectoryCurrent(sourceDirectory);
        assertPinnedDirectoryCurrent(destinationDirectory);
      }
      const linkedStat = fs.lstatSync(temporaryPath, { bigint: true });
      linked = linkedStat.isFile() && sameFileIdentity(linkedStat, sourceStat);
      if (!linked && !removePinnedEntryIfSafe(destinationDirectory, temporaryName)) {
        throw new Error("Git object destination changed during repository synchronization.");
      }
    }

    if (!linked) {
      temporaryFd = fs.openSync(temporaryPath, CREATE_FLAGS, Number(sourceStat.mode & 0o777n));
      if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(destinationDirectory);
      copyFileDescriptor(sourceFd, temporaryFd);
      fs.fchmodSync(temporaryFd, Number(sourceStat.mode & 0o777n));
      fs.fsyncSync(temporaryFd);
      fs.closeSync(temporaryFd);
      temporaryFd = undefined;
    }
    if (!USE_LINUX_FD_PATHS) assertPinnedDirectoryCurrent(destinationDirectory);
    fs.renameSync(temporaryPath, destinationPath);
  } finally {
    fs.closeSync(sourceFd);
    if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
    try {
      removePinnedEntryIfSafe(destinationDirectory, temporaryName);
    } catch {
      // Never replace the primary object-copy error with cleanup failure.
    }
  }
}

function copyFileDescriptor(sourceFd: number, destinationFd: number): void {
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  for (;;) {
    const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    let written = 0;
    while (written < bytesRead) {
      written += fs.writeSync(destinationFd, buffer, written, bytesRead - written);
    }
    position += bytesRead;
  }
}

function readLimitedFileDescriptor(fd: number, maxBytes: number): string {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const bytesRead = fs.readSync(fd, buffer, total, buffer.length - total, total);
    if (bytesRead === 0) return buffer.subarray(0, total).toString("utf8");
    total += bytesRead;
  }
  throw new Error("Workspace file exceeds the allowed size.");
}

function assertChildName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    path.basename(name) !== name ||
    name.includes("\0")
  ) {
    throw new Error("Unsafe workspace filename.");
  }
}

function identityOf(stat: fs.BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameDirectoryIdentity(
  left: fs.BigIntStats | FileIdentity,
  right: fs.BigIntStats | FileIdentity,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the employee workspace.`);
  }
}
