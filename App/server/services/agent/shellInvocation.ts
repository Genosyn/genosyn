/**
 * How a shell command is handed to the operating system, in one place.
 *
 * Three callers build a shell child: the employee's `bash` tool
 * (`agent/tools/codingBash.ts`), rooted at the employee working directory; a
 * Repository work session's `repository_run_command`
 * (`services/repositoryCommandRun.ts`), rooted at that session's worktree; and
 * a Routine's `command` Check (`services/routineChecks.ts`). Their *lifecycles*
 * differ — the `bash` tool may deliberately leave a dev server running until
 * the model turn closes, the others never outlive their call — but the part
 * that decides what the child receives must not. Environment validation and
 * the runner-owned `PATH` / `HOME` / `LANG` are all here so the callers cannot
 * drift.
 *
 * The child runs on the host with the App process user's filesystem and
 * network authority. Its working directory is where it starts, not a boundary.
 */

export type ShellInvocationOptions = {
  /** The child's working directory. */
  cwd: string;
  /** The command, run through `bash`. */
  command: string;
  /**
   * Whether to start a login shell (`bash -lc`).
   *
   * A login shell sources `$HOME/.bash_profile`. Where `$HOME` is a tree the
   * model itself writes — a Repository work session's worktree, or the
   * employee working directory a command Check runs in — a login shell is a way
   * to run code that never appeared in the command, which would quietly undo
   * the point of the repository's allowed-command list. Such callers pass
   * `false`; a non-interactive, non-login `bash -c` sources nothing (`.bashrc`
   * is interactive-only, and `BASH_ENV` is not in the environment we build).
   *
   * Defaults to true, which is the employee `bash` tool's long-standing
   * behaviour: its home is its own working directory, there is no allowlist for
   * a profile to slip past, and a profile it wrote for itself is a convenience
   * rather than an escape.
   */
  login?: boolean;
  /** Explicit env for the child (for example Environment secrets). */
  env: Record<string, string>;
  /**
   * Where `$HOME` points. Defaults to {@link cwd}, which is right for the
   * employee's own working directory and wrong for a Repository work session:
   * package managers write their caches under `$HOME` (`~/.npm`, `~/.cache`,
   * `~/.cargo`), and a worktree whose home is itself ends up with those
   * directories inside it — where the next `repository_commit`'s
   * `git add --all` records them. A session passes a temporary directory, so a
   * cache lives exactly as long as the command.
   */
  home?: string;
};

export type ShellInvocation = {
  executable: string;
  args: string[];
  /** The child's complete environment; nothing is inherited from the App. */
  env: Record<string, string>;
};

/**
 * Build the child process for one shell command.
 *
 * Throws when an environment entry is not a usable shell variable. It does
 * **not** decide whether command execution is permitted at all — that is
 * `codingRuntimeAvailability()`, and every caller checks it first.
 */
export function buildShellInvocation(options: ShellInvocationOptions): ShellInvocation {
  const safePath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  for (const [name, value] of Object.entries(options.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string") {
      throw new Error(`Invalid shell environment entry: ${name}`);
    }
    if (value.includes("\0")) throw new Error(`Invalid shell environment value: ${name}`);
  }

  // Runner-owned values win over company/repository input.
  const env = {
    ...options.env,
    PATH: safePath,
    HOME: options.home ?? options.cwd,
    LANG: "C.UTF-8",
  };
  return {
    executable: "bash",
    args: [options.login === false ? "-c" : "-lc", options.command],
    env,
  };
}
