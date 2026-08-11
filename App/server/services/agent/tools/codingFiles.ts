import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "../types.js";
import {
  fail,
  lstatIfPresent,
  MAX_FILE_BYTES,
  ok,
  positiveInteger,
  readFileSlice,
  resolveInside,
  writeFileAtomically,
  type CodingToolContext,
} from "./codingShared.js";

const MAX_LIST_RESULTS = 500;

export function readFileTool(ctx: CodingToolContext): AgentTool {
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
      if (typeof input.path !== "string" || !input.path) return fail("path is required.");
      const rel = input.path;
      const resolved = resolveInside(ctx.cwd, rel);
      if ("error" in resolved) return fail(resolved.error);
      if (ctx.signal?.aborted) return fail("Read aborted.");
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(resolved.path);
      } catch {
        return fail(`No such file: ${rel}`);
      }
      if (stat.isDirectory()) return fail(`${rel} is a directory — use list_dir.`);
      if (!stat.isFile()) return fail(`${rel} is not a regular file.`);
      const offset = positiveInteger(input.offset) ?? 1;
      const limit = positiveInteger(input.limit);
      if (stat.size > MAX_FILE_BYTES && limit === undefined) {
        return fail(
          `File too large (${stat.size} bytes). Read a bounded slice with offset and limit or use bash.`,
        );
      }
      if (stat.size > MAX_FILE_BYTES) {
        return readFileSlice(resolved.path, offset, limit as number, ctx.signal);
      }
      let text: string;
      try {
        text = await fsp.readFile(resolved.path, { encoding: "utf8", signal: ctx.signal });
      } catch (err) {
        if (ctx.signal?.aborted) return fail("Read aborted.");
        return fail(`Could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
        return fail(`File grew beyond ${MAX_FILE_BYTES} bytes while it was being read.`);
      }
      if (offset === 1 && limit === undefined) return ok(text);
      const lines = text.split("\n");
      const slice = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined);
      return ok(slice.join("\n"));
    },
  };
}

export function writeFileTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "write_file",
    description:
      "Atomically create or overwrite a UTF-8 file up to 400 KiB in the working directory. Parent directories are created as needed.",
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
      if (typeof input.path !== "string" || !input.path) return fail("path is required.");
      if (typeof input.content !== "string") {
        return fail("content is required and must be a string.");
      }
      const rel = input.path;
      const content = input.content;
      const contentBytes = Buffer.byteLength(content, "utf8");
      if (contentBytes > MAX_FILE_BYTES) {
        return fail(
          `Content is too large (${contentBytes} bytes). write_file accepts at most ${MAX_FILE_BYTES} bytes; use bash for larger generated artifacts.`,
        );
      }
      const resolved = resolveInside(ctx.cwd, rel);
      if ("error" in resolved) return fail(resolved.error);
      if (ctx.signal?.aborted) return fail("Write aborted.");
      try {
        const current = await lstatIfPresent(resolved.path);
        if (current && !current.isFile()) return fail(`${rel} is not a regular file.`);
        await fsp.mkdir(path.dirname(resolved.path), { recursive: true });
        // mkdir may have exposed a pre-existing symlink below a formerly-missing
        // parent. Resolve again immediately before the write.
        const checked = resolveInside(ctx.cwd, rel);
        if ("error" in checked) return fail(checked.error);
        if (ctx.signal?.aborted) return fail("Write aborted.");
        await writeFileAtomically(
          checked.path,
          content,
          ctx.signal,
          current ? current.mode & 0o777 : undefined,
        );
      } catch (err) {
        if (ctx.signal?.aborted || (err as { name?: string }).name === "AbortError") {
          return fail("Write aborted.");
        }
        return fail(`Could not write ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok(`Wrote ${contentBytes} bytes to ${rel}`);
    },
  };
}

export function editFileTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "edit_file",
    description:
      "Atomically replace an exact substring in a UTF-8 file up to 400 KiB. By default `old_string` must appear exactly once; set replace_all to replace every occurrence.",
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
      if (typeof input.path !== "string" || !input.path) return fail("path is required.");
      if (typeof input.old_string !== "string" || !input.old_string) {
        return fail("old_string is required and must be non-empty.");
      }
      if (typeof input.new_string !== "string") {
        return fail("new_string is required and must be a string.");
      }
      const rel = input.path;
      const oldString = input.old_string;
      const newString = input.new_string;
      const replaceAll = input.replace_all === true;
      const resolved = resolveInside(ctx.cwd, rel);
      if ("error" in resolved) return fail(resolved.error);
      if (ctx.signal?.aborted) return fail("Edit aborted.");
      let text: string;
      let mode: number;
      try {
        const stat = await fsp.lstat(resolved.path);
        if (!stat.isFile()) return fail(`${rel} is not a regular file.`);
        if (stat.size > MAX_FILE_BYTES) {
          return fail(
            `${rel} is too large to edit safely (${stat.size} bytes). Use bash or replace it with write_file.`,
          );
        }
        mode = stat.mode & 0o777;
        text = await fsp.readFile(resolved.path, { encoding: "utf8", signal: ctx.signal });
      } catch (err) {
        if (ctx.signal?.aborted || (err as { name?: string }).name === "AbortError") {
          return fail("Edit aborted.");
        }
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return fail(`No such file: ${rel}`);
        return fail(`Could not read ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
        return fail(`${rel} grew beyond ${MAX_FILE_BYTES} bytes while it was being read.`);
      }
      const count = text.split(oldString).length - 1;
      if (count === 0) return fail(`old_string not found in ${rel}.`);
      if (count > 1 && !replaceAll) {
        return fail(
          `old_string appears ${count} times in ${rel}. Make it unique or set replace_all.`,
        );
      }
      // split/join for both paths — in the single case count === 1 so it
      // replaces exactly one occurrence, and unlike String.replace it never
      // interprets `$` sequences in new_string as replacement patterns.
      const updated = text.split(oldString).join(newString);
      const updatedBytes = Buffer.byteLength(updated, "utf8");
      if (updatedBytes > MAX_FILE_BYTES) {
        return fail(
          `Edited content would exceed ${MAX_FILE_BYTES} bytes. Use bash for larger artifacts.`,
        );
      }
      try {
        const checked = resolveInside(ctx.cwd, rel);
        if ("error" in checked) return fail(checked.error);
        if (ctx.signal?.aborted) return fail("Edit aborted.");
        const current = await fsp.lstat(checked.path);
        if (!current.isFile()) return fail(`${rel} is not a regular file.`);
        await writeFileAtomically(checked.path, updated, ctx.signal, mode);
      } catch (err) {
        if (ctx.signal?.aborted || (err as { name?: string }).name === "AbortError") {
          return fail("Edit aborted.");
        }
        return fail(`Could not write ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return ok(
        `Edited ${rel} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? "s" : ""}).`,
      );
    },
  };
}

export function listDirTool(ctx: CodingToolContext): AgentTool {
  return {
    name: "list_dir",
    description: "List the entries of a directory in the working directory.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Directory path relative to the working directory (default '.').",
        },
      },
      additionalProperties: false,
    },
    run: async (input) => {
      const rel = typeof input.path === "string" && input.path ? input.path : ".";
      const resolved = resolveInside(ctx.cwd, rel);
      if ("error" in resolved) return fail(resolved.error);
      if (ctx.signal?.aborted) return fail("Directory listing aborted.");
      let entries: fs.Dirent[];
      try {
        const stat = await fsp.stat(resolved.path);
        if (!stat.isDirectory()) return fail(`${rel} is not a directory.`);
        entries = await fsp.readdir(resolved.path, { withFileTypes: true });
      } catch {
        return fail(`No such directory: ${rel}`);
      }
      const lines = entries
        .filter((entry) => entry.name !== "node_modules" && entry.name !== ".git")
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
      const truncated = lines.length > MAX_LIST_RESULTS;
      const visible = lines.slice(0, MAX_LIST_RESULTS);
      const suffix = truncated ? "\n… [more entries truncated]" : "";
      return ok(visible.join("\n") + suffix || "(empty)");
    },
  };
}
