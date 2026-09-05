import { config } from "../../../config.js";
import { buildBubblewrapCommandArgs } from "./bubblewrap.js";
import type { CodingExecutionMode } from "./codingAvailability.js";

/**
 * How a shell command is handed to the operating system, in one place.
 *
 * Two callers build a shell child: the employee's `bash` tool
 * (`agent/tools/codingBash.ts`), rooted at the employee working directory, and
 * a Repository work session's `repository_run_command`
 * (`services/repositoryCommandRun.ts`), rooted at that session's worktree.
 * Their *lifecycles* differ — the first may deliberately leave a dev server
 * running until the model turn closes, the second never outlives its call —
 * but the part that decides what the child can reach must not. Environment
 * validation, the runner-owned `PATH` / `HOME` / `LANG`, which values cross
 * the bubblewrap boundary and which stay on the launcher: all of that is here
 * so the two cannot drift.
 */

export type SandboxShellOptions = {
  /** Host directory exposed read/write as `/workspace`; the child's root. */
  workspaceRoot: string;
  /** Host working directory, which must be inside {@link workspaceRoot}. */
  cwd: string;
  /** The command, run through `bash`. */
  command: string;
  /**
   * Whether to start a login shell (`bash -lc`).
   *
   * A login shell sources `$HOME/.bash_profile`, and in the sandbox `$HOME` is
   * the workspace root. Where that root is a tree the model itself writes —
   * a Repository work session's worktree — a login shell is a way to run code
   * that never appeared in the command, which would quietly undo the point of
   * the repository's allowed-command list. Such callers pass `false`; a
   * non-interactive, non-login `bash -c` sources nothing (`.bashrc` is
   * interactive-only, and `BASH_ENV` is not in the environment we build).
   *
   * Defaults to true, which is the employee `bash` tool's long-standing
   * behaviour: its workspace is its own working directory, there is no
   * allowlist for a profile to slip past, and a profile it wrote for itself is
   * a convenience rather than an escape.
   */
  login?: boolean;
  /** Explicit env for the child (for example Environment secrets). */
  env: Record<string, string>;
  /**
   * Paths inside {@link workspaceRoot} the child may read but never write.
   * Used for a worktree's `.git` pointer, which the App reads afterwards.
   */
  readOnlyPaths?: string[];
  /**
   * Where `$HOME` points inside the sandbox. Defaults to the workspace root,
   * which is right for the employee's own working directory and wrong for a
   * Repository work session: package managers write their caches under
   * `$HOME` (`~/.npm`, `~/.cache`, `~/.cargo`), and a worktree whose home is
   * itself ends up with those directories inside it — where the next
   * `repository_commit`'s `git add --all` records them. A session passes the
   * sandbox's private `/tmp`, so a cache lives exactly as long as the command.
   */
  home?: string;
};

export type SandboxShellInvocation = {
  executable: string;
  args: string[];
  /** The launcher's own environment — deliberately not the child's. */
  env: Record<string, string>;
  isolated: boolean;
};

/**
 * Build the child process for one shell command.
 *
 * Throws when an environment entry is not a usable shell variable, or when the
 * working directory is outside the workspace. It does **not** decide whether
 * command execution is permitted at all — that is
 * `codingRuntimeAvailability()`, and every caller checks it first.
 */
export function buildSandboxShellInvocation(
  options: SandboxShellOptions,
  executionMode: CodingExecutionMode = config.agent.codingTools.executionMode,
): SandboxShellInvocation {
  const safePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  for (const [name, value] of Object.entries(options.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
      throw new Error(`Invalid shell environment entry: ${name}`);
    }
    if (value.includes("\0")) throw new Error(`Invalid shell environment value: ${name}`);
  }

  // Runner-owned values win over company/repository input. In bubblewrap the
  // host workspace is mounted at /workspace, so a host HOME would make `~`,
  // package caches, and user-level config point at a path that does not exist.
  const childEnv = {
    ...options.env,
    PATH: safePath,
    HOME:
      executionMode === "bubblewrap" ? (options.home ?? "/workspace") : (options.home ?? options.cwd),
    LANG: "C.UTF-8",
  };

  const shellArgs = [options.login === false ? "-c" : "-lc", options.command];

  if (executionMode !== "bubblewrap") {
    return { executable: "bash", args: shellArgs, env: childEnv, isolated: false };
  }

  return {
    executable: config.agent.codingTools.bubblewrapPath,
    args: buildBubblewrapCommandArgs({
      workspaceRoot: options.workspaceRoot,
      cwd: options.cwd,
      executable: "bash",
      args: shellArgs,
      env: childEnv,
      unshareNetwork: !config.agent.codingTools.allowNetwork,
      readOnlyPaths: options.readOnlyPaths,
    }),
    // Company secrets belong inside the sandbox, not in the environment of the
    // host-side bwrap launcher. Variables such as LD_PRELOAD take effect before
    // bwrap can clear its child environment and would cross the boundary.
    env: { PATH: safePath },
    isolated: true,
  };
}
