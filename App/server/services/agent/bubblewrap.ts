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
    "--chdir",
    sandboxCwd,
    "--clearenv",
  ];
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
