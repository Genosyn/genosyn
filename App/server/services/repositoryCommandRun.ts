import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../../config.js";
import type { Repository } from "../db/entities/Repository.js";
import { codingRuntimeAvailability } from "./agent/codingAvailability.js";
import {
  messageOf,
  spawnSandboxedCommand,
  type SandboxCommandResult,
} from "./agent/sandboxCommandRun.js";
import { buildSandboxShellInvocation } from "./agent/sandboxShell.js";
import { decideRepositoryCommand } from "./repositoryCommandPolicy.js";
import { normalizeRepositoryPath, resolveInCheckout } from "./repositoryWorkspace.js";

/**
 * Running one command inside a Repository work session's worktree.
 *
 * Commands run directly on the host by default, with the session worktree as
 * their working directory. The Repository's command policy, bounded output,
 * timeout, and cancellation apply in both host and optional bubblewrap mode.
 * Genosyn continues to own checkpoint commits and delivery through its
 * Repository tools. A host working directory is not filesystem isolation.
 * When bubblewrap is selected, only the session worktree is mounted and its
 * .git pointer stays read-only.
 */

/** Default ceiling for one command. Long enough for a real test suite. */
export const DEFAULT_SESSION_COMMAND_MS = 5 * 60 * 1000;

/** Hard ceiling, whatever the model asks for. */
export const MAX_SESSION_COMMAND_MS = 10 * 60 * 1000;

/**
 * Output kept from one command, head and tail — see `sandboxCommandRun.ts`
 * for why both ends survive.
 *
 * Keep one command's evidence manageable for the runtime. The tail gets the
 * larger share because that is where a test runner prints its failure summary.
 */
export const MAX_SESSION_COMMAND_OUTPUT = 48 * 1024;
const HEAD_OUTPUT_BYTES = 16 * 1024;

/**
 * What every session command runs with, on top of the runner-owned `PATH`,
 * `HOME` and `LANG`. These are the hints a CI system gives a tool so it
 * behaves like a tool and not like a terminal: no colour codes in the output
 * the model reads, no interactive prompts, no spinners, no update nags.
 */
export const SESSION_COMMAND_ENV: Record<string, string> = {
  CI: "1",
  TERM: "dumb",
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  GIT_TERMINAL_PROMPT: "0",
  DEBIAN_FRONTEND: "noninteractive",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  PYTHONUNBUFFERED: "1",
};

/**
 * `$HOME` inside an optional sandbox. Host commands get a temporary directory
 * outside the worktree so caches are not included in checkpoint commits.
 */
export const SESSION_COMMAND_HOME = "/tmp";

export type SessionCommandResult = SandboxCommandResult & {
  /** Actual working directory relative to the session root; `.` means root. */
  cwd: string;
};

export type SessionCommandRefusal = { refused: string };

export function isCommandRefusal(
  result: SessionCommandResult | SessionCommandRefusal,
): result is SessionCommandRefusal {
  return "refused" in result;
}

/**
 * Whether this session can run commands at all, and why not when it cannot.
 *
 * Read before the turn starts so the briefing tells the employee the truth: a
 * session that is about to be told "run the tests before you commit" on an
 * install with commands disabled would spend the turn discovering that itself.
 */
export function workSessionCommandAvailability(
  repo: Pick<Repository, "commandMode">,
): { available: true } | { available: false; reason: string } {
  const runtime = codingRuntimeAvailability();
  if (!runtime.available) return { available: false, reason: runtime.reason };
  if (repo.commandMode === "off") {
    return {
      available: false,
      reason: "This repository does not let AI employees run commands.",
    };
  }
  return { available: true };
}

/**
 * Run one command for a work session, or explain why it will not run.
 *
 * Two gates, in the order that produces the most useful message:
 * {@link workSessionCommandAvailability} for whether this installation and
 * this repository permit commands at all, then the repository's own list for
 * whether it permits this one.
 */
export async function runWorkSessionCommand(args: {
  repo: Pick<Repository, "commandMode" | "allowedCommands">;
  /** The session worktree, which remains the sandbox root. */
  directory: string;
  /** An existing directory inside the worktree, relative to its root. */
  cwd?: string;
  command: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<SessionCommandResult | SessionCommandRefusal> {
  const availability = workSessionCommandAvailability(args.repo);
  if (!availability.available) return { refused: availability.reason };

  const decision = decideRepositoryCommand(args.repo, args.command);
  if (!decision.allowed) return { refused: decision.reason };

  const timeoutMs = Math.min(
    Math.max(1, Math.floor(args.timeoutMs ?? DEFAULT_SESSION_COMMAND_MS)),
    MAX_SESSION_COMMAND_MS,
  );

  let executable: string;
  let spawnArgs: string[];
  let childEnv: Record<string, string>;
  let commandDirectory: string;
  let relativeCwd: string;
  let hostHome: string | undefined;
  try {
    const resolved = resolveCommandDirectory(args.directory, args.cwd ?? ".");
    commandDirectory = resolved.directory;
    relativeCwd = resolved.cwd;
    if (config.agent.codingTools.executionMode === "host") {
      hostHome = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-session-command-"));
    }
    const invocation = buildSandboxShellInvocation({
      workspaceRoot: args.directory,
      cwd: commandDirectory,
      command: args.command.trim(),
      // No company Environment secrets here. A work session is reviewed by a
      // human as a diff, and a secret that entered the sandbox could leave in
      // one. The employee's own `bash` in its own working directory is where
      // that trade was made deliberately; this surface has not made it.
      env: { ...SESSION_COMMAND_ENV },
      // Not a login shell. The worktree is what the employee writes through
      // `repository_write_file`, so `bash -lc` sourcing a `.bash_profile` it
      // had just written would run code that never appeared in the command
      // and never met the repository's list.
      login: false,
      // And `$HOME` is not the worktree either, or every package manager's
      // cache would land inside it and be committed. See `SESSION_COMMAND_HOME`.
      home: hostHome ?? SESSION_COMMAND_HOME,
      readOnlyPaths: gitPointerOverlay(args.directory),
    });
    executable = invocation.executable;
    spawnArgs = invocation.args;
    childEnv = invocation.env;
  } catch (error) {
    if (hostHome) fs.rmSync(hostHome, { recursive: true, force: true });
    return { refused: `Could not prepare the command: ${messageOf(error)}` };
  }

  try {
    const result = await spawnSandboxedCommand({
      executable,
      args: spawnArgs,
      cwd: commandDirectory,
      env: childEnv,
      timeoutMs,
      signal: args.signal,
      maxOutputBytes: MAX_SESSION_COMMAND_OUTPUT,
      headOutputBytes: HEAD_OUTPUT_BYTES,
      abortedMessage: "The command was stopped because the work session ended.",
    });
    return { ...result, cwd: relativeCwd };
  } finally {
    if (hostHome) fs.rmSync(hostHome, { recursive: true, force: true });
  }
}

/** Resolve the command's folder without changing what the sandbox exposes. */
function resolveCommandDirectory(
  directory: string,
  cwd: string,
): { directory: string; cwd: string } {
  // The file tools accept a leading slash as a repository-relative spelling;
  // a command's cwd must be unambiguously relative on every host.
  if (path.isAbsolute(cwd) || path.win32.isAbsolute(cwd)) {
    throw new Error("The command working directory must be relative to the repository root.");
  }
  const normalized = normalizeRepositoryPath(cwd, { allowRoot: true });
  let resolved: string;
  try {
    const target = resolveInCheckout(directory, normalized);
    if (!fs.statSync(target).isDirectory()) {
      throw new Error("The command working directory must be an existing directory.");
    }
    resolved = fs.realpathSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error("The command working directory must be an existing directory.");
    }
    throw error;
  }
  // Check the resolved path as well: an in-tree alias must not turn a managed
  // .git directory into an apparently ordinary working directory.
  const relative = normalizeRepositoryPath(
    path.relative(fs.realpathSync(directory), resolved).split(path.sep).join("/"),
    { allowRoot: true },
  );
  return { directory: path.resolve(directory, relative), cwd: relative || "." };
}

/**
 * The worktree's `.git` pointer, to be re-bound read-only — but only when it
 * is a regular file, which is what a worktree's pointer is.
 *
 * `buildBubblewrapCommandArgs` resolves a bind source lexically, so handing it
 * a symlink would bind whatever the link points at into the sandbox. Nothing
 * can make `.git` a symlink today — the path tools refuse the name, and during
 * a command it is a mount point that cannot be replaced — but the guarantee
 * belongs next to the thing that depends on it rather than four files away.
 */
function gitPointerOverlay(directory: string): string[] {
  const pointer = path.join(directory, ".git");
  try {
    return fs.lstatSync(pointer).isFile() ? [pointer] : [];
  } catch {
    return [];
  }
}
