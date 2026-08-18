import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "../../config.js";
import { buildBubblewrapCommandArgs } from "./agent/bubblewrap.js";
import { requireCodingRuntime, type CodingExecutionMode } from "./agent/codingAvailability.js";

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 5 * 60 * 1_000;
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";
const TOKEN_ENV = /^GENOSYN_(?:GH|REPO)_TOKEN_[A-Z0-9_]+$/;

export type WorkspaceGitOptions = {
  /** Employee workspace (or a server-owned test temp dir) mounted at `/workspace`. */
  workspaceRoot: string;
  cwd: string;
  args: string[];
  extraEnv?: Record<string, string>;
  /** Trusted command-scoped helper; repository-local helpers are ignored. */
  credentialHelper?: string;
  /** Optional standard input for plumbing commands such as update-ref. */
  stdin?: string;
  /**
   * The checkout is App-owned: it lives under `.private/`, no model process
   * can write to it, and every change goes through an authenticated Member
   * request. Such a tree skips {@link requireCodingRuntime}.
   *
   * The coding-runtime gate exists because Git reads executable configuration
   * out of the tree it runs in, so running it over a *model-writable*
   * checkout is a command-execution surface and has to be an operator
   * decision. That reasoning does not reach a tree the model cannot touch —
   * and gating it there would leave the Repository UI (browse, edit, history,
   * commit) dead on the standard install, whose default execution mode is
   * `disabled`.
   *
   * The hardening is unchanged either way: no App environment inheritance,
   * hooks off, no system or global config, `ext`/`file` protocols denied, no
   * interactive credentials, and containment checks on every `.git` pointer.
   * An operator who configured bubblewrap still gets bubblewrap here.
   */
  serverOwned?: boolean;
};

export type GitInvocation = {
  executable: string;
  args: string[];
  env: Record<string, string>;
  isolated: boolean;
};

/**
 * Construct a Git child with no App environment inheritance. In bubblewrap
 * mode the checkout is the only writable host path, while PID, proc and tmp
 * are private. Command-scoped config also blocks executable local config.
 */
export function buildWorkspaceGitInvocation(
  options: WorkspaceGitOptions,
  executionMode: CodingExecutionMode = config.agent.codingTools.executionMode,
  bubblewrapPath: string = config.agent.codingTools.bubblewrapPath,
  allowUnsafeHostExecution: boolean = config.agent.codingTools.allowUnsafeHostExecution,
): GitInvocation {
  if (!options.serverOwned) {
    requireCodingRuntime({
      enabled: config.agent.codingTools.enabled,
      executionMode,
      allowUnsafeHostExecution,
    });
  }

  const extraEnv = validateExtraEnv(options.extraEnv ?? {});
  const gitConfig: Array<[string, string]> = [
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["protocol.ext.allow", "never"],
    ["protocol.file.allow", "never"],
    ["credential.interactive", "never"],
    ["credential.helper", ""],
  ];
  if (options.credentialHelper) {
    if (options.credentialHelper.includes("\0")) {
      throw new Error("Invalid Git credential helper.");
    }
    // A scoped HTTPS helper needs Git to include the repository path in the
    // credential request. This is command-scoped for clone / connection tests;
    // the persisted helper configures the same setting repository-locally.
    gitConfig.push(["credential.useHttpPath", "true"]);
    gitConfig.push(["credential.helper", options.credentialHelper]);
  }

  const childEnv: Record<string, string> = {
    PATH: SAFE_PATH,
    HOME: executionMode === "bubblewrap" ? "/workspace" : options.workspaceRoot,
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    // A repository-local core.sshCommand must never execute. Legitimate SSH
    // repositories replace this with a trusted command in `extraEnv`.
    GIT_SSH_COMMAND: "/bin/false",
    ...extraEnv,
    GIT_CONFIG_COUNT: String(gitConfig.length),
  };
  gitConfig.forEach(([key, value], index) => {
    childEnv[`GIT_CONFIG_KEY_${index}`] = key;
    childEnv[`GIT_CONFIG_VALUE_${index}`] = value;
  });

  if (executionMode !== "bubblewrap") {
    return {
      executable: "git",
      args: options.args,
      env: childEnv,
      isolated: false,
    };
  }

  return {
    executable: bubblewrapPath,
    args: buildBubblewrapCommandArgs({
      workspaceRoot: options.workspaceRoot,
      cwd: options.cwd,
      executable: "git",
      args: options.args,
      env: childEnv,
      // Git itself needs the network, but a hostile local config remains
      // confined to this namespace and receives no App/Codex environment.
      unshareNetwork: false,
    }),
    // The bwrap launcher itself receives no App secrets either.
    env: { PATH: SAFE_PATH },
    isolated: true,
  };
}

export async function runWorkspaceGit(options: WorkspaceGitOptions): Promise<{ stdout: string }> {
  assertWorkspaceGitMetadataContained(options.workspaceRoot, options.cwd);
  const invocation = buildWorkspaceGitInvocation(options);
  try {
    const { stdout } =
      options.stdin !== undefined
        ? await execWithInput(invocation, options.cwd, options.stdin)
        : await exec(invocation.executable, invocation.args, {
            cwd: options.cwd,
            env: invocation.env,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
          });
    return { stdout };
  } catch (error) {
    const command = options.args[0] ?? "(unknown)";
    if ((error as { code?: string }).code === "ENOENT") {
      const dependency = invocation.isolated ? "bubblewrap" : "git";
      throw new Error(
        `${dependency} is not installed on the Genosyn server, so "git ${command}" could not run.`,
      );
    }
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    const tail = (detail.stderr || detail.stdout || detail.message || "").toString().trim();
    throw new Error(`git ${command} failed: ${tail.split("\n").slice(-3).join(" | ")}`);
  }
}

/**
 * Git follows `.git` and `commondir` pointers before applying local config.
 * Validate those pointers before every command so an AI-writable checkout
 * cannot make the App process mutate another repository's configuration.
 */
export function assertWorkspaceGitMetadataContained(workspaceRoot: string, cwd: string): void {
  const resolvedWorkspace = fs.realpathSync(workspaceRoot);
  const resolvedCwd = fs.realpathSync(cwd);
  assertContained(resolvedWorkspace, resolvedCwd, "Git checkout");
  const gitEntry = path.join(resolvedCwd, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(gitEntry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
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
  if (!fs.existsSync(commonDirFile)) return;
  const pointer = fs.readFileSync(commonDirFile, "utf8");
  if (/\0|\r|\n.*\S/s.test(pointer)) {
    throw new Error("Git checkout has an invalid common directory pointer.");
  }
  const commonDir = fs.realpathSync(path.resolve(gitDir, pointer.trim()));
  assertContained(resolvedWorkspace, commonDir, "Git common directory");
}

function assertContained(root: string, candidate: string, label: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the employee workspace.`);
  }
}

function execWithInput(
  invocation: GitInvocation,
  cwd: string,
  stdin: string,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      env: invocation.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        Object.assign(new Error("Git command timed out."), {
          stdout,
          stderr,
        }),
      );
    }, GIT_TIMEOUT_MS);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout });
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 16 * 1024 * 1024) {
        child.kill("SIGKILL");
        finish(
          Object.assign(new Error("Git command output exceeded the limit."), { stdout, stderr }),
        );
      }
    };

    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.stdin.on("error", () => {
      // The process error / close event carries the useful Git diagnostic.
    });
    child.on("error", (error) => finish(Object.assign(error, { stdout, stderr })));
    child.on("close", (code) => {
      if (code === 0) finish();
      else
        finish(
          Object.assign(new Error(`Git exited with status ${code ?? "unknown"}.`), {
            stdout,
            stderr,
          }),
        );
    });
    child.stdin.end(stdin);
  });
}

function validateExtraEnv(extraEnv: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(extraEnv)) {
    if (name !== "GIT_SSH_COMMAND" && !TOKEN_ENV.test(name)) {
      throw new Error(`Git environment variable is not allowed: ${name}`);
    }
    if (value.includes("\0")) throw new Error(`Invalid Git environment value: ${name}`);
    if (TOKEN_ENV.test(name) && /[\r\n]/.test(value)) {
      throw new Error(`Invalid Git token environment value: ${name}`);
    }
    clean[name] = value;
  }
  return clean;
}
