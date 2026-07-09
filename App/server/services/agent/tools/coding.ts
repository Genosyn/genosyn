import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentTool, ToolResult } from "../types.js";

/**
 * The built-in coding toolset — bash + file read/write/edit + glob/grep — that
 * the harness CLIs used to bring. We reimplement it in-process so an employee
 * running on any provider (Anthropic, OpenAI, a local model) can still do real
 * work: edit repos, run commands, grep a codebase.
 *
 * Everything is rooted at the employee's working directory (`cwd`). File tools
 * refuse to touch paths that resolve outside it; `bash` inherits `cwd` and the
 * company-secret + repo env, matching the autonomous posture the harnesses ran
 * with (they used `--dangerously-skip-permissions` / `--sandbox workspace-write`
 * — Genosyn is the trust boundary, the employee is confined to its own dir).
 */

export type CodingToolContext = {
  /** Absolute path the employee is confined to. */
  cwd: string;
  /** Env for `bash` (company secrets + materialized repo vars merged in). */
  env: Record<string, string>;
  /** Hard ceiling for a single `bash` invocation. */
  bashTimeoutMs: number;
  signal?: AbortSignal;
};

const MAX_READ_BYTES = 400 * 1024;
const MAX_BASH_OUTPUT = 100 * 1024;
const MAX_GREP_MATCHES = 200;
const MAX_GLOB_RESULTS = 500;

export function codingTools(ctx: CodingToolContext): AgentTool[] {
  return [
    bashTool(ctx),
    readFileTool(ctx),
    writeFileTool(ctx),
    editFileTool(ctx),
    listDirTool(ctx),
    globTool(ctx),
    grepTool(ctx),
  ];
}

// ---------- path safety ----------

/** Resolve `p` under `cwd`, rejecting anything that escapes the sandbox. */
function resolveInside(cwd: string, p: string): { path: string } | { error: string } {
  const target = path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { error: `Path escapes the working directory: ${p}` };
  }
  return { path: target };
}

function ok(content: string): ToolResult {
  return { content };
}
function fail(content: string): ToolResult {
  return { content, isError: true };
}

// ---------- bash ----------

function bashTool(ctx: CodingToolContext): AgentTool {
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
        typeof input.timeout_ms === "number" && input.timeout_ms > 0
          ? Math.min(input.timeout_ms, ctx.bashTimeoutMs)
          : ctx.bashTimeoutMs;
      return runBash(command, ctx, timeout);
    },
  };
}

function runBash(
  command: string,
  ctx: CodingToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    // Already cancelled before we start — bail without spawning. addEventListener
    // never fires for an already-aborted signal, so this guard is load-bearing.
    if (ctx.signal?.aborted) {
      resolve(fail("Command aborted before it started."));
      return;
    }
    const child = spawn("bash", ["-lc", command], {
      cwd: ctx.cwd,
      env: { ...process.env, ...ctx.env },
      // Own process group so a SIGKILL can reach bash's forked/backgrounded
      // children (pipelines, `cmd &`, dev servers) instead of orphaning them.
      detached: true,
    });
    // Kill the whole process group (negative pid). Falls back to the single
    // pid, and swallows ESRCH when the group has already exited.
    const killTree = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }
    };
    let out = "";
    let truncated = false;
    const append = (b: Buffer) => {
      if (truncated) return;
      out += b.toString("utf8");
      if (out.length > MAX_BASH_OUTPUT) {
        out = out.slice(0, MAX_BASH_OUTPUT);
        truncated = true;
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);

    const onAbort = () => killTree();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      resolve(fail(`Failed to run command: ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      const suffix = truncated ? "\n… [output truncated]" : "";
      if (timedOut) {
        resolve(fail(`Command timed out after ${timeoutMs}ms.\n${out}${suffix}`));
      } else {
        const tag = code === 0 ? "" : `\n[exit code ${code}]`;
        resolve({ content: `${out}${suffix}${tag}` || "(no output)", isError: code !== 0 });
      }
    });
  });
}

// ---------- read ----------

function readFileTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the working directory. Returns the file contents; optionally slice by line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        offset: { type: "number", description: "1-based line to start from (optional)." },
        limit: { type: "number", description: "Max number of lines to return (optional)." },
      },
      required: ["path"],
      additionalProperties: false,
    },
    run: async (input) => {
      const rel = String(input.path ?? "");
      const r = resolveInside(ctx.cwd, rel);
      if ("error" in r) return fail(r.error);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(r.path);
      } catch {
        return fail(`No such file: ${rel}`);
      }
      if (stat.isDirectory()) return fail(`${rel} is a directory — use list_dir.`);
      if (stat.size > MAX_READ_BYTES) {
        return fail(`File too large (${stat.size} bytes). Read a slice with offset/limit or use bash.`);
      }
      let text: string;
      try {
        text = await fsp.readFile(r.path, "utf8");
      } catch (err) {
        return fail(`Could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const offset = typeof input.offset === "number" ? Math.max(1, Math.floor(input.offset)) : 1;
      const limit = typeof input.limit === "number" ? Math.max(1, Math.floor(input.limit)) : undefined;
      if (offset === 1 && limit === undefined) return ok(text);
      const lines = text.split("\n");
      const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
      return ok(slice.join("\n"));
    },
  };
}

// ---------- write ----------

function writeFileTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "write_file",
    description:
      "Create or overwrite a file in the working directory with the given contents. Parent directories are created as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        content: { type: "string", description: "Full file contents to write." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    run: async (input) => {
      const rel = String(input.path ?? "");
      const content = typeof input.content === "string" ? input.content : "";
      const r = resolveInside(ctx.cwd, rel);
      if ("error" in r) return fail(r.error);
      try {
        await fsp.mkdir(path.dirname(r.path), { recursive: true });
        await fsp.writeFile(r.path, content, "utf8");
      } catch (err) {
        return fail(`Could not write ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok(`Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}`);
    },
  };
}

// ---------- edit ----------

function editFileTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "edit_file",
    description:
      "Replace an exact substring in a file. By default `old_string` must appear exactly once; set replace_all to replace every occurrence.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the working directory." },
        old_string: { type: "string", description: "Exact text to replace." },
        new_string: { type: "string", description: "Replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence (default false)." },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
    run: async (input) => {
      const rel = String(input.path ?? "");
      const oldStr = typeof input.old_string === "string" ? input.old_string : "";
      const newStr = typeof input.new_string === "string" ? input.new_string : "";
      const replaceAll = input.replace_all === true;
      if (!oldStr) return fail("old_string is required and must be non-empty.");
      const r = resolveInside(ctx.cwd, rel);
      if ("error" in r) return fail(r.error);
      let text: string;
      try {
        text = await fsp.readFile(r.path, "utf8");
      } catch {
        return fail(`No such file: ${rel}`);
      }
      const count = text.split(oldStr).length - 1;
      if (count === 0) return fail(`old_string not found in ${rel}.`);
      if (count > 1 && !replaceAll) {
        return fail(`old_string appears ${count} times in ${rel}. Make it unique or set replace_all.`);
      }
      // split/join for both paths — in the single case count === 1 so it
      // replaces exactly one occurrence, and unlike String.replace it never
      // interprets `$` sequences in new_string as replacement patterns
      // (`$$`, `$&`, `` $` ``, `$'`), which would silently corrupt the file.
      const updated = text.split(oldStr).join(newStr);
      try {
        await fsp.writeFile(r.path, updated, "utf8");
      } catch (err) {
        return fail(`Could not write ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok(`Edited ${rel} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? "s" : ""}).`);
    },
  };
}

// ---------- list ----------

function listDirTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "list_dir",
    description: "List the entries of a directory in the working directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path relative to the working directory (default '.')." },
      },
      additionalProperties: false,
    },
    run: async (input) => {
      const rel = typeof input.path === "string" && input.path ? input.path : ".";
      const r = resolveInside(ctx.cwd, rel);
      if ("error" in r) return fail(r.error);
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(r.path, { withFileTypes: true });
      } catch {
        return fail(`No such directory: ${rel}`);
      }
      const lines = entries
        .filter((e) => e.name !== "node_modules" && !e.name.startsWith(".git"))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
      return ok(lines.join("\n") || "(empty)");
    },
  };
}

// ---------- glob ----------

function globTool(ctx: CodingToolContext): AgentTool {
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
      const pattern = String(input.pattern ?? "");
      if (!pattern) return fail("pattern is required.");
      const rel = typeof input.path === "string" && input.path ? input.path : ".";
      const r = resolveInside(ctx.cwd, rel);
      if ("error" in r) return fail(r.error);
      const re = globToRegExp(pattern);
      const matches: string[] = [];
      // Anchor the pattern against paths relative to the SEARCH dir (r.path),
      // not the cwd — otherwise `glob({pattern:"*.py", path:"tests"})` tests
      // "tests/x.py" against `^[^/]*\.py$` and matches nothing.
      await walk(r.path, r.path, (relPath) => {
        if (re.test(relPath)) matches.push(relPath);
        return matches.length < MAX_GLOB_RESULTS;
      });
      return ok(matches.join("\n") || "(no matches)");
    },
  };
}

// ---------- grep ----------

function grepTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "grep",
    description:
      "Search file contents for a JavaScript regular expression under the working directory. Returns `path:line: text` matches.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A regular expression to search for." },
        path: { type: "string", description: "Directory to search within (default '.')." },
        glob: { type: "string", description: "Optional file glob to restrict the search (e.g. '*.ts')." },
        ignore_case: { type: "boolean", description: "Case-insensitive match (default false)." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    run: async (input) => {
      const pattern = String(input.pattern ?? "");
      if (!pattern) return fail("pattern is required.");
      let re: RegExp;
      try {
        re = new RegExp(pattern, input.ignore_case === true ? "i" : "");
      } catch (err) {
        return fail(`Invalid regex: ${err instanceof Error ? err.message : String(err)}`);
      }
      const rel = typeof input.path === "string" && input.path ? input.path : ".";
      const r = resolveInside(ctx.cwd, rel);
      if ("error" in r) return fail(r.error);
      const fileRe =
        typeof input.glob === "string" && input.glob ? globToRegExp(input.glob) : null;
      const matches: string[] = [];
      await walk(r.path, ctx.cwd, async (relPath, absPath) => {
        if (fileRe && !fileRe.test(path.basename(relPath)) && !fileRe.test(relPath)) return true;
        let stat: fs.Stats;
        try {
          stat = await fsp.stat(absPath);
        } catch {
          return true;
        }
        if (stat.size > MAX_READ_BYTES) return true;
        let text: string;
        try {
          text = await fsp.readFile(absPath, "utf8");
        } catch {
          return true; // binary / unreadable
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
            if (matches.length >= MAX_GREP_MATCHES) return false;
          }
        }
        return true;
      });
      const suffix = matches.length >= MAX_GREP_MATCHES ? "\n… [more matches truncated]" : "";
      return ok(matches.join("\n") + suffix || "(no matches)");
    },
  };
}

// ---------- shared helpers ----------

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", ".cache"]);

/**
 * Depth-first walk of `dir`, invoking `visit(relPath, absPath)` for each file.
 * The visitor returns `false` (or a Promise of it) to stop the walk early.
 */
async function walk(
  dir: string,
  root: string,
  visit: (relPath: string, absPath: string) => boolean | Promise<boolean>,
): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      const keepGoing = await walk(abs, root, visit);
      if (!keepGoing) return false;
    } else if (e.isFile()) {
      const rel = path.relative(root, abs);
      const keepGoing = await visit(rel, abs);
      if (!keepGoing) return false;
    }
  }
  return true;
}

/** Convert a shell-style glob to an anchored RegExp. Supports **, *, ?. */
function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** — match across path separators
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(re + "$");
}
