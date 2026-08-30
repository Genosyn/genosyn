import fs from "node:fs";
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

/**
 * Running one command inside a Repository work session's worktree.
 *
 * There is one execution mode here, and it is bubblewrap. The session worktree
 * is the sandbox root — not the employee's working directory, and not the
 * repository workspace above it. That choice is the whole design:
 *
 *   - The Member checkout beside it stays unreachable. It is the tree that
 *     holds a real `origin` and pushes with the company's credential, and the
 *     reason `repositoryWorkspace.ts` keeps two checkouts at all is that this
 *     one is model-unreachable. A command that could read or write it would
 *     collapse that distinction.
 *   - Other sessions stay unreachable, including this employee's own.
 *   - Git does not work inside the sandbox, and that is intended rather than
 *     tolerated. A worktree's `.git` is a pointer to a directory in the
 *     Member checkout, which is not mounted, so `git` reports no repository.
 *     Recording work stays the App's job through `repository_commit`, where
 *     the committer identity, the branch, and the hooks-off, config-scoped
 *     invocation are all server-owned.
 *
 * What the command *can* do is the thing the feature exists for: run the
 * repository's tests, its linter, its formatter, its build — against the files
 * the employee just edited, before a human is asked to read the diff.
 */

/** Default ceiling for one command. Long enough for a real test suite. */
export const DEFAULT_SESSION_COMMAND_MS = 5 * 60 * 1000;

/** Hard ceiling, whatever the model asks for. */
export const MAX_SESSION_COMMAND_MS = 10 * 60 * 1000;

/**
 * Output kept from one command. Generous, because the thing a human is about
 * to read the diff for is usually the failing test that scrolled past.
 * `sandboxCommandRun.ts` explains why both ends of it survive truncation.
 */
export const MAX_SESSION_COMMAND_OUTPUT = 120 * 1024;
const HEAD_OUTPUT_BYTES = 40 * 1024;

export type SessionCommandResult = SandboxCommandResult;

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
 * install with no sandbox would spend the turn discovering that itself.
 */
export function workSessionCommandAvailability(
  repo: Pick<Repository, "commandMode">,
): { available: true } | { available: false; reason: string } {
  const runtime = codingRuntimeAvailability();
  if (!runtime.available) return { available: false, reason: runtime.reason };
  // Bubblewrap or nothing, for the same reason `bash` is bubblewrap-only in
  // `agent/tools/index.ts`: a host shell runs as the App's own OS user, where
  // a working directory is a convention rather than a boundary — it could read
  // the database, the managed encryption roots, or another child's bearer
  // token through /proc. Acknowledging host execution buys server-owned Git
  // and the path-confined file tools; it has never bought an employee a shell,
  // and a work session is not the place to start.
  if (config.agent.codingTools.executionMode !== "bubblewrap") {
    return {
      available: false,
      reason:
        "Commands in a work session run only behind bubblewrap isolation, and this Genosyn installation is not using it.",
    };
  }
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
  /** The session worktree. Both the sandbox root and the working directory. */
  directory: string;
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
  try {
    const invocation = buildSandboxShellInvocation({
      workspaceRoot: args.directory,
      cwd: args.directory,
      command: args.command.trim(),
      // No company Environment secrets here. A work session is reviewed by a
      // human as a diff, and a secret that entered the sandbox could leave in
      // one. The employee's own `bash` in its own working directory is where
      // that trade was made deliberately; this surface has not made it.
      env: {},
      // Not a login shell. `$HOME` is this worktree, which the employee writes
      // through `repository_write_file`, so `bash -lc` would source a
      // `.bash_profile` the employee had just written — running code that
      // never appeared in the command and never met the repository's list.
      login: false,
      readOnlyPaths: gitPointerOverlay(args.directory),
    });
    executable = invocation.executable;
    spawnArgs = invocation.args;
    childEnv = invocation.env;
  } catch (error) {
    return { refused: `Could not prepare the command: ${messageOf(error)}` };
  }

  return spawnSandboxedCommand({
    executable,
    args: spawnArgs,
    cwd: args.directory,
    env: childEnv,
    timeoutMs,
    signal: args.signal,
    maxOutputBytes: MAX_SESSION_COMMAND_OUTPUT,
    headOutputBytes: HEAD_OUTPUT_BYTES,
    abortedMessage: "The command was stopped because the work session ended.",
  });
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
