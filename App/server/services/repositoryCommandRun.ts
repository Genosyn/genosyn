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
 * Output kept from one command, head and tail — see `sandboxCommandRun.ts`
 * for why both ends survive.
 *
 * Sized to fit under the agent loop's own clip on a tool result (60,000
 * characters on any window that is not tiny, `contextBudget.ts`). It used to
 * be 120 KB, which meant a long test run was cut twice: this module kept the
 * head and the tail, and the loop then kept only the head of that — throwing
 * away the failure summary the tail had been kept for. The tail gets the
 * larger share because that is where a test runner prints what failed.
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
 * `$HOME` for a session command: the sandbox's private `/tmp`, which exists
 * for exactly one command. See `SandboxShellOptions.home`.
 */
export const SESSION_COMMAND_HOME = "/tmp";

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
      env: { ...SESSION_COMMAND_ENV },
      // Not a login shell. The worktree is what the employee writes through
      // `repository_write_file`, so `bash -lc` sourcing a `.bash_profile` it
      // had just written would run code that never appeared in the command
      // and never met the repository's list.
      login: false,
      // And `$HOME` is not the worktree either, or every package manager's
      // cache would land inside it and be committed. See `SESSION_COMMAND_HOME`.
      home: SESSION_COMMAND_HOME,
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
