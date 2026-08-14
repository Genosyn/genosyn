import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ToolResult } from "../types.js";

export type CodingToolContext = {
  /** Absolute path the employee is confined to. */
  cwd: string;
  /** Explicit env for `bash` (for example Environment secrets). */
  env: Record<string, string>;
  /** Hard ceiling for a single `bash` invocation. */
  bashTimeoutMs: number;
  signal?: AbortSignal;
  /** Keep successful background processes alive until the model turn closes. */
  registerProcessCleanup?: (cleanup: () => void) => () => void;
};

export const MAX_FILE_BYTES = 400 * 1024;
const FILE_TEMP_PREFIX = ".genosyn-write-";
const SKIP_DIRS = new Set(["node_modules", ".git", ".ssh", "dist", "build", ".next", ".cache"]);
const PROTECTED_WORKSPACE_COMPONENTS = new Set([".git", ".ssh"]);

/** Resolve `p` under `cwd`, rejecting anything that escapes the sandbox. */
export function resolveInside(cwd: string, p: string): { path: string } | { error: string } {
  const target = path.resolve(cwd, p);
  const root = path.resolve(cwd);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return { error: `Path escapes the working directory: ${p}` };
  }
  const relative = path.relative(root, target);
  if (isProtectedWorkspaceRelativePath(relative)) {
    return { error: `Path is reserved for App-managed workspace state: ${p}` };
  }
  try {
    const realRoot = fs.realpathSync(root);
    let existing = target;
    // existsSync follows symlinks, so it reports a dangling symlink as absent.
    // For a write that is dangerous: writeFile would follow the same link and
    // create its missing target outside the workspace. lstat sees the directory
    // entry itself, making realpath reject dangling links before any write.
    while (!pathEntryExists(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) {
      return { error: `Path traverses a symlink outside the working directory: ${p}` };
    }
    if (isProtectedWorkspaceRelativePath(path.relative(realRoot, realExisting))) {
      return { error: `Path resolves through App-managed workspace state: ${p}` };
    }
    if (pathEntryExists(target)) {
      const realTarget = fs.realpathSync(target);
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        return { error: `Path resolves outside the working directory: ${p}` };
      }
      if (isProtectedWorkspaceRelativePath(path.relative(realRoot, realTarget))) {
        return { error: `Path resolves to App-managed workspace state: ${p}` };
      }
    }
  } catch {
    return { error: `Could not safely resolve path: ${p}` };
  }
  return { path: target };
}

/** Never expose App-managed credentials or Git control files to model tools. */
export function isProtectedWorkspaceRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath === ".") return false;
  const components = relativePath
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((component) => component.toLowerCase());
  return components.some(
    (component) =>
      PROTECTED_WORKSPACE_COMPONENTS.has(component) ||
      component.startsWith(".browser-state.json") ||
      component.startsWith(".genosyn-git-fetch-"),
  );
}

function pathEntryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

export function ok(content: string): ToolResult {
  return { content };
}

export function fail(content: string): ToolResult {
  return { content, isError: true };
}

export function positiveInteger(value: unknown, fallback?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

export async function lstatIfPresent(target: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.lstat(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw err;
  }
}

/**
 * Write beside the target and rename only after the complete payload is on
 * disk. Cancellation or an I/O failure therefore leaves the previous file
 * intact instead of leaving a truncated half-write behind.
 */
export async function writeFileAtomically(
  target: string,
  content: string,
  signal?: AbortSignal,
  mode?: number,
): Promise<void> {
  signal?.throwIfAborted();
  const temp = path.join(path.dirname(target), `${FILE_TEMP_PREFIX}${randomUUID()}`);
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(
      temp,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      mode ?? 0o666,
    );
    if (mode !== undefined) await handle.chmod(mode);
    await fsp.writeFile(handle, content, { encoding: "utf8", signal });
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
    await fsp.rename(temp, target);
  } finally {
    await handle?.close().catch(() => {});
    await fsp.unlink(temp).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    });
  }
}

export async function validateSearchDirectory(
  target: string,
  rel: string,
  signal?: AbortSignal,
): Promise<ToolResult | undefined> {
  if (signal?.aborted) return fail("Search aborted.");
  try {
    const stat = await fsp.stat(target);
    if (!stat.isDirectory()) return fail(`${rel} is not a directory.`);
  } catch {
    return fail(`No such directory: ${rel}`);
  }
  return undefined;
}

/** Stream a bounded line slice without loading an arbitrarily large file. */
export async function readFileSlice(
  target: string,
  offset: number,
  limit: number,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (signal?.aborted) return fail("Read aborted.");
  const endLine = Math.min(Number.MAX_SAFE_INTEGER, offset + limit - 1);
  const pieces: string[] = [];
  let bytes = 0;
  let line = 1;
  const stream = fs.createReadStream(target, { encoding: "utf8", signal });

  const appendPiece = (piece: string): boolean => {
    const pieceBytes = Buffer.byteLength(piece, "utf8");
    if (bytes + pieceBytes > MAX_FILE_BYTES) return false;
    pieces.push(piece);
    bytes += pieceBytes;
    return true;
  };

  try {
    for await (const rawChunk of stream) {
      const chunk = String(rawChunk);
      let start = 0;
      while (start < chunk.length) {
        if (signal?.aborted) return fail("Read aborted.");
        const newline = chunk.indexOf("\n", start);
        const hasNewline = newline >= 0;
        const end = hasNewline ? newline : chunk.length;
        if (line >= offset && line <= endLine) {
          const piece = chunk.slice(start, end) + (hasNewline && line < endLine ? "\n" : "");
          if (!appendPiece(piece)) {
            return fail(
              `Selected slice exceeds ${MAX_FILE_BYTES} bytes. Reduce the requested line limit.`,
            );
          }
        }
        if (!hasNewline) break;
        if (line >= endLine) return ok(pieces.join(""));
        line += 1;
        start = newline + 1;
      }
    }
    return ok(pieces.join(""));
  } catch (err) {
    if (signal?.aborted || (err as { name?: string }).name === "AbortError") {
      return fail("Read aborted.");
    }
    return fail(`Could not read file slice: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    stream.destroy();
  }
}

/**
 * Depth-first walk of `dir`, invoking `visit(relPath, absPath)` for each file.
 * The visitor returns `false` (or a Promise of it) to stop the walk early.
 */
export async function walk(
  dir: string,
  root: string,
  visit: (relPath: string, absPath: string) => boolean | Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (signal?.aborted) return false;
    const absolute = path.join(dir, entry.name);
    const relative = path.relative(root, absolute);
    if (isProtectedWorkspaceRelativePath(relative)) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const keepGoing = await walk(absolute, root, visit, signal);
      if (!keepGoing) return false;
    } else if (entry.isFile()) {
      const keepGoing = await visit(relative, absolute);
      if (!keepGoing) return false;
    }
  }
  return true;
}
