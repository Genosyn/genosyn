import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { codingRuntimeAvailability } from "../codingAvailability.js";
import { buildSandboxShellInvocation } from "../sandboxShell.js";
import type { AgentTool, ToolResult } from "../types.js";
import { fail, type CodingToolContext } from "./codingShared.js";

const MAX_BASH_OUTPUT = 100 * 1024;
const PROCESS_GROUP_POLL_MS = 1_000;

export function bashTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "bash",
    description:
      "Run a shell command in the employee's working directory and return combined stdout+stderr. Use for git, build/test commands, package managers, and anything not covered by the dedicated file tools. Times out; keep commands non-interactive.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run (bash -lc)." },
        timeout_ms: {
          type: "number",
          description: "Optional override for the command timeout in milliseconds.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    run: async (input) => {
      const command = typeof input.command === "string" ? input.command : "";
      if (!command.trim()) return fail("command is required");
      const timeout =
        typeof input.timeout_ms === "number" &&
        Number.isFinite(input.timeout_ms) &&
        input.timeout_ms > 0
          ? Math.min(input.timeout_ms, ctx.bashTimeoutMs)
          : ctx.bashTimeoutMs;
      return runBash(command, ctx, timeout);
    },
  };
}

function runBash(command: string, ctx: CodingToolContext, timeoutMs: number): Promise<ToolResult> {
  if (command.includes("\0")) return Promise.resolve(fail("Command must not contain NUL bytes."));

  const availability = codingRuntimeAvailability();
  if (!availability.available) return Promise.resolve(fail(availability.reason));
  let executable: string;
  let args: string[];
  let childEnv: Record<string, string>;
  try {
    // The employee's whole working directory is the sandbox root here: the
    // repositories it was granted, and whatever its tools wrote into cwd.
    const invocation = buildSandboxShellInvocation({
      workspaceRoot: ctx.cwd,
      cwd: ctx.cwd,
      command,
      env: ctx.env,
    });
    executable = invocation.executable;
    args = invocation.args;
    childEnv = invocation.env;
  } catch (err) {
    return Promise.resolve(
      fail(`Failed to prepare command: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  return new Promise((resolve) => {
    // Already cancelled before we start — bail without spawning. addEventListener
    // never fires for an already-aborted signal, so this guard is load-bearing.
    if (ctx.signal?.aborted) {
      resolve(fail("Command aborted before it started."));
      return;
    }
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, args, {
        cwd: ctx.cwd,
        env: childEnv,
        // Own process group so a SIGKILL can reach bash's forked/backgrounded
        // children (pipelines, `cmd &`, dev servers) instead of orphaning them.
        detached: true,
      });
    } catch (err) {
      resolve(fail(`Failed to run command: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const group = processGroupGuard(child.pid, ctx.registerProcessCleanup);
    const outputChunks: Buffer[] = [];
    let outputBytes = 0;
    let truncated = false;
    const append = (chunk: Buffer) => {
      if (truncated) return;
      const remaining = MAX_BASH_OUTPUT - outputBytes;
      if (chunk.length > remaining) {
        if (remaining > 0) outputChunks.push(chunk.subarray(0, remaining));
        outputBytes += Math.max(0, remaining);
        truncated = true;
        return;
      }
      outputChunks.push(chunk);
      outputBytes += chunk.length;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      group.kill();
    }, timeoutMs);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      group.kill();
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      group.retire();
      resolve(fail(`Failed to run command: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      // A successful command may deliberately leave a dev server running for a
      // later browser or bash call. The tool registry owns that process group
      // until the model turn closes; callers without a lifecycle registry keep
      // the safer standalone behavior and clean it up immediately.
      const groupStillExists = processGroupExists(child.pid);
      const keepForTurn =
        code === 0 &&
        !aborted &&
        !timedOut &&
        Boolean(ctx.registerProcessCleanup) &&
        groupStillExists;
      if (groupStillExists && group.captureLiveMembers()) {
        if (keepForTurn) group.monitorUntilExit();
        else group.kill();
      } else {
        group.retire();
      }

      const captured = Buffer.concat(outputChunks, outputBytes);
      const decoder = new StringDecoder("utf8");
      // When the byte ceiling cuts through a multi-byte code point, decoder.write
      // retains the incomplete tail. Do not flush that tail for truncated output;
      // doing so would add U+FFFD and make the encoded result exceed the byte cap.
      const out = decoder.write(captured) + (truncated ? "" : decoder.end());
      const suffix = truncated ? "\n… [output truncated]" : "";
      if (aborted) {
        resolve(fail(`Command aborted.${out ? `\n${out}${suffix}` : suffix}`));
      } else if (timedOut) {
        resolve(fail(`Command timed out after ${timeoutMs}ms.\n${out}${suffix}`));
      } else {
        const tag = code === 0 ? "" : `\n[exit code ${code}]`;
        resolve({ content: `${out}${suffix}${tag}` || "(no output)", isError: code !== 0 });
      }
    });
  });
}

type ProcessGroupGuard = {
  captureLiveMembers: () => boolean;
  kill: () => void;
  retire: () => void;
  monitorUntilExit: () => void;
};

/**
 * Keep a retained process-group cleanup from surviving longer than the group.
 * Once the shell leader closes, the guard snapshots live background member
 * identities. Cleanup signals the PGID only while at least one of those exact
 * processes remains, so PID/PGID reuse cannot target an unrelated group.
 */
function processGroupGuard(
  pid: number | undefined,
  registerCleanup?: (cleanup: () => void) => () => void,
): ProcessGroupGuard {
  let leaderIsLive = true;
  let retainedMembers: Map<number, string> | undefined;
  let retired = false;
  let monitor: NodeJS.Timeout | undefined;
  let unregister = () => {};

  const hasOriginalMember = (): boolean => {
    if (!retainedMembers || pid === undefined) return false;
    const current = readProcessGroupMembers(pid);
    if (!current) return false;
    for (const [memberPid, identity] of retainedMembers) {
      if (current.get(memberPid) === identity) {
        // While an original identity is still present the PGID cannot have
        // been recycled, so safely include descendants created since capture.
        retainedMembers = current;
        return true;
      }
    }
    return false;
  };

  const retire = () => {
    if (retired) return;
    retired = true;
    if (monitor) clearInterval(monitor);
    monitor = undefined;
    unregister();
  };

  const kill = () => {
    if (retired) return;
    // Before the shell closes, `pid` is still the exact ChildProcess we own.
    // Afterward, require a matching retained member before signalling -PGID.
    if (!leaderIsLive && !hasOriginalMember()) {
      retire();
      return;
    }
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    retire();
  };

  unregister = registerCleanup?.(kill) ?? (() => {});
  if (retired) unregister();

  const captureLiveMembers = (): boolean => {
    leaderIsLive = false;
    if (pid === undefined) {
      retire();
      return false;
    }
    const members = readProcessGroupMembers(pid);
    if (!members || members.size === 0) {
      // If the platform cannot prove group identity, leave a possibly-reused
      // PGID alone. This can leak a background process but cannot kill a peer.
      retire();
      return false;
    }
    retainedMembers = members;
    return true;
  };

  const monitorUntilExit = () => {
    if (retired || monitor) return;
    monitor = setInterval(() => {
      if (!hasOriginalMember()) retire();
    }, PROCESS_GROUP_POLL_MS);
    monitor.unref();
  };

  return { captureLiveMembers, kill, retire, monitorUntilExit };
}

function processGroupExists(pid: number | undefined): boolean {
  if (pid === undefined || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Map live members of a process group to immutable process-start identities. */
function readProcessGroupMembers(pgid: number): Map<number, string> | undefined {
  if (process.platform === "linux") return readLinuxProcessGroupMembers(pgid);
  if (process.platform === "darwin") return readDarwinProcessGroupMembers(pgid);
  return undefined;
}

function readLinuxProcessGroupMembers(pgid: number): Map<number, string> | undefined {
  try {
    const members = new Map<number, string>();
    for (const entry of fs.readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${entry.name}/stat`, "utf8");
        // comm (field 2) may contain spaces or parentheses. Everything after
        // its final `) ` starts at field 3; pgrp is field 5 and starttime 22.
        const afterCommand = stat
          .slice(stat.lastIndexOf(") ") + 2)
          .trim()
          .split(/\s+/);
        if (Number(afterCommand[2]) !== pgid || !afterCommand[19]) continue;
        members.set(Number(entry.name), afterCommand[19]);
      } catch {
        // A process can exit between readdir and read; skip that entry.
      }
    }
    return members;
  } catch {
    return undefined;
  }
}

function readDarwinProcessGroupMembers(pgid: number): Map<number, string> | undefined {
  try {
    const output = execFileSync("/bin/ps", ["-axo", "pid=,pgid=,lstart="], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
      timeout: 1_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const members = new Map<number, string>();
    for (const line of output.split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
      if (!match || Number(match[2]) !== pgid) continue;
      members.set(Number(match[1]), match[3]);
    }
    return members;
  } catch {
    return undefined;
  }
}
