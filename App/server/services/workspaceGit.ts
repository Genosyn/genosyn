import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../../config.js";
import { buildBubblewrapCommandArgs } from "./agent/bubblewrap.js";

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
  executionMode = config.agent.codingTools.executionMode,
  bubblewrapPath = config.agent.codingTools.bubblewrapPath,
): GitInvocation {
  if (executionMode === "disabled") {
    throw new Error("Repository synchronization is disabled with coding tools.");
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
  const invocation = buildWorkspaceGitInvocation(options);
  try {
    const { stdout } = await exec(invocation.executable, invocation.args, {
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

function validateExtraEnv(extraEnv: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(extraEnv)) {
    if (name !== "GIT_SSH_COMMAND" && !TOKEN_ENV.test(name)) {
      throw new Error(`Git environment variable is not allowed: ${name}`);
    }
    if (value.includes("\0")) throw new Error(`Invalid Git environment value: ${name}`);
    clean[name] = value;
  }
  return clean;
}
