import fs from "node:fs";
import path from "node:path";
import { config } from "../../config.js";
import { assertSafeGitRemoteUrl } from "./gitCredentialHelper.js";
import { runWorkspaceGit } from "./workspaceGit.js";
import type { WorkspaceGitOptions } from "./workspaceGit.js";
import {
  assertPinnedDirectoryAtPath,
  assertPinnedDirectoryCurrent,
  closePinnedDirectory,
  linkOrCopyPinnedFileAtomic,
  openPinnedChildDirectory,
  openPinnedDirectory,
} from "./safeWorkspaceFs.js";
import type { PinnedDirectory } from "./safeWorkspaceFs.js";

export type WorkspaceRemoteFetchOptions = Omit<WorkspaceGitOptions, "args" | "stdin"> & {
  /** Exact server-configured URL. Repository-local remotes are never read. */
  remoteUrl: string;
  /** Trusted SSH material copied into the private network workspace. */
  sshCredential?: {
    privateKey: string;
    knownHosts?: string;
  };
};

export type WorkspaceRemoteCloneOptions = Omit<WorkspaceRemoteFetchOptions, "cwd"> & {
  /** Final checkout path, which must not exist before materialization. */
  destinationPath: string;
};

export type WorkspaceRemoteResult = {
  /** Updated SSH host keys learned inside the private network workspace. */
  sshKnownHosts?: string;
};

/**
 * Clone through a private network workspace, then atomically expose the fully
 * materialized checkout. The destination never contains a writable Git config
 * while credentials are present in a networked process.
 */
export async function cloneWorkspaceGitRemote(
  options: WorkspaceRemoteCloneOptions,
): Promise<WorkspaceRemoteResult> {
  assertSafeGitRemoteUrl(options.remoteUrl);
  const workspaceRoot = fs.realpathSync(options.workspaceRoot);
  const requestedDestination = path.resolve(options.destinationPath);
  const destinationName = path.basename(requestedDestination);
  assertSafeDestinationName(destinationName);
  const destinationParent = openPinnedDirectory(
    path.dirname(requestedDestination),
    workspaceRoot,
    "Git clone destination parent",
  );
  try {
    const destinationPath = path.join(destinationParent.accessPath, destinationName);
    if (entryExists(destinationPath)) {
      throw new Error("Git clone destination already exists.");
    }

    const privateRoot = createPrivateGitRoot(workspaceRoot);
    const privateCheckout = path.join(privateRoot, "checkout");
    try {
      const prepared = preparePrivateNetwork(options, privateRoot);
      await runWorkspaceGit({
        workspaceRoot: privateRoot,
        cwd: privateRoot,
        args: ["clone", "--quiet", options.remoteUrl, "checkout"],
        extraEnv: prepared.env,
        credentialHelper: options.credentialHelper,
      });
      const result = readPrivateNetworkResult(prepared);
      assertPinnedDirectoryCurrent(destinationParent);
      if (entryExists(destinationPath)) {
        throw new Error("Git clone destination appeared during materialization.");
      }
      fs.renameSync(privateCheckout, destinationPath);
      // If the logical parent changed after the fd-addressed rename, leave the
      // completed credential-free checkout on its pinned inode. Recursive
      // cleanup by name could delete an entry an adversary swapped into place.
      assertPinnedDirectoryCurrent(destinationParent);
      return result;
    } finally {
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  } finally {
    closePinnedDirectory(destinationParent);
  }
}

/**
 * Fetch the configured remote without reading the AI-writable `.git/config`.
 *
 * Git applies `url.*.insteadOf`, URL-scoped proxy and TLS settings from local
 * config even when the caller supplies a URL directly. Supplying a token to
 * that process would therefore let a checkout redirect an authenticated fetch.
 * Fetch in a private, server-owned temporary workspace for the only networked
 * operation, copy its immutable objects, then atomically update `origin/*` with
 * credential-free plumbing in the employee checkout. Existing objects are
 * hard-linked into the private repo first so normal fetch negotiation remains
 * incremental rather than downloading the full history on every sync.
 */
export async function fetchWorkspaceGitRemote(
  options: WorkspaceRemoteFetchOptions,
): Promise<WorkspaceRemoteResult> {
  assertSafeGitRemoteUrl(options.remoteUrl);
  const checkout = resolveCheckout(options.workspaceRoot, options.cwd);
  const commonDirectory = openPinnedDirectory(
    checkout.commonDir,
    checkout.workspaceRoot,
    "Git common directory",
  );
  let targetObjectDirectory: PinnedDirectory | undefined;
  try {
    targetObjectDirectory = openPinnedChildDirectory(commonDirectory, "objects", {
      label: "Git object directory",
    });
    const { stdout: formatOutput } = await runWorkspaceGit({
      workspaceRoot: options.workspaceRoot,
      cwd: options.cwd,
      args: ["rev-parse", "--show-object-format"],
    });
    const objectFormat = formatOutput.trim();
    if (objectFormat !== "sha1" && objectFormat !== "sha256") {
      throw new Error(`Unsupported Git object format: ${objectFormat || "(empty)"}`);
    }
    const currentBeforeFetch = await readCurrentRefs(options.workspaceRoot, options.cwd);
    assertCheckoutDirectoriesCurrent(options, commonDirectory, targetObjectDirectory);

    const privateRoot = createPrivateGitRoot(checkout.workspaceRoot);
    const fetchedRepo = path.join(privateRoot, "remote.git");
    let privateObjectDirectory: PinnedDirectory | undefined;
    try {
      const prepared = preparePrivateNetwork(options, privateRoot);
      const initArgs = ["init", "--bare", "--quiet"];
      if (objectFormat === "sha256") initArgs.push("--object-format=sha256");
      initArgs.push("remote.git");
      await runWorkspaceGit({
        workspaceRoot: privateRoot,
        cwd: privateRoot,
        args: initArgs,
      });
      privateObjectDirectory = openPinnedDirectory(
        path.join(fetchedRepo, "objects"),
        privateRoot,
        "Private Git object directory",
      );
      copyObjectStore(targetObjectDirectory, privateObjectDirectory);

      const seedTransaction: string[] = [];
      for (const [remoteRef, objectId, symbolicTarget] of currentBeforeFetch.remoteBranches) {
        if (symbolicTarget) continue;
        const branch = remoteRef.slice("refs/remotes/origin/".length);
        seedTransaction.push(`update refs/heads/${branch} ${objectId}`);
      }
      for (const [tagRef, objectId] of currentBeforeFetch.tags) {
        seedTransaction.push(`update ${tagRef} ${objectId}`);
      }
      if (seedTransaction.length > 0) {
        await runWorkspaceGit({
          workspaceRoot: privateRoot,
          cwd: fetchedRepo,
          args: ["update-ref", "--stdin"],
          stdin: `${seedTransaction.join("\n")}\n`,
        });
      }

      // This private root is mounted as the whole bubblewrap workspace, so an AI
      // process cannot race checkout-local URL, proxy or TLS config into the only
      // networked Git child.
      await runWorkspaceGit({
        workspaceRoot: privateRoot,
        cwd: fetchedRepo,
        args: [
          "fetch",
          "--no-auto-maintenance",
          "--no-recurse-submodules",
          "--prune",
          "--quiet",
          options.remoteUrl,
          "+refs/heads/*:refs/heads/*",
        ],
        extraEnv: prepared.env,
        credentialHelper: options.credentialHelper,
      });

      const { stdout: fetchedOutput } = await runWorkspaceGit({
        workspaceRoot: privateRoot,
        cwd: fetchedRepo,
        args: ["for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads/", "refs/tags/"],
      });
      const fetched = parseRemoteRefs(fetchedOutput);
      assertCheckoutDirectoriesCurrent(options, commonDirectory, targetObjectDirectory);
      copyObjectStore(privateObjectDirectory, targetObjectDirectory);
      assertCheckoutDirectoriesCurrent(options, commonDirectory, targetObjectDirectory);
      const current = await readCurrentRefs(options.workspaceRoot, options.cwd);
      const transaction: string[] = [];
      for (const [sourceRef, objectId] of fetched.branches) {
        const branch = sourceRef.slice("refs/heads/".length);
        transaction.push(`update refs/remotes/origin/${branch} ${objectId}`);
      }
      for (const [currentRef, _objectId, symbolicTarget] of current.remoteBranches) {
        if (symbolicTarget) continue;
        const branch = currentRef.slice("refs/remotes/origin/".length);
        if (fetched.branches.has(`refs/heads/${branch}`)) continue;
        transaction.push(`delete ${currentRef}`);
      }
      // Normal fetch auto-follows reachable tags but does not prune or clobber
      // existing local tags. A bare clone has the equivalent fetched tag set.
      for (const [tagRef, objectId] of fetched.tags) {
        if (!current.tags.has(tagRef)) transaction.push(`create ${tagRef} ${objectId}`);
      }
      assertCheckoutDirectoriesCurrent(options, commonDirectory, targetObjectDirectory);
      if (transaction.length > 0) {
        await runWorkspaceGit({
          workspaceRoot: options.workspaceRoot,
          cwd: options.cwd,
          args: ["update-ref", "--stdin"],
          stdin: `${transaction.join("\n")}\n`,
        });
      }
      return readPrivateNetworkResult(prepared);
    } finally {
      if (privateObjectDirectory) closePinnedDirectory(privateObjectDirectory);
      fs.rmSync(privateRoot, { recursive: true, force: true });
    }
  } finally {
    if (targetObjectDirectory) closePinnedDirectory(targetObjectDirectory);
    closePinnedDirectory(commonDirectory);
  }
}

type PrivateNetwork = {
  env: Record<string, string>;
  knownHostsPath?: string;
};

function createPrivateGitRoot(workspaceRoot: string): string {
  // A sibling stays on the workspace volume (so object hard links and the
  // final clone rename are cheap/atomic) but is outside the AI sandbox mount.
  const workspaceParent = path.dirname(workspaceRoot);
  if (workspaceParent === workspaceRoot) {
    throw new Error("Git workspace root must not be the filesystem root.");
  }
  const privateRoot = fs.mkdtempSync(path.join(workspaceParent, ".genosyn-git-fetch-"));
  fs.chmodSync(privateRoot, 0o700);
  return privateRoot;
}

function preparePrivateNetwork(
  options: Pick<WorkspaceRemoteFetchOptions, "extraEnv" | "sshCredential">,
  privateRoot: string,
): PrivateNetwork {
  const env = { ...(options.extraEnv ?? {}) };
  if (!options.sshCredential) return { env };

  const keyPath = path.join(privateRoot, "ssh-key");
  const knownHostsPath = path.join(privateRoot, "known_hosts");
  const privateKey = options.sshCredential.privateKey;
  fs.writeFileSync(keyPath, privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, {
    mode: 0o600,
  });
  fs.writeFileSync(knownHostsPath, options.sshCredential.knownHosts ?? "", { mode: 0o600 });
  env.GIT_SSH_COMMAND = buildPrivateFetchSshCommand(privateRoot, keyPath, knownHostsPath);
  return { env, knownHostsPath };
}

function readPrivateNetworkResult(prepared: PrivateNetwork): WorkspaceRemoteResult {
  if (!prepared.knownHostsPath) return {};
  const stat = fs.lstatSync(prepared.knownHostsPath);
  if (!stat.isFile() || stat.size > 1024 * 1024) {
    throw new Error("SSH known-host data is invalid.");
  }
  return { sshKnownHosts: fs.readFileSync(prepared.knownHostsPath, "utf8") };
}

export function buildPrivateFetchSshCommand(
  privateRoot: string,
  keyPath: string,
  knownHostsPath: string,
  executionMode = config.agent.codingTools.executionMode,
): string {
  const visibleKeyPath = privateWorkspacePath(keyPath, privateRoot, executionMode);
  const visibleKnownHostsPath = privateWorkspacePath(knownHostsPath, privateRoot, executionMode);
  return (
    `ssh -i ${shellQuote(visibleKeyPath)} -o IdentitiesOnly=yes ` +
    "-o StrictHostKeyChecking=accept-new " +
    `-o UserKnownHostsFile=${shellQuote(visibleKnownHostsPath)}`
  );
}

function privateWorkspacePath(
  hostPath: string,
  privateRoot: string,
  executionMode: "host" | "bubblewrap" | "disabled",
): string {
  assertContained(privateRoot, hostPath, "Private Git credential path");
  if (executionMode !== "bubblewrap") return hostPath;
  const relative = path.relative(privateRoot, hostPath);
  return `/workspace/${relative.split(path.sep).join("/")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function readCurrentRefs(
  workspaceRoot: string,
  cwd: string,
): Promise<ReturnType<typeof parseCurrentRefs>> {
  const { stdout } = await runWorkspaceGit({
    workspaceRoot,
    cwd,
    args: [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(symref)",
      "refs/remotes/origin/",
      "refs/tags/",
    ],
  });
  return parseCurrentRefs(stdout);
}

function copyObjectStore(
  source: PinnedDirectory,
  destination: PinnedDirectory,
  relative = "",
): void {
  for (const entry of fs.readdirSync(source.accessPath, { withFileTypes: true })) {
    const entryRelative = relative ? path.join(relative, entry.name) : entry.name;
    if (
      entryRelative === path.join("info", "alternates") ||
      entryRelative === path.join("info", "http-alternates")
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      const sourceChild = openPinnedChildDirectory(source, entry.name, {
        label: "Git object source directory",
      });
      let destinationChild: PinnedDirectory | undefined;
      try {
        destinationChild = openPinnedChildDirectory(destination, entry.name, {
          create: true,
          mode: 0o700,
          label: "Git object destination directory",
        });
        copyObjectStore(sourceChild, destinationChild, entryRelative);
      } finally {
        if (destinationChild) closePinnedDirectory(destinationChild);
        closePinnedDirectory(sourceChild);
      }
      continue;
    }
    if (!entry.isFile()) {
      throw new Error("Git object storage contains an unsupported filesystem entry.");
    }
    linkOrCopyPinnedFileAtomic(source, entry.name, destination, entry.name);
  }
}

function assertCheckoutDirectoriesCurrent(
  options: Pick<WorkspaceRemoteFetchOptions, "workspaceRoot" | "cwd">,
  commonDirectory: PinnedDirectory,
  objectDirectory: PinnedDirectory,
): void {
  const current = resolveCheckout(options.workspaceRoot, options.cwd);
  assertPinnedDirectoryAtPath(commonDirectory, current.commonDir);
  assertPinnedDirectoryAtPath(objectDirectory, path.join(current.commonDir, "objects"));
}

function resolveCheckout(
  workspaceRoot: string,
  cwd: string,
): { workspaceRoot: string; commonDir: string } {
  const resolvedWorkspace = fs.realpathSync(workspaceRoot);
  const resolvedCwd = fs.realpathSync(cwd);
  assertContained(resolvedWorkspace, resolvedCwd, "Git checkout");

  const gitEntry = path.join(resolvedCwd, ".git");
  const stat = fs.lstatSync(gitEntry);
  let unresolvedGitDir: string;
  if (stat.isDirectory()) {
    unresolvedGitDir = gitEntry;
  } else if (stat.isFile()) {
    const pointer = fs.readFileSync(gitEntry, "utf8");
    const match = pointer.match(/^gitdir: ([^\0\r\n]+)\r?\n?$/);
    if (!match?.[1]) throw new Error("Git checkout has an invalid gitdir pointer.");
    unresolvedGitDir = path.resolve(resolvedCwd, match[1]);
  } else {
    throw new Error("Git checkout has an unsupported .git entry.");
  }
  const gitDir = fs.realpathSync(unresolvedGitDir);
  assertContained(resolvedWorkspace, gitDir, "Git directory");
  const commonDirFile = path.join(gitDir, "commondir");
  let commonDir = gitDir;
  if (fs.existsSync(commonDirFile)) {
    const pointer = fs.readFileSync(commonDirFile, "utf8");
    if (/\0|\r|\n.*\S/s.test(pointer)) {
      throw new Error("Git checkout has an invalid common directory pointer.");
    }
    commonDir = fs.realpathSync(path.resolve(gitDir, pointer.trim()));
    assertContained(resolvedWorkspace, commonDir, "Git common directory");
  }
  return { workspaceRoot: resolvedWorkspace, commonDir };
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the employee workspace.`);
  }
}

function entryExists(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function assertSafeDestinationName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    path.basename(name) !== name ||
    name.includes("\0")
  ) {
    throw new Error("Git clone destination has an unsafe filename.");
  }
}

function parseRemoteRefs(output: string): {
  branches: Map<string, string>;
  tags: Map<string, string>;
} {
  const branches = new Map<string, string>();
  const tags = new Map<string, string>();
  for (const [ref = "", objectId = ""] of output
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\0"))) {
    if (ref.startsWith("refs/heads/")) {
      validateRef(ref, objectId, "refs/heads/");
      branches.set(ref, objectId);
    } else if (ref.startsWith("refs/tags/")) {
      validateRef(ref, objectId, "refs/tags/");
      tags.set(ref, objectId);
    } else {
      throw new Error("Git returned an unexpected remote reference during synchronization.");
    }
  }
  return { branches, tags };
}

function parseCurrentRefs(output: string): {
  remoteBranches: Array<[string, string, string]>;
  tags: Map<string, string>;
} {
  const remoteBranches: Array<[string, string, string]> = [];
  const tags = new Map<string, string>();
  for (const line of output.trimEnd().split("\n").filter(Boolean)) {
    const [ref = "", objectId = "", symbolicTarget = ""] = line.split("\0");
    if (ref.startsWith("refs/remotes/origin/")) {
      validateRef(ref, objectId, "refs/remotes/origin/");
      remoteBranches.push([ref, objectId, symbolicTarget]);
    } else if (ref.startsWith("refs/tags/")) {
      validateRef(ref, objectId, "refs/tags/");
      tags.set(ref, objectId);
    } else {
      throw new Error("Git returned an unexpected local reference during synchronization.");
    }
  }
  return { remoteBranches, tags };
}

function validateRef(ref: string, objectId: string, namespace: string): void {
  if (!ref.startsWith(namespace) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(objectId)) {
    throw new Error("Git returned an invalid reference during repository synchronization.");
  }
}
