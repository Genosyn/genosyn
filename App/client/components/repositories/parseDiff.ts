/**
 * Turn a raw unified diff into something React can render.
 *
 * The repository API hands back the patch exactly as `git diff` / `git show`
 * printed it, because that is the one representation every git host agrees on
 * and re-encoding it server-side would only lose information. Parsing it here
 * keeps the transport dumb and makes the interesting part — line numbers,
 * per-file stats, rename detection — a pure function with no React, no fetch,
 * and no DOM, so it can be exercised directly in a unit test.
 *
 * The parser is deliberately forgiving. `RepositoryDiff.patch` is capped at a
 * byte budget on the server, so a large diff arrives cut off mid-hunk or even
 * mid-line; a parser that threw on that would turn "your diff was long" into
 * "your diff is broken".
 */

export type DiffLineType = "context" | "add" | "remove" | "meta";

export type DiffLine = {
  type: DiffLineType;
  /** Line number on the pre-image side, or null for an added / meta line. */
  oldNumber: number | null;
  /** Line number on the post-image side, or null for a removed / meta line. */
  newNumber: number | null;
  /** Content with the leading `+` / `-` / space marker removed. */
  content: string;
};

export type DiffHunk = {
  /** The raw `@@ … @@` line, kept so the header renders verbatim. */
  header: string;
  /** The function / section name git appends after the closing `@@`. */
  heading: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};

export type DiffFileStatus = "added" | "deleted" | "renamed" | "modified";

export type DiffFile = {
  /** Path on the pre-image side; null for a newly added file. */
  oldPath: string | null;
  /** Path on the post-image side; null for a deleted file. */
  newPath: string | null;
  /** The path to show in the header — the post-image one where there is one. */
  path: string;
  status: DiffFileStatus;
  /** True for `Binary files … differ` and for `GIT binary patch` blocks. */
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
};

const GIT_HEADER = "diff --git ";

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?: ?(.*))?$/;

/**
 * Undo git's C-style quoting of paths that contain a space, a quote, or a
 * non-ASCII byte. Without this a file named `sp ace.txt` shows up in the
 * header with its escapes still visible.
 */
function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const body = value.slice(1, -1);
  return body.replace(/\\(.)/g, (_match, char: string) => {
    if (char === "n") return "\n";
    if (char === "t") return "\t";
    return char;
  });
}

/** Drop the `a/` / `b/` prefix git puts in front of both sides of a header. */
function stripSidePrefix(value: string): string {
  const path = unquotePath(value.trim());
  if (path === "/dev/null") return "";
  return path.replace(/^[ab]\//, "");
}

/**
 * Split the two paths out of `diff --git a/x b/y`.
 *
 * Both halves are unseparated by anything a filename cannot itself contain,
 * so there is no fully correct split for unquoted paths. The overwhelmingly
 * common case — both sides naming the same file — is matched exactly first;
 * everything else falls back to the first ` b/`, which only misfires on a
 * filename that literally contains that sequence.
 */
function parseGitHeaderPaths(rest: string): [string, string] {
  const same = rest.match(/^a\/(.+) b\/\1$/);
  if (same) return [same[1], same[1]];
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) return [stripSidePrefix(quoted[1]), stripSidePrefix(quoted[2])];
  const split = rest.indexOf(" b/");
  if (split > 0) {
    return [stripSidePrefix(rest.slice(0, split)), stripSidePrefix(rest.slice(split + 1))];
  }
  return ["", ""];
}

function blankFile(): DiffFile {
  return {
    oldPath: null,
    newPath: null,
    path: "",
    status: "modified",
    binary: false,
    hunks: [],
    additions: 0,
    deletions: 0,
  };
}

/** Header lines that carry no content and must not be read as diff body. */
function isExtendedHeader(line: string): boolean {
  return (
    line.startsWith("index ") ||
    line.startsWith("old mode ") ||
    line.startsWith("new mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("dissimilarity index ") ||
    line.startsWith("copy from ") ||
    line.startsWith("copy to ")
  );
}

export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  if (!patch) return files;

  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldCursor = 0;
  let newCursor = 0;

  /** A patch without `diff --git` headers still has to land somewhere. */
  function ensureFile(): DiffFile {
    if (file) return file;
    file = blankFile();
    files.push(file);
    return file;
  }

  function finishPaths(target: DiffFile) {
    target.path = target.newPath || target.oldPath || "";
    if (target.oldPath === null && target.newPath !== null) target.status = "added";
    else if (target.newPath === null && target.oldPath !== null) target.status = "deleted";
    else if (target.oldPath && target.newPath && target.oldPath !== target.newPath) {
      target.status = "renamed";
    }
  }

  // A patch ends with a newline, and splitting on it would otherwise append a
  // phantom empty context line to the last hunk.
  const body = patch.endsWith("\n") ? patch.slice(0, -1) : patch;

  for (const line of body.split("\n")) {
    if (line.startsWith(GIT_HEADER)) {
      const [oldPath, newPath] = parseGitHeaderPaths(line.slice(GIT_HEADER.length));
      file = blankFile();
      file.oldPath = oldPath || null;
      file.newPath = newPath || null;
      file.path = newPath || oldPath;
      files.push(file);
      hunk = null;
      continue;
    }

    if (hunk === null) {
      // Between files: everything here is header material.
      if (line.startsWith("new file mode")) {
        const target = ensureFile();
        target.status = "added";
        target.oldPath = null;
        continue;
      }
      if (line.startsWith("deleted file mode")) {
        const target = ensureFile();
        target.status = "deleted";
        target.newPath = null;
        continue;
      }
      if (line.startsWith("rename from ")) {
        const target = ensureFile();
        target.status = "renamed";
        target.oldPath = unquotePath(line.slice("rename from ".length));
        continue;
      }
      if (line.startsWith("rename to ")) {
        const target = ensureFile();
        target.status = "renamed";
        target.newPath = unquotePath(line.slice("rename to ".length));
        target.path = target.newPath;
        continue;
      }
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        ensureFile().binary = true;
        continue;
      }
      if (line.startsWith("--- ")) {
        const target = ensureFile();
        const path = stripSidePrefix(line.slice(4));
        target.oldPath = path || null;
        continue;
      }
      if (line.startsWith("+++ ")) {
        const target = ensureFile();
        const path = stripSidePrefix(line.slice(4));
        target.newPath = path || null;
        finishPaths(target);
        continue;
      }
      if (isExtendedHeader(line)) continue;
    }

    const hunkHeader = line.match(HUNK_HEADER);
    if (hunkHeader) {
      const target = ensureFile();
      oldCursor = Number(hunkHeader[1]);
      newCursor = Number(hunkHeader[2]);
      hunk = {
        header: line,
        heading: hunkHeader[3] ?? "",
        oldStart: oldCursor,
        newStart: newCursor,
        lines: [],
      };
      target.hunks.push(hunk);
      continue;
    }

    if (!hunk || !file) continue;

    if (line.startsWith("+")) {
      hunk.lines.push({
        type: "add",
        oldNumber: null,
        newNumber: newCursor,
        content: line.slice(1),
      });
      newCursor += 1;
      file.additions += 1;
    } else if (line.startsWith("-")) {
      hunk.lines.push({
        type: "remove",
        oldNumber: oldCursor,
        newNumber: null,
        content: line.slice(1),
      });
      oldCursor += 1;
      file.deletions += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — real information, but not a line of
      // either side, so it must not advance either cursor.
      hunk.lines.push({ type: "meta", oldNumber: null, newNumber: null, content: line.slice(2) });
    } else if (line.startsWith(" ") || line === "") {
      // A trailing empty string comes from the patch's final newline; a truly
      // empty context line is " " and only looks empty after the marker.
      hunk.lines.push({
        type: "context",
        oldNumber: oldCursor,
        newNumber: newCursor,
        content: line.slice(1),
      });
      oldCursor += 1;
      newCursor += 1;
    } else {
      // Anything else means the hunk ended without a new header — a truncated
      // patch, or trailing prose. Stop treating following lines as body.
      hunk = null;
    }
  }

  // A rename with no content change never reaches a `+++` line, so paths are
  // resolved once more at the end for every file that skipped `finishPaths`.
  for (const entry of files) {
    if (!entry.path) finishPaths(entry);
  }

  return files;
}

/** Header stats, for callers that only want the summary line. */
export function diffTotals(files: DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (totals, entry) => ({
      additions: totals.additions + entry.additions,
      deletions: totals.deletions + entry.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}
