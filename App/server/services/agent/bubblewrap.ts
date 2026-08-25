import path from "node:path";

export type BubblewrapCommandOptions = {
  /** Host directory exposed read/write as `/workspace`. */
  workspaceRoot: string;
  /** Host working directory, which must be inside `workspaceRoot`. */
  cwd: string;
  /** Executable resolved inside the sandbox's explicit PATH. */
  executable: string;
  args: string[];
  /** Complete child environment; bubblewrap clears everything else. */
  env: Record<string, string>;
  unshareNetwork?: boolean;
  /**
   * Host paths inside {@link workspaceRoot} to re-bind read-only over the
   * writable workspace. Bind mounts are applied in order, so these land on top
   * of `/workspace` and win.
   *
   * The case this exists for is a git worktree's `.git` pointer. The worktree
   * is the child's whole world, but that one entry is read by the App
   * afterwards to commit the work; a command that truncated or replaced it
   * would break its own session for no gain. A mount point also cannot be
   * unlinked, so `rm -rf` inside the worktree leaves it standing.
   */
  readOnlyPaths?: string[];
};

/**
 * Build the namespace boundary shared by AI Employee shell calls and
 * server-managed Git. Keeping this in one place prevents repository
 * materialization from becoming a same-UID escape around the coding sandbox.
 */
export function buildBubblewrapCommandArgs(options: BubblewrapCommandOptions): string[] {
  const root = path.resolve(options.workspaceRoot);
  const cwd = path.resolve(options.cwd);
  const relativeCwd = path.relative(root, cwd);
  if (
    relativeCwd === ".." ||
    relativeCwd.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeCwd)
  ) {
    throw new Error("Bubblewrap working directory must stay inside the workspace.");
  }

  const sandboxCwd =
    relativeCwd.length === 0 ? "/workspace" : `/workspace/${relativeCwd.split(path.sep).join("/")}`;
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    // A private cgroup namespace is useful where the kernel exposes one, but
    // it is not part of the credential boundary (user/PID namespaces and the
    // private /tmp are). Do not reject otherwise valid Linux sandboxes solely
    // because their kernel or container runtime omits cgroup namespaces.
    "--unshare-cgroup-try",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--ro-bind",
    "/bin",
    "/bin",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind-try",
    "/lib",
    "/lib",
    "--ro-bind-try",
    "/lib64",
    "/lib64",
    "--ro-bind-try",
    "/etc/ssl",
    "/etc/ssl",
    "--ro-bind-try",
    "/etc/ca-certificates",
    "/etc/ca-certificates",
    "--ro-bind-try",
    "/etc/ssh",
    "/etc/ssh",
    "--ro-bind-try",
    "/etc/hosts",
    "/etc/hosts",
    "--ro-bind-try",
    "/etc/resolv.conf",
    "/etc/resolv.conf",
    "--ro-bind-try",
    "/etc/nsswitch.conf",
    "/etc/nsswitch.conf",
    "--ro-bind-try",
    "/etc/passwd",
    "/etc/passwd",
    "--ro-bind-try",
    "/etc/group",
    "/etc/group",
    "--bind",
    root,
    "/workspace",
  ];
  // After the workspace bind and before anything else, so a later option
  // cannot quietly make one of these writable again.
  for (const readOnlyPath of options.readOnlyPaths ?? []) {
    const resolved = path.resolve(readOnlyPath);
    const relative = path.relative(root, resolved);
    if (
      relative.length === 0 ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Bubblewrap read-only path must stay inside the workspace.");
    }
    // `-try` because the path is an expectation, not a precondition: a session
    // whose worktree has not been materialized yet must not fail to start.
    args.push("--ro-bind-try", resolved, `/workspace/${relative.split(path.sep).join("/")}`);
  }
  args.push("--chdir", sandboxCwd, "--clearenv");
  if (options.unshareNetwork) args.push("--unshare-net");

  for (const [name, value] of Object.entries(options.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) {
      throw new Error(`Invalid bubblewrap environment entry: ${name}`);
    }
    args.push("--setenv", name, value);
  }
  args.push("--", options.executable, ...options.args);
  return args;
}
