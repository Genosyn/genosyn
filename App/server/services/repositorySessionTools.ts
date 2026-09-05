import fs from "node:fs";
import path from "node:path";
import type { Repository } from "../db/entities/Repository.js";
import { globToRegExp, RegexLineMatcher } from "./agent/tools/codingSearch.js";
import {
  MAX_EDITABLE_FILE_BYTES,
  isBinary,
  normalizeRepositoryPath,
  parseStatus,
  resolveInCheckout,
  runRepositoryGit,
  summarizeDiff,
  writeFileInCheckout,
} from "./repositoryWorkspace.js";

/**
 * The tools an AI Employee works a Repository with, at the quality of the
 * coding harnesses people already use.
 *
 * `repositoryWorkSessions.ts` owns the session — its worktree, its branch,
 * its turns. This module owns what a turn can *do* to the files in it, and it
 * exists because the original five verbs (list one level, read a whole file,
 * write a whole file, delete, substring-search) were the reason an employee's
 * work came back worse than the same model's work in Claude Code or Codex:
 *
 *   - Rewriting a whole file to change three lines is how content gets lost,
 *     how "// … rest unchanged" ends up committed, and how a 2,000-line file
 *     costs 2,000 lines of output tokens per edit. Every serious harness edits
 *     by exact replacement; {@link sessionEditFile} does the same.
 *   - A file returned without line numbers cannot be reasoned about in
 *     ranges, and a file that cannot be sliced cannot be read at all past a
 *     size cap. {@link sessionReadNumbered} numbers lines and takes a window.
 *   - "Where is this used?" needs a regular expression, a path or glob
 *     filter, and context lines — {@link sessionGrep} — and "which files are
 *     there of this kind?" needs a glob — {@link sessionGlob}. Both honour
 *     `.gitignore`, so `node_modules` never floods a result.
 *   - An employee that cannot see `git status` or its own diff commits blind.
 *     {@link sessionStatus} and {@link sessionDiff} show it what it is about
 *     to record, the way `git status` and `git diff` do in a terminal.
 *
 * Every path still goes through {@link normalizeRepositoryPath} and
 * {@link resolveInCheckout}, every write through {@link writeFileInCheckout},
 * and nothing here needs command execution: the git calls are server-owned
 * plumbing over an App-owned worktree, exactly as `repository_commit` always
 * was. A session on an install with the sandbox off keeps all of this.
 */

/** The largest file a read may open, whole or sliced. */
export const MAX_SESSION_READ_BYTES = 8 * 1024 * 1024;

/** Lines returned by a read that names no `limit`. Claude Code's default. */
export const DEFAULT_READ_LINES = 2000;

/**
 * Characters one read result may carry. Below the loop's own clip on tool
 * results, so the trailer that says where the read stopped is never itself
 * cut off — a model that is told "continue with offset=1201" can, and one
 * handed `[truncated 40000 chars]` cannot.
 */
export const MAX_READ_OUTPUT_CHARS = 48_000;

/** Matches one search returns before it stops. */
export const MAX_GREP_MATCHES = 200;

/** Files a glob returns before it stops. */
export const MAX_GLOB_RESULTS = 500;

/** Lines a tree listing returns before it stops. */
export const MAX_TREE_LINES = 600;

/** Deepest a tree listing may go. */
export const MAX_TREE_DEPTH = 4;

/** Files larger than this are skipped by search rather than read. */
const MAX_GREP_FILE_BYTES = 1024 * 1024;

/** Characters a diff result may carry before it is cut. */
export const MAX_SESSION_DIFF_CHARS = 100_000;

/** Context lines a search may ask for on each side of a match. */
export const MAX_GREP_CONTEXT = 5;

// ───────────────────────────── reading ──────────────────────────────────

export type NumberedRead = {
  path: string;
  /** The numbered text, ready for the model. */
  text: string;
  totalLines: number;
  from: number;
  to: number;
  /** True when lines after `to` exist and were not returned. */
  truncated: boolean;
};

/**
 * Read a window of a file with `cat -n` style line numbers.
 *
 * Line numbers are what let a model talk about a file in ranges, ask for the
 * next window, and copy an exact span into an edit. A read that names no
 * window returns the first {@link DEFAULT_READ_LINES}; a read that would
 * exceed {@link MAX_READ_OUTPUT_CHARS} stops early and says where, so the
 * next call can continue from there rather than re-reading the start.
 */
export function sessionReadNumbered(
  directory: string,
  filePath: string,
  window: { offset?: number; limit?: number } = {},
): NumberedRead {
  const normalized = normalizeRepositoryPath(filePath);
  const absolute = resolveInCheckout(directory, normalized);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No such file: ${normalized}`);
    }
    throw error;
  }
  if (stat.isDirectory()) {
    throw new Error(`${normalized} is a directory — use repository_list_files.`);
  }
  if (!stat.isFile()) throw new Error("That path is not a regular file.");
  if (stat.size > MAX_SESSION_READ_BYTES) {
    throw new Error(
      `${normalized} is ${formatBytes(stat.size)}, which is too large to open here. Search it with repository_search instead.`,
    );
  }
  const buffer = fs.readFileSync(absolute);
  if (isBinary(buffer)) throw new Error(`${normalized} is binary and cannot be read as text.`);
  const lines = splitLines(buffer.toString("utf8"));
  const totalLines = lines.length;
  const from = Math.max(1, Math.floor(window.offset ?? 1));
  const limit = Math.max(1, Math.floor(window.limit ?? DEFAULT_READ_LINES));

  if (totalLines === 0) {
    return { path: normalized, text: "(empty file)", totalLines: 0, from, to: 0, truncated: false };
  }
  if (from > totalLines) {
    return {
      path: normalized,
      text: `(${normalized} has ${totalLines} lines; offset ${from} is past the end)`,
      totalLines,
      from,
      to: totalLines,
      truncated: false,
    };
  }

  const width = Math.max(4, String(Math.min(totalLines, from + limit - 1)).length);
  const out: string[] = [];
  let chars = 0;
  let to = from - 1;
  for (let index = from - 1; index < Math.min(totalLines, from - 1 + limit); index += 1) {
    const rendered = `${String(index + 1).padStart(width)}\t${lines[index]}`;
    if (chars + rendered.length + 1 > MAX_READ_OUTPUT_CHARS && out.length > 0) break;
    out.push(rendered);
    chars += rendered.length + 1;
    to = index + 1;
  }
  const truncated = to < totalLines;
  const trailer = truncated
    ? `\n\n[Lines ${from}–${to} of ${totalLines}. Call again with offset=${to + 1} to continue.]`
    : from > 1
      ? `\n\n[Lines ${from}–${to} of ${totalLines}.]`
      : "";
  return { path: normalized, text: out.join("\n") + trailer, totalLines, from, to, truncated };
}

/** Split text into lines, not counting a trailing newline as an extra empty line. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ───────────────────────────── editing ──────────────────────────────────

export type SessionEditResult = {
  path: string;
  replacements: number;
  /** 1-based line where the first replacement now starts. */
  line: number;
  /** The edited region, numbered, so the model can confirm it landed. */
  snippet: string;
};

/**
 * Replace an exact string in a file.
 *
 * `oldString` must occur exactly once unless `replaceAll` is set — the same
 * contract as Claude Code's Edit tool and the chat-mode `edit_file`, and the
 * one that makes an edit safe to apply without a human watching: an
 * ambiguous match is refused with a count, not applied to the first hit.
 *
 * The returned snippet is the region after the edit with line numbers, which
 * is what lets the model verify its own change without a second read.
 */
export function sessionEditFile(
  directory: string,
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): SessionEditResult {
  if (!oldString) throw new Error("old_string must not be empty.");
  if (oldString === newString) {
    throw new Error("old_string and new_string are identical, so there is nothing to change.");
  }
  const normalized = normalizeRepositoryPath(filePath);
  const absolute = resolveInCheckout(directory, normalized);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No such file: ${normalized}. To create a file, use repository_write_file.`,
      );
    }
    throw error;
  }
  if (!stat.isFile()) throw new Error("That path is not a regular file.");
  if (stat.size > MAX_EDITABLE_FILE_BYTES) {
    throw new Error(
      `${normalized} is ${formatBytes(stat.size)}, which is too large to edit in place.`,
    );
  }
  const buffer = fs.readFileSync(absolute);
  if (isBinary(buffer)) throw new Error(`${normalized} is binary and cannot be edited as text.`);
  const text = buffer.toString("utf8");
  const count = text.split(oldString).length - 1;
  if (count === 0) {
    throw new Error(
      `old_string was not found in ${normalized}. Read the file again and copy the text exactly, including whitespace and indentation.`,
    );
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string appears ${count} times in ${normalized}. Include more of the surrounding lines so it matches exactly once, or set replace_all to change every occurrence.`,
    );
  }
  // split/join rather than String.replace: it never interprets `$&`-style
  // patterns in the replacement, and in the single case count is 1 anyway.
  const updated = text.split(oldString).join(newString);
  if (Buffer.byteLength(updated) > MAX_EDITABLE_FILE_BYTES) {
    throw new Error(`The edit would make ${normalized} too large to keep editing.`);
  }
  writeFileInCheckout(absolute, updated);

  const line = text.slice(0, text.indexOf(oldString)).split("\n").length;
  const replacedLines = newString.split("\n").length;
  const lines = splitLines(updated);
  const start = Math.max(1, line - 3);
  const end = Math.min(lines.length, line + replacedLines + 2);
  const width = Math.max(4, String(end).length);
  const snippet = lines
    .slice(start - 1, end)
    .map((content, index) => `${String(start + index).padStart(width)}\t${content}`)
    .join("\n");
  return { path: normalized, replacements: replaceAll ? count : 1, line, snippet };
}

// ─────────────────────── enumerating the tree ───────────────────────────

/**
 * Every file in the worktree that is not ignored, as repository-relative
 * POSIX paths: tracked files plus untracked ones `.gitignore` does not cover.
 *
 * This is one `git ls-files` rather than a walk with an ignore matcher
 * because git already knows the answer exactly — nested `.gitignore`s,
 * negations, the global excludes file — and re-implementing that is how a
 * search ends up reading `node_modules` after all. The git call is
 * server-owned plumbing over an App-owned tree, the same class of call
 * `repository_commit` makes, so it is available wherever a session is.
 *
 * Entries the index still lists but the tree no longer has (a file the
 * employee deleted) are dropped, as are symlinks: a search that followed one
 * out of the worktree would be the hole the read path closes.
 */
export async function sessionVisibleFiles(repo: Repository, directory: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await runRepositoryGit(repo, directory, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
  } catch {
    return walkFallback(directory);
  }
  const seen = new Set<string>();
  const files: string[] = [];
  for (const entry of raw.split("\0")) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(directory, entry));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push(entry);
  }
  return files.sort();
}

/** A plain walk for the case git could not answer — no ignore rules, `.git` skipped. */
function walkFallback(directory: string): string[] {
  const out: string[] = [];
  const walk = (relative: string): void => {
    const absolute = relative ? path.join(directory, relative) : directory;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (!relative && entry.name === ".git") continue;
      if (entry.name === "node_modules") continue;
      const entryPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile()) out.push(entryPath);
    }
  };
  walk("");
  return out.sort();
}

// ─────────────────────────────── glob ───────────────────────────────────

export type SessionGlobResult = { matches: string[]; truncated: boolean };

/**
 * Files matching a glob, relative to `subPath` (or the root).
 *
 * `**` crosses directories, `*` and `?` do not. A pattern with no slash
 * matches basenames anywhere below the search path, which is what "find the
 * test files" means when somebody types `*.test.ts`.
 */
export async function sessionGlob(
  repo: Repository,
  directory: string,
  pattern: string,
  subPath = "",
): Promise<SessionGlobResult> {
  const trimmed = pattern.trim();
  if (!trimmed) throw new Error("A glob pattern is required.");
  const base = normalizeRepositoryPath(subPath, { allowRoot: true });
  // Resolving validates containment even though the listing comes from git.
  resolveInCheckout(directory, base);
  const files = (await sessionVisibleFiles(repo, directory)).filter((file) =>
    base ? file === base || file.startsWith(`${base}/`) : true,
  );
  const regex = globToRegExp(trimmed);
  const basenameOnly = !trimmed.includes("/");
  const matches: string[] = [];
  for (const file of files) {
    const relative = base ? file.slice(base.length + 1) : file;
    const candidate = basenameOnly ? path.posix.basename(relative) : relative;
    if (regex.test(candidate) || (!basenameOnly && regex.test(file))) matches.push(file);
    if (matches.length > MAX_GLOB_RESULTS) break;
  }
  const truncated = matches.length > MAX_GLOB_RESULTS;
  return { matches: matches.slice(0, MAX_GLOB_RESULTS), truncated };
}

// ─────────────────────────────── grep ───────────────────────────────────

export type SessionGrepOptions = {
  pattern: string;
  /** A directory to search within, or a single file. Empty for the root. */
  path?: string;
  /** A glob that filenames (or paths) must match. */
  glob?: string;
  ignoreCase?: boolean;
  /** Lines of context on each side of a match, in `content` mode. */
  context?: number;
  outputMode?: "content" | "files" | "count";
};

export type SessionGrepResult = {
  /** Formatted for the model. */
  text: string;
  matches: number;
  files: number;
  truncated: boolean;
};

/**
 * Regular-expression search over the worktree's visible text files.
 *
 * The output modes are ripgrep's, and for ripgrep's reasons: `content` is the
 * answer to "show me", `files` to "which files mention this", and `count` to
 * "how widespread is it". The regex runs in a worker thread with a per-file
 * time limit ({@link RegexLineMatcher}), so a catastrophic pattern from the
 * model costs it one failed call rather than the App its event loop.
 */
export async function sessionGrep(
  repo: Repository,
  directory: string,
  options: SessionGrepOptions,
): Promise<SessionGrepResult> {
  const pattern = options.pattern;
  if (!pattern.trim()) throw new Error("Enter something to search for.");
  const flags = options.ignoreCase ? "i" : "";
  try {
    new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(
      `Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const mode = options.outputMode ?? "content";
  const context = Math.min(
    MAX_GREP_CONTEXT,
    Math.max(0, Math.floor(options.context ?? 0)),
  );
  const scope = normalizeRepositoryPath(options.path ?? "", { allowRoot: true });
  const scopeAbsolute = resolveInCheckout(directory, scope);
  let scopeIsFile = false;
  if (scope) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(scopeAbsolute);
    } catch {
      throw new Error(`No such path: ${scope}`);
    }
    scopeIsFile = stat.isFile();
    if (!scopeIsFile && !stat.isDirectory()) throw new Error(`${scope} is not a file or folder.`);
  }
  const fileRegex = options.glob?.trim() ? globToRegExp(options.glob.trim()) : null;
  const candidates = scopeIsFile
    ? [scope]
    : (await sessionVisibleFiles(repo, directory)).filter((file) =>
        scope ? file.startsWith(`${scope}/`) : true,
      );

  const matcher = new RegexLineMatcher(pattern, flags);
  const lines: string[] = [];
  const perFile: Array<{ file: string; count: number }> = [];
  let total = 0;
  let truncated = false;
  try {
    for (const file of candidates) {
      if (
        fileRegex &&
        !fileRegex.test(path.posix.basename(file)) &&
        !fileRegex.test(file)
      ) {
        continue;
      }
      const absolute = path.join(directory, file);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_GREP_FILE_BYTES) continue;
      const buffer = fs.readFileSync(absolute);
      if (isBinary(buffer)) continue;
      const text = buffer.toString("utf8");
      const scanned = await matcher.match(text, MAX_GREP_MATCHES + 1 - total);
      if ("error" in scanned) throw new Error(scanned.error);
      if (scanned.matches.length === 0) continue;
      const kept = scanned.matches.slice(0, Math.max(0, MAX_GREP_MATCHES - total));
      if (scanned.matches.length > kept.length) truncated = true;
      total += kept.length;
      perFile.push({ file, count: kept.length });
      if (mode === "content" && kept.length > 0) {
        if (lines.length > 0) lines.push("--");
        lines.push(...renderMatches(file, splitLines(text), kept, context));
      }
      if (total >= MAX_GREP_MATCHES) {
        truncated = true;
        break;
      }
    }
  } finally {
    await matcher.close();
  }

  let text: string;
  if (total === 0) {
    text = "(no matches)";
  } else if (mode === "files") {
    text = perFile.map((entry) => entry.file).join("\n");
  } else if (mode === "count") {
    text = perFile.map((entry) => `${entry.file}: ${entry.count}`).join("\n");
  } else {
    text = lines.join("\n");
  }
  if (truncated) {
    text += `\n\n[Stopped after ${MAX_GREP_MATCHES} matches. Narrow the search with path, glob, or a more specific pattern.]`;
  }
  return { text, matches: total, files: perFile.length, truncated };
}

/** ripgrep-style `path:line:text` for matches and `path-line-text` for context. */
function renderMatches(
  file: string,
  lines: string[],
  matches: Array<[number, string]>,
  context: number,
): string[] {
  const out: string[] = [];
  const matched = new Set(matches.map(([index]) => index));
  let lastPrinted = -1;
  for (const [index] of matches) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    if (context > 0 && lastPrinted >= 0 && start > lastPrinted + 1) out.push("--");
    for (let i = Math.max(start, lastPrinted + 1); i <= end; i += 1) {
      const sep = matched.has(i) ? ":" : "-";
      out.push(`${file}${sep}${i + 1}${sep}${clipLine(lines[i] ?? "")}`);
      lastPrinted = i;
    }
  }
  return out;
}

function clipLine(line: string): string {
  return line.length > 400 ? `${line.slice(0, 400)}…` : line;
}

// ─────────────────────────── listing a tree ─────────────────────────────

export type SessionTreeResult = { text: string; entries: number; truncated: boolean };

/**
 * An indented listing of a directory, `depth` levels deep.
 *
 * Ignored entries are shown at the top level and marked, but never descended
 * into or shown further down: an employee asked to change a generated file
 * should still be able to see that `dist/` exists, and nobody should ever be
 * shown the inside of `node_modules` by accident. A directory is "ignored"
 * when nothing visible lives under it, which is what git's rules amount to
 * from the outside.
 */
export async function sessionTree(
  repo: Repository,
  directory: string,
  subPath = "",
  depth = 1,
): Promise<SessionTreeResult> {
  const base = normalizeRepositoryPath(subPath, { allowRoot: true });
  const absolute = resolveInCheckout(directory, base);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(absolute);
  } catch {
    throw new Error(`No such folder: ${base || "/"}`);
  }
  if (rootStat.isFile()) throw new Error(`${base} is a file — read it with repository_read_file.`);
  if (!rootStat.isDirectory()) throw new Error(`${base} is not a folder.`);
  const maxDepth = Math.min(MAX_TREE_DEPTH, Math.max(1, Math.floor(depth)));
  const visible = new Set(await sessionVisibleFiles(repo, directory));
  const visibleDirs = new Set<string>();
  for (const file of visible) {
    let parent = path.posix.dirname(file);
    while (parent && parent !== ".") {
      if (visibleDirs.has(parent)) break;
      visibleDirs.add(parent);
      parent = path.posix.dirname(parent);
    }
  }

  const lines: string[] = [];
  let entries = 0;
  let truncated = false;
  const walk = (relative: string, level: number): void => {
    if (truncated) return;
    const here = relative ? path.join(directory, relative) : directory;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      return;
    }
    const rows = dirents
      .filter((d) => !d.isSymbolicLink() && !(!relative && d.name === ".git"))
      .sort((a, b) =>
        a.isDirectory() === b.isDirectory()
          ? a.name.localeCompare(b.name)
          : a.isDirectory()
            ? -1
            : 1,
      );
    for (const dirent of rows) {
      if (lines.length >= MAX_TREE_LINES) {
        truncated = true;
        return;
      }
      const entryPath = relative ? `${relative}/${dirent.name}` : dirent.name;
      const indent = "  ".repeat(level);
      if (dirent.isDirectory()) {
        const ignored = !visibleDirs.has(entryPath) && !isEmptyDirectory(path.join(here, dirent.name));
        if (ignored && level > 0) continue;
        entries += 1;
        lines.push(`${indent}${dirent.name}/${ignored ? "  (ignored)" : ""}`);
        if (!ignored && level + 1 < maxDepth) walk(entryPath, level + 1);
      } else if (dirent.isFile()) {
        const ignored = !visible.has(entryPath);
        if (ignored && level > 0) continue;
        let size = 0;
        try {
          size = fs.statSync(path.join(here, dirent.name)).size;
        } catch {
          continue;
        }
        entries += 1;
        lines.push(`${indent}${dirent.name}  (${formatBytes(size)}${ignored ? ", ignored" : ""})`);
      }
    }
  };
  walk(base, 0);
  let text = lines.length > 0 ? lines.join("\n") : "(empty folder)";
  if (truncated) {
    text += `\n\n[Listing stopped at ${MAX_TREE_LINES} entries. List a subfolder, or use repository_glob for a specific kind of file.]`;
  }
  return { text, entries, truncated };
}

function isEmptyDirectory(absolute: string): boolean {
  try {
    return fs.readdirSync(absolute).length === 0;
  } catch {
    return false;
  }
}

// ───────────────────────── git status and diff ──────────────────────────

export type SessionStatusResult = {
  text: string;
  branch: string | null;
  commits: number;
  uncommitted: number;
};

/**
 * What `git status` and `git log base..HEAD` would say, in one report.
 *
 * The employee has no git inside its sandbox by design (see
 * `repositoryCommandRun.ts`), so this is how it learns what it has changed
 * and not yet committed, and what it has already recorded on its branch.
 */
export async function sessionStatus(
  repo: Repository,
  directory: string,
  baseCommit: string | null,
): Promise<SessionStatusResult> {
  const raw = await runRepositoryGit(repo, directory, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "-b",
  ]);
  const status = parseStatus(raw);
  const commitLines: string[] = [];
  if (baseCommit) {
    const log = await runRepositoryGit(repo, directory, [
      "log",
      "--format=%h %s",
      `${baseCommit}..HEAD`,
    ]).catch(() => "");
    for (const line of log.split("\n")) if (line.trim()) commitLines.push(line.trim());
  }
  const lines: string[] = [];
  lines.push(`Branch: ${status.branch ?? "(detached)"}`);
  if (baseCommit) lines.push(`Based on: ${baseCommit.slice(0, 7)}`);
  lines.push(`Commits on this branch so far: ${commitLines.length}`);
  for (const line of commitLines.slice(0, 50)) lines.push(`  ${line}`);
  if (commitLines.length > 50) lines.push(`  … and ${commitLines.length - 50} more`);
  const changes = status.changes;
  lines.push(`Uncommitted changes: ${changes.length}`);
  for (const change of changes.slice(0, 200)) {
    const code =
      change.status === "untracked"
        ? "??"
        : change.status === "added"
          ? "A "
          : change.status === "deleted"
            ? "D "
            : change.status === "renamed"
              ? "R "
              : change.status === "conflicted"
                ? "U "
                : "M ";
    const rename = change.fromPath ? `${change.fromPath} -> ` : "";
    lines.push(`  ${code} ${rename}${change.path}`);
  }
  if (changes.length > 200) lines.push(`  … and ${changes.length - 200} more`);
  if (changes.length === 0 && commitLines.length === 0) {
    lines.push("Nothing has been changed yet.");
  }
  return {
    text: lines.join("\n"),
    branch: status.branch,
    commits: commitLines.length,
    uncommitted: changes.length,
  };
}

export type SessionDiffResult = {
  text: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  truncated: boolean;
};

/**
 * The diff of the employee's own work, either what is not yet committed
 * (working tree against `HEAD`, untracked files rendered as additions) or,
 * with `committed`, everything the session branch has recorded since it was
 * cut from the trunk.
 */
export async function sessionDiff(
  repo: Repository,
  directory: string,
  options: { committed?: boolean; baseCommit?: string | null; path?: string } = {},
): Promise<SessionDiffResult> {
  const scoped = options.path?.trim() ? normalizeRepositoryPath(options.path) : null;
  if (scoped) resolveInCheckout(directory, scoped);
  let patch: string;
  if (options.committed) {
    if (!options.baseCommit) throw new Error("This session has no base commit to diff against.");
    const args = ["diff", "--no-color", "--unified=3", "--no-ext-diff", options.baseCommit, "HEAD"];
    if (scoped) args.push("--", scoped);
    patch = await runRepositoryGit(repo, directory, args);
  } else {
    const args = ["diff", "HEAD", "--no-color", "--unified=3", "--no-ext-diff"];
    if (scoped) args.push("--", scoped);
    patch = await runRepositoryGit(repo, directory, args).catch(() => "");
    const raw = await runRepositoryGit(repo, directory, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    for (const change of parseStatus(raw).changes) {
      if (change.status !== "untracked") continue;
      if (scoped && change.path !== scoped && !change.path.startsWith(`${scoped}/`)) continue;
      patch += renderUntrackedAsAddition(directory, change.path);
      if (patch.length > MAX_SESSION_DIFF_CHARS * 2) break;
    }
  }
  const summary = summarizeDiff(patch);
  let text = patch;
  let truncated = false;
  if (text.length > MAX_SESSION_DIFF_CHARS) {
    text = `${text.slice(0, MAX_SESSION_DIFF_CHARS)}\n\n[Diff truncated. Ask for one path at a time with the path argument.]`;
    truncated = true;
  }
  if (!patch.trim()) {
    text = options.committed
      ? "(no committed changes on this branch yet)"
      : "(no uncommitted changes)";
  }
  return {
    text,
    filesChanged: summary.filesChanged,
    insertions: summary.insertions,
    deletions: summary.deletions,
    truncated,
  };
}

/** A whole new file as one added hunk, the way the Member diff renders it. */
function renderUntrackedAsAddition(directory: string, relativePath: string): string {
  let buffer: Buffer;
  try {
    const absolute = resolveInCheckout(directory, relativePath);
    if (!fs.lstatSync(absolute).isFile()) return "";
    buffer = fs.readFileSync(absolute);
  } catch {
    return "";
  }
  const header = `diff --git a/${relativePath} b/${relativePath}\nnew file mode 100644\n`;
  if (isBinary(buffer)) return `${header}Binary file ${relativePath} added\n`;
  if (buffer.length > MAX_EDITABLE_FILE_BYTES) return `${header}File is too large to display\n`;
  const lines = splitLines(buffer.toString("utf8"));
  if (lines.length === 0) return `${header}--- /dev/null\n+++ b/${relativePath}\n`;
  const endsWithNewline = buffer.toString("utf8").endsWith("\n");
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewline = endsWithNewline ? "" : "\n\\ No newline at end of file";
  return (
    `${header}--- /dev/null\n+++ b/${relativePath}\n` +
    `@@ -0,0 +1,${lines.length} @@\n${body}${noNewline}\n`
  );
}

// ─────────────────────────────── steps ──────────────────────────────────

export type SessionStepStatus = "pending" | "in_progress" | "completed";

export type SessionStep = { text: string; status: SessionStepStatus };

export const MAX_SESSION_STEPS = 30;

/** Validate and normalize a step list the model sent. */
export function normalizeSessionSteps(input: unknown): SessionStep[] {
  if (!Array.isArray(input)) throw new Error("steps must be an array.");
  if (input.length > MAX_SESSION_STEPS) {
    throw new Error(`Keep the list to ${MAX_SESSION_STEPS} steps or fewer.`);
  }
  const steps: SessionStep[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw new Error("Each step must be an object.");
    const { text, status } = raw as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || !text.trim()) throw new Error("Each step needs text.");
    if (status !== "pending" && status !== "in_progress" && status !== "completed") {
      throw new Error("Each step's status must be pending, in_progress, or completed.");
    }
    steps.push({ text: text.trim().slice(0, 200), status });
  }
  const inProgress = steps.filter((step) => step.status === "in_progress").length;
  if (inProgress > 1) {
    throw new Error("Only one step can be in_progress at a time.");
  }
  return steps;
}

// ─────────────────────────────── misc ───────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
