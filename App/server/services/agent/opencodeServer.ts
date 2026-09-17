import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Config } from "@opencode-ai/sdk/v2";

const require = createRequire(import.meta.url);
export const OPENCODE_START_TIMEOUT_MS = 90_000;

/** Only intentionally supplied coding environment values reach this child. */
export function openCodeEnvironment(args: {
  home: string;
  config: Config;
  password: string;
  toolEnv?: Record<string, string>;
  bashTimeoutMs?: number;
}): NodeJS.ProcessEnv {
  const supplied = Object.fromEntries(
    Object.entries(args.toolEnv ?? {}).filter(
      ([key]) =>
        !/^(OPENCODE_|XDG_|HOME$|USERPROFILE$|ANTHROPIC_|OPENAI_|NODE_OPTIONS$|BUN_OPTIONS$)/.test(
          key,
        ),
    ),
  );
  return {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    ...supplied,
    HOME: args.home,
    USERPROFILE: args.home,
    XDG_CONFIG_HOME: path.join(args.home, "config"),
    XDG_DATA_HOME: path.join(args.home, "data"),
    XDG_STATE_HOME: path.join(args.home, "state"),
    XDG_CACHE_HOME: path.join(args.home, "cache"),
    OPENCODE_CONFIG_DIR: path.join(args.home, "config"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(args.config),
    OPENCODE_SERVER_PASSWORD: args.password,
    OPENCODE_SERVER_USERNAME: "genosyn",
    OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    OPENCODE_DISABLE_CLAUDE_CODE: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: "true",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
    OPENCODE_PURE: "true",
    OPENCODE_DB: ":memory:",
    ...(args.bashTimeoutMs
      ? {
          OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS: String(
            Math.max(1, Math.floor(args.bashTimeoutMs)),
          ),
        }
      : {}),
    OPENCODE_DISABLE_AUTOUPDATE: "true",
    OPENCODE_DISABLE_MODELS_FETCH: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
    OPENCODE_EXPERIMENTAL_LSP_TOOL: args.config.lsp === true ? "true" : "false",
  };
}

export type OpenCodeServer = {
  url: string;
  directory: string;
  authorization: string;
  exited: Promise<never>;
  close(): Promise<void>;
};

/** Launch the package pinned by Genosyn, never an operator's global executable. */
export async function startOpenCodeServer(args: {
  config: Config;
  cwd?: string;
  toolEnv?: Record<string, string>;
  bashTimeoutMs?: number;
  signal?: AbortSignal;
}): Promise<OpenCodeServer> {
  args.signal?.throwIfAborted();
  const home = await mkdtemp(path.join(os.tmpdir(), "genosyn-opencode-"));
  const password = randomBytes(32).toString("hex");
  let child: ChildProcess | undefined;
  try {
    const directory = args.cwd ? path.resolve(args.cwd) : path.join(home, "workspace");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await Promise.all(
      ["config", "data", "state", "cache"].map((name) =>
        mkdir(path.join(home, name), { mode: 0o700 }),
      ),
    );
    const packagePath = require.resolve("opencode-ai/package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      bin: { opencode: string };
    };
    const executable = path.resolve(path.dirname(packagePath), packageJson.bin.opencode);
    child = spawn(executable, ["serve", "--hostname=127.0.0.1", "--port=0", "--log-level=ERROR"], {
      cwd: home,
      env: openCodeEnvironment({
        home,
        config: args.config,
        password,
        toolEnv: args.toolEnv,
        bashTimeoutMs: args.bashTimeoutMs,
      }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const proc = child;
    let startupOutput = "";
    let started = false;
    const diagnostic = (chunk: Buffer) => {
      if (!started) startupOutput = (startupOutput + chunk.toString()).slice(-8192);
    };
    proc.stderr?.on("data", diagnostic);
    const exited = new Promise<never>((_resolve, reject) => {
      proc.once("exit", (code, signal) =>
        reject(
          new Error(
            started
              ? `OpenCode stopped unexpectedly (${signal ?? code ?? "unknown"}).`
              : openCodeStartupError(startupOutput, code),
          ),
        ),
      );
      proc.once("error", (error: NodeJS.ErrnoException) =>
        reject(
          new Error(
            `Could not launch the installed OpenCode runtime${error.code ? ` (${error.code})` : ""}.`,
          ),
        ),
      );
    });
    // The exit promise is observed below after startup; avoid a rejection gap.
    void exited.catch(() => {});
    const url = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(
        () => finish(new Error("OpenCode did not start within 90 seconds.")),
        OPENCODE_START_TIMEOUT_MS,
      );
      const abort = () => finish(args.signal?.reason ?? new Error("The turn was stopped."));
      const finish = (error?: unknown, value?: string) => {
        clearTimeout(timer);
        args.signal?.removeEventListener("abort", abort);
        proc.stdout?.removeListener("data", output);
        if (error) reject(error);
        else resolve(value!);
      };
      const output = (chunk: Buffer) => {
        buffer = (buffer + chunk.toString()).slice(-8192);
        const match = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
        if (match) {
          started = true;
          startupOutput = "";
          proc.stderr?.removeListener("data", diagnostic);
          finish(undefined, match[1]);
        }
      };
      proc.stdout?.on("data", output);
      // Runtime diagnostics can include provider response bodies. Never forward
      // them into a Run log, and drain both pipes to avoid child backpressure.
      proc.stderr?.resume();
      args.signal?.addEventListener("abort", abort, { once: true });
      void exited.catch((error) => finish(error));
      if (args.signal?.aborted) abort();
    });
    proc.stdout?.resume();
    let closed = false;
    return {
      url,
      directory,
      authorization: `Basic ${Buffer.from(`genosyn:${password}`).toString("base64")}`,
      exited,
      async close() {
        if (closed) return;
        closed = true;
        await stopOpenCodeProcess(proc);
        await rm(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child) await stopOpenCodeProcess(child);
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

export function openCodeStartupError(output: string, code: number | null): string {
  if (
    /postinstall script was not run|failed to install the right opencode CLI package/i.test(output)
  )
    return "The installed OpenCode runtime is incomplete. Reinstall the application dependencies with install scripts enabled.";
  if (/EADDRINUSE|address already in use/i.test(output))
    return "OpenCode could not open its local server port because it is already in use.";
  if (/ConfigInvalidError|invalid configuration|configuration is invalid/i.test(output))
    return "OpenCode rejected the generated runtime configuration.";
  return `OpenCode stopped before its server was ready (exit ${code ?? "unknown"}).`;
}

async function stopOpenCodeProcess(child: ChildProcess): Promise<void> {
  const kill = (signal: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      /* The process group has already ended. */
    }
  };
  if (child.exitCode !== null || child.signalCode !== null) {
    kill("SIGKILL");
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      kill("SIGKILL");
      resolve();
    });
    kill("SIGTERM");
  });
}
