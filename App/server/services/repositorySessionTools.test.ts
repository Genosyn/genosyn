import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { Repository } from "../db/entities/Repository.js";
import {
  DEFAULT_READ_LINES,
  MAX_GLOB_RESULTS,
  MAX_GREP_MATCHES,
  MAX_READ_OUTPUT_CHARS,
  MAX_SESSION_DIFF_CHARS,
  MAX_TREE_LINES,
  formatBytes,
  normalizeSessionSteps,
  sessionDiff,
  sessionEditFile,
  sessionGlob,
  sessionGrep,
  sessionReadNumbered,
  sessionStatus,
  sessionTree,
  sessionVisibleFiles,
} from "./repositorySessionTools.js";
import {
  createSessionWorktree,
  removeSessionWorktree,
  sessionBranchName,
  sessionCommit,
} from "./repositoryWorkSessions.js";
import {
  commitRepositoryChanges,
  ensureRepositoryWorkspace,
  runRepositoryGit,
  syncDefaultBranch,
  writeRepositoryFile,
} from "./repositoryWorkspace.js";

/**
 * The session tools against a real git repository.
 *
 * Nothing here needs the database: a `local` Repository is initialised on disk
 * by `ensureRepositoryWorkspace`, seeded with a few committed files and a
 * `.gitignore`, and every test cuts its own session worktree from that trunk —
 * exactly what a running turn is handed — so what the tools see is what git
 * says, not what a mocked listing was told to say.
 */

let dataDir: string;
const originalDataDir = config.dataDir;
const codingTools = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const originalCodingTools = { ...codingTools };

const repository = Object.assign(new Repository(), {
  id: randomUUID(),
  companyId: `co_${randomUUID()}`,
  name: "Fixture",
  slug: "fixture",
  description: "",
  origin: "local",
  kind: "code",
  gitUrl: "",
  defaultBranch: "main",
  authMode: "none",
  committerName: "Genosyn",
  committerEmail: "repositories@genosyn.local",
  lastSyncStatus: "unknown",
  lastSyncError: "",
} satisfies Partial<Repository>);

const APP_TS = [
  'import { helper } from "./util";',
  "",
  "export function main(): void {",
  "  const total = helper(1, 2);",
  '  console.log("Total:", total);',
  "}",
  "",
  "// TODO: remove the debug log",
  "",
].join("\n");
const UTIL_TS = "export function helper(a: number, b: number): number {\n  return a + b;\n}\n";
const GUIDE_MD = "# Guide\n\nCall `helper` from the app.\nTODO: write more.\n";
const GITIGNORE = "*.log\ndist/\nnode_modules/\n";

let baseCommit: string;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-session-tools-"));
  (config as { dataDir: string }).dataDir = dataDir;
  // The tools must work on an install with command execution switched off:
  // every git call they make is server-owned plumbing.
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.allowUnsafeHostExecution = false;

  await ensureRepositoryWorkspace(repository);
  await writeRepositoryFile(repository, ".gitignore", GITIGNORE);
  await writeRepositoryFile(repository, "src/app.ts", APP_TS);
  await writeRepositoryFile(repository, "src/util.ts", UTIL_TS);
  await writeRepositoryFile(repository, "docs/guide.md", GUIDE_MD);
  await commitRepositoryChanges(repository, { message: "Seed the fixture" });
  baseCommit = (await syncDefaultBranch(repository)).commit;
});

after(() => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  Object.assign(codingTools, originalCodingTools);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let directory: string;
let sessionId: string;
let branch: string;

beforeEach(async () => {
  sessionId = randomUUID();
  branch = sessionBranchName("ada", sessionId);
  directory = await createSessionWorktree(repository, sessionId, branch, baseCommit);
});

afterEach(async () => {
  await removeSessionWorktree(repository, sessionId);
});

function write(relative: string, content: string | Buffer): void {
  const absolute = path.join(directory, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function read(relative: string): string {
  return fs.readFileSync(path.join(directory, relative), "utf8");
}

function size(relative: string): string {
  return formatBytes(fs.statSync(path.join(directory, relative)).size);
}

function git(args: string[]): Promise<string> {
  return runRepositoryGit(repository, directory, args);
}

function seedMany(folder: string, count: number, extension = ".txt"): void {
  for (let index = 0; index < count; index += 1) {
    write(`${folder}/f${String(index).padStart(4, "0")}${extension}`, `${index}\n`);
  }
}

function numbered(from: number, to: number, label = "line"): string {
  return Array.from(
    { length: to - from + 1 },
    (_, i) => `${String(from + i).padStart(4)}\t${label} ${from + i}`,
  ).join("\n");
}

// ───────────────────────────── reading ──────────────────────────────────

describe("sessionReadNumbered", () => {
  test("numbers every line of a short file and adds no trailer", () => {
    write("notes.txt", "one\ntwo\nthree\n");
    const result = sessionReadNumbered(directory, "notes.txt");
    assert.equal(result.text, "   1\tone\n   2\ttwo\n   3\tthree");
    assert.deepEqual(
      [result.path, result.totalLines, result.from, result.to, result.truncated],
      ["notes.txt", 3, 1, 3, false],
    );
    // A missing final newline still counts the last line; a present one adds nothing.
    write("bare.txt", "a\nb");
    assert.equal(sessionReadNumbered(directory, "bare.txt").totalLines, 2);
  });

  test("returns the first 2000 lines by default and says how to continue", () => {
    write("long.txt", `${Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
    const result = sessionReadNumbered(directory, "long.txt");
    assert.equal(result.to, DEFAULT_READ_LINES);
    assert.equal(result.truncated, true);
    assert.ok(result.text.startsWith("   1\tline 1\n   2\tline 2\n"));
    const trailer = "\n\n[Lines 1–2000 of 2500. Call again with offset=2001 to continue.]";
    assert.ok(result.text.endsWith(`${numbered(1999, 2000)}${trailer}`));
  });

  test("honours offset and limit, numbering from the real line", () => {
    write("ten.txt", `${Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")}\n`);
    const middle = sessionReadNumbered(directory, "ten.txt", { offset: 4, limit: 3 });
    assert.equal(
      middle.text,
      `${numbered(4, 6)}\n\n[Lines 4–6 of 10. Call again with offset=7 to continue.]`,
    );
    assert.deepEqual([middle.from, middle.to, middle.truncated], [4, 6, true]);

    const tail = sessionReadNumbered(directory, "ten.txt", { offset: 8, limit: 50 });
    assert.equal(tail.text, `${numbered(8, 10)}\n\n[Lines 8–10 of 10.]`);
    assert.deepEqual([tail.from, tail.to, tail.truncated], [8, 10, false]);
  });

  test("says so for an empty file and for an offset past the end", () => {
    write("empty.txt", "");
    const empty = sessionReadNumbered(directory, "empty.txt");
    assert.equal(empty.text, "(empty file)");
    assert.deepEqual([empty.totalLines, empty.to, empty.truncated], [0, 0, false]);

    write("notes.txt", "one\ntwo\nthree\n");
    const past = sessionReadNumbered(directory, "notes.txt", { offset: 10 });
    assert.equal(past.text, "(notes.txt has 3 lines; offset 10 is past the end)");
    assert.deepEqual([past.from, past.to, past.truncated], [10, 3, false]);
  });

  test("refuses binaries, directories, missing files and paths outside the worktree", () => {
    write("blob.bin", Buffer.from([0x89, 0x50, 0x00, 0x01]));
    assert.throws(() => sessionReadNumbered(directory, "blob.bin"), /blob\.bin is binary/);
    assert.throws(
      () => sessionReadNumbered(directory, "src"),
      /src is a directory — use repository_list_files/,
    );
    assert.throws(() => sessionReadNumbered(directory, "nope.txt"), /No such file: nope\.txt/);
    for (const bad of ["../escape.txt", "src/../../escape.txt"]) {
      assert.throws(() => sessionReadNumbered(directory, bad), /relative segments/, bad);
    }
    assert.throws(() => sessionReadNumbered(directory, ".git/HEAD"), /\.git/);
    const outside = path.join(dataDir, "outside.txt");
    fs.writeFileSync(outside, "secret\n");
    fs.symlinkSync(outside, path.join(directory, "leak.txt"));
    assert.throws(() => sessionReadNumbered(directory, "leak.txt"), /escapes the repository/);
  });

  test("stops early when the window would exceed the output cap and says where to continue", () => {
    write("wide.txt", `${Array(100).fill("x".repeat(1000)).join("\n")}\n`);
    const result = sessionReadNumbered(directory, "wide.txt");
    assert.equal(result.truncated, true);
    assert.ok(result.to > 0 && result.to < 100, `stopped at ${result.to}`);
    const trailer = `\n\n[Lines 1–${result.to} of 100. Call again with offset=${result.to + 1} to continue.]`;
    assert.ok(result.text.endsWith(trailer));
    assert.ok(result.text.length - trailer.length <= MAX_READ_OUTPUT_CHARS);

    // One line that is alone over the cap is still returned, not turned into nothing.
    write("giant.txt", `${"y".repeat(MAX_READ_OUTPUT_CHARS + 10)}\n`);
    const giant = sessionReadNumbered(directory, "giant.txt");
    assert.deepEqual([giant.to, giant.truncated], [1, false]);
  });
});

// ───────────────────────────── editing ──────────────────────────────────

describe("sessionEditFile", () => {
  const twelve = `${Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join("\n")}\n`;

  test("replaces one exact occurrence and shows the numbered region around it", () => {
    write("list.txt", twelve);
    const result = sessionEditFile(directory, "list.txt", "l8", "L8");
    assert.equal(read("list.txt"), twelve.replace("l8", "L8"));
    assert.deepEqual([result.path, result.replacements, result.line], ["list.txt", 1, 8]);
    assert.equal(
      result.snippet,
      "   5\tl5\n   6\tl6\n   7\tl7\n   8\tL8\n   9\tl9\n  10\tl10\n  11\tl11",
    );
  });

  test("refuses text that is not there, and says to read again", () => {
    write("list.txt", twelve);
    assert.throws(
      () => sessionEditFile(directory, "list.txt", "l99", "x"),
      /old_string was not found in list\.txt\. Read the file again/,
    );
    assert.equal(read("list.txt"), twelve);
  });

  test("refuses an ambiguous match with the count, unless replace_all is set", () => {
    write("dup.txt", "foo bar foo\nfoo\n");
    assert.throws(
      () => sessionEditFile(directory, "dup.txt", "foo", "baz"),
      /old_string appears 3 times in dup\.txt\. Include more of the surrounding lines .* or set replace_all/,
    );
    assert.equal(read("dup.txt"), "foo bar foo\nfoo\n");
    const all = sessionEditFile(directory, "dup.txt", "foo", "baz", true);
    assert.equal(read("dup.txt"), "baz bar baz\nbaz\n");
    assert.deepEqual([all.replacements, all.line], [3, 1]);
  });

  test("refuses identical strings, an empty old_string, and paths outside the worktree", () => {
    write("list.txt", twelve);
    assert.throws(() => sessionEditFile(directory, "list.txt", "l1", "l1"), /identical/);
    assert.throws(() => sessionEditFile(directory, "list.txt", "", "x"), /must not be empty/);
    assert.equal(read("list.txt"), twelve);
    assert.throws(() => sessionEditFile(directory, "../x", "a", "b"), /relative segments/);
    assert.throws(() => sessionEditFile(directory, ".git/config", "a", "b"), /\.git/);
  });

  test("refuses to create a file and points at write_file", () => {
    assert.throws(
      () => sessionEditFile(directory, "fresh.md", "a", "b"),
      /No such file: fresh\.md\. To create a file, use repository_write_file\./,
    );
    assert.equal(fs.existsSync(path.join(directory, "fresh.md")), false);
  });

  test("keeps the file's mode and never interprets $ in the replacement", () => {
    write("run.sh", "#!/bin/sh\necho hi\n");
    fs.chmodSync(path.join(directory, "run.sh"), 0o755);
    sessionEditFile(directory, "run.sh", "echo hi", "echo $& and $1");
    assert.equal(read("run.sh"), "#!/bin/sh\necho $& and $1\n");
    assert.equal(fs.statSync(path.join(directory, "run.sh")).mode & 0o777, 0o755);
  });

  test("refuses a symlink, a binary and anything over the editable cap", () => {
    fs.symlinkSync("README.md", path.join(directory, "link.md"));
    assert.throws(
      () => sessionEditFile(directory, "link.md", "Fixture", "Pwned"),
      /not a regular file|symlink/,
    );
    assert.equal(read("README.md"), "# Fixture\n");
    assert.ok(fs.lstatSync(path.join(directory, "link.md")).isSymbolicLink());

    write("blob.bin", Buffer.from([0x00, 0x61, 0x62]));
    assert.throws(() => sessionEditFile(directory, "blob.bin", "a", "b"), /binary/);

    write("huge.txt", "x".repeat(300 * 1024));
    assert.throws(
      () => sessionEditFile(directory, "huge.txt", "x", "y"),
      /too large to edit in place/,
    );
  });
});

// ─────────────────────── enumerating the tree ───────────────────────────

describe("sessionVisibleFiles", () => {
  test("lists tracked and untracked files, minus ignored, deleted and symlinked ones", async () => {
    write("debug.log", "ignored by *.log\n");
    write("dist/out.js", "ignored by dist/\n");
    write("notes.md", "untracked but visible\n");
    write("lib/deep/x.ts", "untracked, nested\n");
    fs.rmSync(path.join(directory, "docs/guide.md"));
    fs.symlinkSync("README.md", path.join(directory, "link.md"));

    assert.deepEqual(await sessionVisibleFiles(repository, directory), [
      ".gitignore",
      "README.md",
      "lib/deep/x.ts",
      "notes.md",
      "src/app.ts",
      "src/util.ts",
    ]);
  });
});

// ─────────────────────────────── glob ───────────────────────────────────

describe("sessionGlob", () => {
  test("a pattern without a slash matches basenames anywhere", async () => {
    write("lib/deep/extra.ts", "x\n");
    const result = await sessionGlob(repository, directory, "*.ts");
    assert.deepEqual(result.matches, ["lib/deep/extra.ts", "src/app.ts", "src/util.ts"]);
    assert.equal(result.truncated, false);
  });

  test("** crosses directories and a slash anchors the pattern to the path", async () => {
    write("lib/deep/extra.ts", "x\n");
    const glob = async (pattern: string) =>
      (await sessionGlob(repository, directory, pattern)).matches;
    assert.deepEqual(await glob("**/*.md"), ["README.md", "docs/guide.md"]);
    assert.deepEqual(await glob("src/*.ts"), ["src/app.ts", "src/util.ts"]);
    assert.deepEqual(await glob("lib/**/*.ts"), ["lib/deep/extra.ts"]);
    assert.deepEqual(await glob("*/extra.ts"), [], "a single * does not cross a directory");
  });

  test("scopes to a folder and answers with repository-relative paths", async () => {
    write("lib/x.ts", "x\n");
    assert.deepEqual((await sessionGlob(repository, directory, "*.ts", "src")).matches, [
      "src/app.ts",
      "src/util.ts",
    ]);
    assert.deepEqual((await sessionGlob(repository, directory, "*.ts", "docs")).matches, []);
  });

  test("skips ignored files and refuses an empty pattern or a path outside the worktree", async () => {
    write("debug.log", "x\n");
    assert.deepEqual((await sessionGlob(repository, directory, "*.log")).matches, []);
    await assert.rejects(
      () => sessionGlob(repository, directory, "  "),
      /glob pattern is required/,
    );
    await assert.rejects(() => sessionGlob(repository, directory, "*", ".."), /relative segments/);
  });

  test("stops at the cap and says so", async () => {
    seedMany("many", MAX_GLOB_RESULTS + 5);
    const result = await sessionGlob(repository, directory, "*.txt");
    assert.equal(result.matches.length, MAX_GLOB_RESULTS);
    assert.equal(result.truncated, true);
  });
});

// ─────────────────────────────── grep ───────────────────────────────────

describe("sessionGrep", () => {
  const grep = (options: Parameters<typeof sessionGrep>[2]) =>
    sessionGrep(repository, directory, options);

  test("content mode renders path:line:text and separates files with --", async () => {
    const found = await grep({ pattern: "helper\\(" });
    assert.equal(
      found.text,
      "src/app.ts:4:  const total = helper(1, 2);\n--\n" +
        "src/util.ts:1:export function helper(a: number, b: number): number {",
    );
    assert.deepEqual([found.matches, found.files, found.truncated], [2, 2, false]);
  });

  test("is case-sensitive unless told otherwise, and refuses an empty or invalid pattern", async () => {
    await assert.rejects(() => grep({ pattern: "   " }), /Enter something to search for/);
    await assert.rejects(() => grep({ pattern: "(" }), /Invalid regular expression/);
    const strict = await grep({ pattern: "todo" });
    assert.equal(strict.text, "(no matches)");
    assert.deepEqual([strict.matches, strict.files], [0, 0]);
    const loose = await grep({ pattern: "todo", ignoreCase: true });
    assert.equal(
      loose.text,
      "docs/guide.md:4:TODO: write more.\n--\nsrc/app.ts:8:// TODO: remove the debug log",
    );
    assert.equal(loose.matches, 2);
  });

  test("a glob narrows by filename", async () => {
    const found = await grep({ pattern: "TODO", glob: "*.md" });
    assert.equal(found.text, "docs/guide.md:4:TODO: write more.");
  });

  test("path scopes to a folder or a single file", async () => {
    assert.equal(
      (await grep({ pattern: "TODO", path: "src" })).text,
      "src/app.ts:8:// TODO: remove the debug log",
    );
    assert.equal(
      (await grep({ pattern: "return", path: "src/util.ts" })).text,
      "src/util.ts:2:  return a + b;",
    );
    await assert.rejects(() => grep({ pattern: "x", path: "missing" }), /No such path: missing/);
  });

  test("context lines use path-line-text, with -- between separate groups", async () => {
    const one = await grep({ pattern: "const total", context: 1 });
    assert.equal(
      one.text,
      "src/app.ts-3-export function main(): void {\n" +
        "src/app.ts:4:  const total = helper(1, 2);\n" +
        'src/app.ts-5-  console.log("Total:", total);',
    );
    write("ctx.txt", "alpha\nx\nx\nx\nx\nx\nx\nx\nx\nalpha\n");
    const two = await grep({ pattern: "alpha", path: "ctx.txt", context: 1 });
    assert.equal(two.text, "ctx.txt:1:alpha\nctx.txt-2-x\n--\nctx.txt-9-x\nctx.txt:10:alpha");
    // Windows that touch merge into one group with no separator.
    write("near.txt", "x\nalpha\nx\nalpha\nx\n");
    const merged = await grep({ pattern: "alpha", path: "near.txt", context: 1 });
    assert.equal(
      merged.text,
      "near.txt-1-x\nnear.txt:2:alpha\nnear.txt-3-x\nnear.txt:4:alpha\nnear.txt-5-x",
    );
  });

  test("files and count modes", async () => {
    const files = await grep({ pattern: "todo", ignoreCase: true, outputMode: "files" });
    assert.equal(files.text, "docs/guide.md\nsrc/app.ts");
    assert.deepEqual([files.matches, files.files], [2, 2]);
    const count = await grep({ pattern: "todo", ignoreCase: true, outputMode: "count" });
    assert.equal(count.text, "docs/guide.md: 1\nsrc/app.ts: 1");
  });

  test("skips ignored and binary files, and clips a very long line", async () => {
    write("debug.log", "TODO in an ignored file\n");
    write("blob.bin", Buffer.from("TODO\0binary"));
    const found = await grep({ pattern: "TODO", outputMode: "files" });
    assert.equal(found.text, "docs/guide.md\nsrc/app.ts");

    const long = `needle${"z".repeat(500)}`;
    write("wide.txt", `${long}\n`);
    const clipped = await grep({ pattern: "needle", path: "wide.txt" });
    assert.equal(clipped.text, `wide.txt:1:${long.slice(0, 400)}…`);
  });

  test("stops at 200 matches and says how to narrow the search", async () => {
    write("hay.txt", `${Array.from({ length: 250 }, (_, i) => `needle ${i + 1}`).join("\n")}\n`);
    const found = await grep({ pattern: "needle" });
    assert.deepEqual([found.matches, found.files, found.truncated], [MAX_GREP_MATCHES, 1, true]);
    const trailer = `\n\n[Stopped after ${MAX_GREP_MATCHES} matches. Narrow the search with path, glob, or a more specific pattern.]`;
    assert.ok(found.text.endsWith(trailer));
    const body = found.text.slice(0, -trailer.length).split("\n");
    assert.equal(body.length, MAX_GREP_MATCHES);
    assert.equal(body[0], "hay.txt:1:needle 1");
    assert.equal(body[199], "hay.txt:200:needle 200");
  });
});

// ─────────────────────────── listing a tree ─────────────────────────────

describe("sessionTree", () => {
  function seedTreeExtras(): void {
    write("dist/out.js", "built\n");
    write("debug.log", "trace");
    fs.mkdirSync(path.join(directory, "empty"));
    write("src/trace.log", "nested and ignored\n");
    write("src/node_modules/pkg/index.js", "x\n");
  }

  test("depth 1 lists folders first, marks ignored entries, and shows sizes", async () => {
    seedTreeExtras();
    const tree = await sessionTree(repository, directory, "", 1);
    const lines = tree.text.split("\n");
    assert.deepEqual(lines.slice(0, 4), ["dist/  (ignored)", "docs/", "empty/", "src/"]);
    assert.ok(lines.includes("README.md  (10 B)"), tree.text);
    assert.ok(lines.includes(`.gitignore  (${size(".gitignore")})`), tree.text);
    assert.ok(lines.includes("debug.log  (5 B, ignored)"), tree.text);
    assert.equal(lines.length, 7);
    assert.ok(!lines.some((line) => line.startsWith("  ")), "depth 1 never descends");
    assert.deepEqual([tree.entries, tree.truncated], [7, false]);
  });

  test("depth 2 descends visible folders only and hides ignored entries below the top level", async () => {
    seedTreeExtras();
    const tree = await sessionTree(repository, directory, "", 2);
    const lines = tree.text.split("\n");
    assert.deepEqual(lines.slice(0, 7), [
      "dist/  (ignored)",
      "docs/",
      `  guide.md  (${size("docs/guide.md")})`,
      "empty/",
      "src/",
      `  app.ts  (${size("src/app.ts")})`,
      `  util.ts  (${size("src/util.ts")})`,
    ]);
    // An ignored folder is never descended; ignored entries below the top
    // level are not shown at all, marked or otherwise.
    for (const hidden of ["out.js", "trace.log", "node_modules"]) {
      assert.ok(!tree.text.includes(hidden), `${hidden} in:\n${tree.text}`);
    }
    assert.equal(tree.entries, 10);
  });

  test("an empty folder says so, and a file or missing path is refused", async () => {
    fs.mkdirSync(path.join(directory, "empty"));
    const empty = await sessionTree(repository, directory, "empty");
    assert.deepEqual([empty.text, empty.entries, empty.truncated], ["(empty folder)", 0, false]);
    await assert.rejects(
      () => sessionTree(repository, directory, "README.md"),
      /README\.md is a file — read it with repository_read_file/,
    );
    await assert.rejects(() => sessionTree(repository, directory, "nope"), /No such folder: nope/);
    await assert.rejects(() => sessionTree(repository, directory, "../"), /relative segments/);
  });

  test("lists a subfolder and never goes deeper than four levels", async () => {
    write("a/b/c/d/e/f.txt", "x\n");
    const deep = await sessionTree(repository, directory, "", 10);
    assert.deepEqual(deep.text.split("\n").slice(0, 4), ["a/", "  b/", "    c/", "      d/"]);
    assert.ok(!deep.text.includes("e/"));
    const sub = await sessionTree(repository, directory, "a/b", 1);
    assert.equal(sub.text, "c/");
  });

  test("stops at the cap and says so", async () => {
    seedMany("many", MAX_TREE_LINES + 10);
    const tree = await sessionTree(repository, directory, "", 2);
    assert.equal(tree.truncated, true);
    assert.ok(tree.entries <= MAX_TREE_LINES);
    assert.ok(
      tree.text.endsWith(
        `\n\n[Listing stopped at ${MAX_TREE_LINES} entries. List a subfolder, or use repository_glob for a specific kind of file.]`,
      ),
    );
  });
});

// ───────────────────────── git status and diff ──────────────────────────

describe("sessionStatus", () => {
  test("a fresh worktree reports its branch and that nothing has changed", async () => {
    const status = await sessionStatus(repository, directory, baseCommit);
    assert.deepEqual([status.branch, status.commits, status.uncommitted], [branch, 0, 0]);
    assert.equal(
      status.text,
      [
        `Branch: ${branch}`,
        `Based on: ${baseCommit.slice(0, 7)}`,
        "Commits on this branch so far: 0",
        "Uncommitted changes: 0",
        "Nothing has been changed yet.",
      ].join("\n"),
    );
  });

  test("lists uncommitted changes with git's codes", async () => {
    write("README.md", "# Fixture\n\nchanged\n");
    write("new.md", "n\n");
    await git(["add", "new.md"]);
    fs.rmSync(path.join(directory, "docs/guide.md"));
    await git(["mv", "src/util.ts", "src/helpers.ts"]);

    const status = await sessionStatus(repository, directory, baseCommit);
    assert.equal(status.uncommitted, 4);
    const lines = status.text.split("\n");
    for (const expected of [
      "Uncommitted changes: 4",
      "  M  README.md",
      "  A  new.md",
      "  D  docs/guide.md",
      "  R  src/util.ts -> src/helpers.ts",
    ]) {
      assert.ok(lines.includes(expected), `${expected} in:\n${status.text}`);
    }
    assert.ok(!status.text.includes("Nothing has been changed yet."));
  });

  test("counts the commits made on the branch since its base", async () => {
    write("note.md", "x\n");
    const first = await sessionCommit(repository, directory, "Add a note");
    write("note.md", "x\ny\n");
    await sessionCommit(repository, directory, "Extend the note");
    assert.equal(first?.filesChanged, 1);

    const status = await sessionStatus(repository, directory, baseCommit);
    assert.deepEqual([status.commits, status.uncommitted], [2, 0]);
    assert.match(
      status.text,
      /Commits on this branch so far: 2\n {2}[0-9a-f]{7,} Extend the note\n {2}[0-9a-f]{7,} Add a note\nUncommitted changes: 0$/,
    );

    const bare = await sessionStatus(repository, directory, null);
    assert.equal(bare.commits, 0);
    assert.ok(!bare.text.includes("Based on"));
  });
});

describe("sessionDiff", () => {
  test("says when there is nothing, and needs a base to diff commits against", async () => {
    const none = await sessionDiff(repository, directory);
    assert.deepEqual(
      [none.text, none.filesChanged, none.truncated],
      ["(no uncommitted changes)", 0, false],
    );
    const committed = await sessionDiff(repository, directory, { committed: true, baseCommit });
    assert.equal(committed.text, "(no committed changes on this branch yet)");
    await assert.rejects(
      () => sessionDiff(repository, directory, { committed: true, baseCommit: null }),
      /no base commit/,
    );
  });

  test("shows uncommitted work, rendering untracked files as additions", async () => {
    write("README.md", "# Fixture\n\nIntro.\n");
    write("new.md", "hello\nworld");
    write("blob.bin", Buffer.from([0x01, 0x00, 0x02]));

    const diff = await sessionDiff(repository, directory);
    assert.ok(diff.text.startsWith("diff --git a/README.md b/README.md\n"));
    assert.match(diff.text, /^\+Intro\.$/m);
    assert.ok(
      diff.text.includes(
        "diff --git a/new.md b/new.md\nnew file mode 100644\n--- /dev/null\n+++ b/new.md\n" +
          "@@ -0,0 +1,2 @@\n+hello\n+world\n\\ No newline at end of file\n",
      ),
      diff.text,
    );
    assert.ok(
      diff.text.includes(
        "diff --git a/blob.bin b/blob.bin\nnew file mode 100644\nBinary file blob.bin added\n",
      ),
    );
    assert.deepEqual(
      [diff.filesChanged, diff.insertions, diff.deletions, diff.truncated],
      [3, 4, 0, false],
    );
  });

  test("committed mode shows what the branch recorded, which uncommitted mode then stops showing", async () => {
    write("note.md", "x\n");
    await sessionCommit(repository, directory, "Add a note");
    const committed = await sessionDiff(repository, directory, { committed: true, baseCommit });
    assert.match(committed.text, /^diff --git a\/note\.md b\/note\.md\n/);
    assert.match(committed.text, /^\+x$/m);
    assert.deepEqual([committed.filesChanged, committed.insertions], [1, 1]);
    assert.equal((await sessionDiff(repository, directory)).text, "(no uncommitted changes)");
  });

  test("scopes to a path, for tracked and untracked files alike", async () => {
    write("README.md", "# Fixture\n\nchanged\n");
    write("src/app.ts", `${APP_TS}export const extra = 1;\n`);
    write("docs/new.md", "n\n");

    const app = await sessionDiff(repository, directory, { path: "src/app.ts" });
    assert.equal(app.filesChanged, 1);
    assert.match(app.text, /^diff --git a\/src\/app\.ts b\/src\/app\.ts\n/);
    assert.doesNotMatch(app.text, /README|new\.md/);
    const docs = await sessionDiff(repository, directory, { path: "docs" });
    assert.equal(docs.filesChanged, 1);
    assert.match(docs.text, /^diff --git a\/docs\/new\.md b\/docs\/new\.md\n/);
    assert.doesNotMatch(docs.text, /README|app\.ts/);
    await assert.rejects(
      () => sessionDiff(repository, directory, { path: "../x" }),
      /relative segments/,
    );
  });

  test("truncates a very large diff and says how to get the rest", async () => {
    write(
      "big.txt",
      `${Array.from({ length: 3000 }, (_, i) => `line ${i} ${"y".repeat(30)}`).join("\n")}\n`,
    );
    const diff = await sessionDiff(repository, directory);
    const notice = "\n\n[Diff truncated. Ask for one path at a time with the path argument.]";
    assert.equal(diff.truncated, true);
    assert.ok(diff.text.endsWith(notice));
    assert.equal(diff.text.length, MAX_SESSION_DIFF_CHARS + notice.length);
    assert.deepEqual(
      [diff.filesChanged, diff.insertions],
      [1, 3000],
      "counts come from the whole patch",
    );
  });
});

// ─────────────────────────────── steps ──────────────────────────────────

describe("normalizeSessionSteps", () => {
  test("accepts a well-formed list, trimming and clipping each step's text", () => {
    assert.deepEqual(
      normalizeSessionSteps([
        { text: "  Read the code  ", status: "completed" },
        { text: "x".repeat(300), status: "in_progress" },
        { text: "Commit", status: "pending" },
      ]),
      [
        { text: "Read the code", status: "completed" },
        { text: "x".repeat(200), status: "in_progress" },
        { text: "Commit", status: "pending" },
      ],
    );
    assert.deepEqual(normalizeSessionSteps([]), []);
  });

  test("refuses bad input with a message the model can act on", () => {
    assert.throws(() => normalizeSessionSteps("read, edit, commit"), /steps must be an array/);
    assert.throws(
      () =>
        normalizeSessionSteps(Array.from({ length: 31 }, () => ({ text: "s", status: "pending" }))),
      /Keep the list to 30 steps or fewer/,
    );
    assert.throws(() => normalizeSessionSteps(["Read"]), /Each step must be an object/);
    assert.throws(
      () => normalizeSessionSteps([{ text: "  ", status: "pending" }]),
      /Each step needs text/,
    );
    assert.throws(
      () => normalizeSessionSteps([{ text: "Read", status: "done" }]),
      /status must be pending, in_progress, or completed/,
    );
    assert.throws(
      () =>
        normalizeSessionSteps([
          { text: "Read", status: "in_progress" },
          { text: "Edit", status: "in_progress" },
        ]),
      /Only one step can be in_progress at a time/,
    );
  });
});
