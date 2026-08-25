import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { config } from "../../config.js";
import type { Repository } from "../db/entities/Repository.js";
import { codingRuntimeAvailability } from "./agent/codingAvailability.js";
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
 * Output kept from one command.
 *
 * Both ends are kept when a command overruns it, because both ends matter and
 * for opposite reasons: a compiler prints the first error at the top, and a
 * test runner prints the failure summary at the bottom. Keeping only the head,
 * the way the employee's `bash` tool does, throws away the half that usually
 * says what went wrong.
 */
export const MAX_SESSION_COMMAND_OUTPUT = 120 * 1024;
const HEAD_OUTPUT_BYTES = 40 * 1024;

export type SessionCommandResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
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

  return spawnSessionCommand({
    executable,
    args: spawnArgs,
    cwd: args.directory,
    env: childEnv,
    timeoutMs,
    signal: args.signal,
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

/**
 * Spawn, collect bounded output, and make sure nothing survives the call.
 *
 * Deliberately simpler than the employee `bash` tool's process handling, which
 * carries machinery for keeping a background process — a dev server — alive
 * until the model turn closes. Nothing a work session starts should outlive
 * the command that started it: the worktree it runs in may be pruned the
 * moment the turn ends. So the process group is killed unconditionally once
 * the shell closes.
 */
function spawnSessionCommand(options: {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<SessionCommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({
        output: "",
        exitCode: null,
        timedOut: false,
        aborted: true,
        truncated: false,
      });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.executable, options.args, {
        cwd: options.cwd,
        env: options.env,
        // Own process group so the kill below reaches anything the command
        // forked or backgrounded, rather than orphaning it.
        detached: true,
      });
    } catch (error) {
      resolve({
        output: `Could not run the command: ${messageOf(error)}`,
        exitCode: null,
        timedOut: false,
        aborted: false,
        truncated: false,
      });
      return;
    }

    const collector = boundedOutput();
    child.stdout?.on("data", collector.append);
    child.stderr?.on("data", collector.append);

    const killGroup = (): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    };

    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      killGroup();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, prefix = ""): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      killGroup();
      const collected = collector.text();
      resolve({
        output: prefix ? `${prefix}${collected.text ? `\n${collected.text}` : ""}` : collected.text,
        exitCode,
        timedOut,
        aborted,
        truncated: collected.truncated,
      });
    };

    child.on("error", (error) => finish(null, `Could not run the command: ${error.message}`));
    child.on("close", (code) => {
      if (timedOut) {
        finish(null, `The command was stopped after ${Math.round(options.timeoutMs / 1000)}s.`);
        return;
      }
      if (aborted) {
        finish(null, "The command was stopped because the work session ended.");
        return;
      }
      finish(code);
    });
  });
}

/** Keep the head and the tail of a command's output, and say what was cut. */
function boundedOutput(): {
  append: (chunk: Buffer) => void;
  text: () => { text: string; truncated: boolean };
} {
  const head: Buffer[] = [];
  const tail: Buffer[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let droppedBytes = 0;
  const tailCapacity = MAX_SESSION_COMMAND_OUTPUT - HEAD_OUTPUT_BYTES;

  const append = (chunk: Buffer): void => {
    let rest = chunk;
    if (headBytes < HEAD_OUTPUT_BYTES) {
      const take = Math.min(HEAD_OUTPUT_BYTES - headBytes, rest.length);
      head.push(rest.subarray(0, take));
      headBytes += take;
      rest = rest.subarray(take);
    }
    if (rest.length === 0) return;
    tail.push(rest);
    tailBytes += rest.length;
    while (tailBytes > tailCapacity && tail.length > 0) {
      const oldest = tail[0];
      const excess = tailBytes - tailCapacity;
      if (oldest.length <= excess) {
        tail.shift();
        tailBytes -= oldest.length;
        droppedBytes += oldest.length;
      } else {
        tail[0] = oldest.subarray(excess);
        tailBytes -= excess;
        droppedBytes += excess;
      }
    }
  };

  const decode = (buffer: Buffer): string => {
    const decoder = new StringDecoder("utf8");
    return decoder.write(buffer) + decoder.end();
  };

  const text = (): { text: string; truncated: boolean } => {
    // Nothing was dropped, so the two halves are contiguous bytes and must be
    // decoded as one. Decoding them separately would split any multi-byte
    // character that happens to straddle the head ceiling into two replacement
    // characters, in output that was never truncated at all.
    if (droppedBytes === 0) {
      return {
        text: decode(Buffer.concat([...head, ...tail], headBytes + tailBytes)),
        truncated: false,
      };
    }
    return {
      text: `${decode(Buffer.concat(head, headBytes))}\n… [${droppedBytes} bytes of output omitted] …\n${decode(Buffer.concat(tail, tailBytes))}`,
      truncated: true,
    };
  };

  return { append, text };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
