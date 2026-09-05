import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Running one sandboxed command to completion, and keeping what it printed.
 *
 * `sandboxShell.ts` is the sibling of this module and states the reason both
 * exist: two callers building the same child must not drift. That file owns
 * *what the child can reach* — the workspace root, the environment, which
 * values cross the bubblewrap boundary. This one owns *what happens to the
 * child once it is running* — the process group, the timeout, the abort, and
 * the bounded output that comes back.
 *
 * Two callers share it, and they are alike in the way that matters:
 *
 *   - `services/repositoryCommandRun.ts`, running a Repository work session's
 *     `repository_run_command` in that session's worktree;
 *   - `services/routineChecks.ts`, running a Routine's `command` Check against
 *     the employee's working directory before a Run may finalize green.
 *
 * Both are one-shot: the result is the whole point of the call, and nothing
 * either starts should outlive it. That is what separates them from the
 * employee's `bash` tool, which deliberately carries machinery for keeping a
 * background process — a dev server — alive until the model turn closes. The
 * process group here is killed unconditionally once the shell closes, because
 * the directory the command ran in may be pruned the moment the caller
 * returns.
 */

/** Output kept from one command when the caller does not say otherwise. */
export const DEFAULT_MAX_OUTPUT_BYTES = 120 * 1024;

/** How much of that ceiling the head gets, by default. See {@link boundedOutput}. */
export const DEFAULT_HEAD_OUTPUT_BYTES = 40 * 1024;

export type SandboxCommandResult = {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
};

export type SandboxCommandOptions = {
  executable: string;
  args: string[];
  cwd: string;
  /** The child's environment, already built by `buildSandboxShellInvocation`. */
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Total output kept. Defaults to {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
  /** How much of it the head keeps. Defaults to {@link DEFAULT_HEAD_OUTPUT_BYTES}. */
  headOutputBytes?: number;
  /**
   * What to say when {@link SandboxCommandOptions.signal} fires.
   *
   * The sentence belongs to the caller because only the caller knows why its
   * own signal aborted — a work session ending and a Run running out of
   * deadline are different facts, and telling an employee the wrong one is
   * worse than telling it nothing.
   */
  abortedMessage?: string;
};

/**
 * Spawn, collect bounded output, and make sure nothing survives the call.
 *
 * Never rejects. A command that could not be spawned at all comes back as a
 * null exit code with the reason in `output`, because every caller has to
 * render that case to a model or a human anyway, and an exception here would
 * only be caught and reshaped into exactly this.
 */
export function spawnSandboxedCommand(
  options: SandboxCommandOptions,
): Promise<SandboxCommandResult> {
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
        // Nothing will ever type into this command. Closing stdin makes an
        // interactive prompt — `npm init`, a confirmation, a pager — fail at
        // once with EOF instead of sitting on a read until the timeout kills
        // it and the employee is told the command was stopped.
        stdio: ["ignore", "pipe", "pipe"],
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

    const collector = boundedOutput(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      options.headOutputBytes ?? DEFAULT_HEAD_OUTPUT_BYTES,
    );
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
        finish(null, options.abortedMessage ?? "The command was stopped before it finished.");
        return;
      }
      finish(code);
    });
  });
}

/**
 * Keep the head and the tail of a command's output, and say what was cut.
 *
 * Both ends are kept when a command overruns the ceiling, because both ends
 * matter and for opposite reasons: a compiler prints the first error at the
 * top, and a test runner prints the failure summary at the bottom. Keeping
 * only the head, the way the employee's `bash` tool does, throws away the half
 * that usually says what went wrong.
 */
function boundedOutput(
  maxBytes: number,
  headBytesLimit: number,
): {
  append: (chunk: Buffer) => void;
  text: () => { text: string; truncated: boolean };
} {
  const head: Buffer[] = [];
  const tail: Buffer[] = [];
  let headBytes = 0;
  let tailBytes = 0;
  let droppedBytes = 0;
  const headCapacity = Math.max(0, Math.min(headBytesLimit, maxBytes));
  const tailCapacity = Math.max(0, maxBytes - headCapacity);

  const append = (chunk: Buffer): void => {
    let rest = chunk;
    if (headBytes < headCapacity) {
      const take = Math.min(headCapacity - headBytes, rest.length);
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

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
