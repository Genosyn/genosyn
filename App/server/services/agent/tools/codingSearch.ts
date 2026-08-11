import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { AgentTool } from "../types.js";
import {
  fail,
  MAX_FILE_BYTES,
  ok,
  resolveInside,
  validateSearchDirectory,
  walk,
  type CodingToolContext,
} from "./codingShared.js";

const MAX_GREP_MATCHES = 200;
const MAX_GLOB_RESULTS = 500;
const GREP_REGEX_TIMEOUT_MS = 250;

export function globTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "glob",
    description:
      "Find files matching a glob pattern (supports **, *, ?) under the working directory. Returns matching paths.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'." },
        path: { type: "string", description: "Directory to search within (default '.')." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    run: async (input) => {
      if (typeof input.pattern !== "string" || !input.pattern) {
        return fail("pattern is required.");
      }
      const pattern = input.pattern;
      const rel = typeof input.path === "string" && input.path ? input.path : ".";
      const resolved = resolveInside(ctx.cwd, rel);
      if ("error" in resolved) return fail(resolved.error);
      const directoryError = await validateSearchDirectory(resolved.path, rel, ctx.signal);
      if (directoryError) return directoryError;
      const regex = globToRegExp(pattern);
      const matches: string[] = [];
      // Anchor the pattern against paths relative to the SEARCH dir, not cwd.
      await walk(
        resolved.path,
        resolved.path,
        (relativePath) => {
          if (regex.test(relativePath)) matches.push(relativePath);
          return matches.length <= MAX_GLOB_RESULTS;
        },
        ctx.signal,
      );
      if (ctx.signal?.aborted) return fail("Glob aborted.");
      const truncated = matches.length > MAX_GLOB_RESULTS;
      const suffix = truncated ? "\n… [more matches truncated]" : "";
      return ok(matches.slice(0, MAX_GLOB_RESULTS).join("\n") + suffix || "(no matches)");
    },
  };
}

export function grepTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "grep",
    description:
      "Search file contents for a JavaScript regular expression under the working directory. Returns `path:line: text` matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A regular expression to search for." },
        path: { type: "string", description: "Directory to search within (default '.')." },
        glob: {
          type: "string",
          description: "Optional file glob to restrict the search (e.g. '*.ts').",
        },
        ignore_case: { type: "boolean", description: "Case-insensitive match (default false)." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    run: async (input) => {
      if (typeof input.pattern !== "string" || !input.pattern) {
        return fail("pattern is required.");
      }
      const pattern = input.pattern;
      const regexFlags = input.ignore_case === true ? "i" : "";
      try {
        new RegExp(pattern, regexFlags);
      } catch (err) {
        return fail(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const rel = typeof input.path === "string" && input.path ? input.path : ".";
      const resolved = resolveInside(ctx.cwd, rel);
      if ("error" in resolved) return fail(resolved.error);
      const directoryError = await validateSearchDirectory(resolved.path, rel, ctx.signal);
      if (directoryError) return directoryError;
      const fileRegex =
        typeof input.glob === "string" && input.glob ? globToRegExp(input.glob) : null;
      const matches: string[] = [];
      let regexError: string | undefined;
      let matcher: RegexLineMatcher;
      try {
        matcher = new RegexLineMatcher(pattern, regexFlags);
      } catch (err) {
        return fail(
          `Could not start regular expression search: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        await walk(
          resolved.path,
          ctx.cwd,
          async (relativePath, absolutePath) => {
            if (ctx.signal?.aborted) return false;
            if (
              fileRegex &&
              !fileRegex.test(path.basename(relativePath)) &&
              !fileRegex.test(relativePath)
            ) {
              return true;
            }
            let stat: fs.Stats;
            try {
              stat = await fsp.stat(absolutePath);
            } catch {
              return true;
            }
            if (stat.size > MAX_FILE_BYTES) return true;
            let text: string;
            try {
              text = await fsp.readFile(absolutePath, { encoding: "utf8", signal: ctx.signal });
            } catch {
              return !ctx.signal?.aborted;
            }
            const scanned = await matcher.match(
              text,
              MAX_GREP_MATCHES + 1 - matches.length,
              ctx.signal,
            );
            if ("error" in scanned) {
              regexError = scanned.error;
              return false;
            }
            for (const [lineIndex, preview] of scanned.matches) {
              matches.push(`${relativePath}:${lineIndex + 1}: ${preview}`);
            }
            return matches.length <= MAX_GREP_MATCHES;
          },
          ctx.signal,
        );
      } finally {
        await matcher.close();
      }
      if (ctx.signal?.aborted) return fail("Grep aborted.");
      if (regexError) return fail(regexError);
      const truncated = matches.length > MAX_GREP_MATCHES;
      const suffix = truncated ? "\n… [more matches truncated]" : "";
      return ok(matches.slice(0, MAX_GREP_MATCHES).join("\n") + suffix || "(no matches)");
    },
  };
}

const REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const regex = new RegExp(workerData.pattern, workerData.flags);
parentPort.on("message", ({ id, text, limit }) => {
  try {
    const matches = [];
    let index = 0;
    let start = 0;
    for (;;) {
      const newline = text.indexOf("\n", start);
      const line = text.slice(start, newline < 0 ? text.length : newline);
      if (regex.test(line)) {
        matches.push([index, line.trim().slice(0, 300)]);
        if (matches.length >= limit) break;
      }
      if (newline < 0) break;
      start = newline + 1;
      index += 1;
    }
    parentPort.postMessage({ id, matches });
  } catch (error) {
    parentPort.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
`;

type RegexMatchResult = { matches: Array<[number, string]> } | { error: string };
type PendingRegexMatch = {
  id: number;
  resolve: (result: RegexMatchResult) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
};

/** Keep model-supplied regex execution off the App event loop. */
class RegexLineMatcher {
  private readonly worker: Worker;
  private nextId = 1;
  private pending?: PendingRegexMatch;
  private fatalError?: string;
  private closed = false;

  constructor(pattern: string, flags: string) {
    this.worker = new Worker(REGEX_WORKER_SOURCE, {
      eval: true,
      env: {},
      workerData: { pattern, flags },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    this.worker.on("message", (message: unknown) => this.onMessage(message));
    this.worker.on("error", (error) => {
      this.fail(`Regular expression worker failed: ${error.message}`);
    });
    this.worker.on("exit", (code) => {
      if (!this.closed && code !== 0) {
        this.fail(`Regular expression worker exited with status ${code}.`);
      }
    });
  }

  match(text: string, limit: number, signal?: AbortSignal): Promise<RegexMatchResult> {
    if (signal?.aborted) return Promise.resolve({ error: "Grep aborted." });
    if (this.fatalError) return Promise.resolve({ error: this.fatalError });
    if (this.closed) return Promise.resolve({ error: "Regular expression worker is closed." });
    if (this.pending) {
      return Promise.resolve({ error: "Regular expression worker received overlapping work." });
    }

    return new Promise((resolve) => {
      const id = this.nextId++;
      const onAbort = signal
        ? () => {
            this.settle({ error: "Grep aborted." });
            this.closed = true;
            void this.worker.terminate();
          }
        : undefined;
      const timer = setTimeout(() => {
        this.settle({
          error: `Regular expression exceeded the ${GREP_REGEX_TIMEOUT_MS}ms per-file safety limit. Use a simpler pattern.`,
        });
        this.closed = true;
        void this.worker.terminate();
      }, GREP_REGEX_TIMEOUT_MS);
      this.pending = { id, resolve, timer, signal, onAbort };
      signal?.addEventListener("abort", onAbort as () => void, { once: true });
      try {
        this.worker.postMessage({ id, text, limit });
      } catch (err) {
        this.fail(
          `Regular expression worker failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.settle({ error: "Regular expression worker closed before completing the search." });
    await this.worker.terminate();
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") {
      this.fail("Regular expression worker returned an invalid result.");
      return;
    }
    const response = message as { id?: unknown; matches?: unknown; error?: unknown };
    if (!this.pending || response.id !== this.pending.id) return;
    if (typeof response.error === "string") {
      this.settle({ error: `Regular expression search failed: ${response.error}` });
      return;
    }
    if (
      !Array.isArray(response.matches) ||
      !response.matches.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          Number.isInteger(entry[0]) &&
          typeof entry[1] === "string",
      )
    ) {
      this.fail("Regular expression worker returned an invalid result.");
      return;
    }
    this.settle({ matches: response.matches as Array<[number, string]> });
  }

  private fail(message: string): void {
    this.fatalError = message;
    this.settle({ error: message });
  }

  private settle(result: RegexMatchResult): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
    pending.resolve(result);
  }
}

/** Convert a shell-style glob to an anchored RegExp. Supports **, *, ?. */
function globToRegExp(glob: string): RegExp {
  let regex = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        regex += ".*";
        index += 1;
        if (glob[index + 1] === "/") index += 1;
      } else {
        regex += "[^/]*";
      }
    } else if (character === "?") {
      regex += "[^/]";
    } else if (".+^${}()|[]\\".includes(character)) {
      regex += `\\${character}`;
    } else {
      regex += character;
    }
  }
  return new RegExp(`${regex}$`);
}
