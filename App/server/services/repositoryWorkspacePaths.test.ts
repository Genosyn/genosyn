import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  assertSafeBranchName,
  assertSafeRef,
  isBinary,
  normalizeRepositoryPath,
  parseCommits,
  parseStatus,
  resolveInCheckout,
  summarizeDiff,
} from "./repositoryWorkspace.js";

/**
 * The pure half of the repository workspace: path validation, Git output
 * parsing, and diff summarizing. These need no Git and no database, so they
 * carry the cases that matter most — the ones where a wrong answer is a path
 * traversal or a silently mis-parsed status.
 */

describe("normalizeRepositoryPath", () => {
  test("accepts ordinary paths and strips redundant separators", () => {
    assert.equal(normalizeRepositoryPath("README.md"), "README.md");
    assert.equal(normalizeRepositoryPath("docs/strategy/2026.md"), "docs/strategy/2026.md");
    assert.equal(normalizeRepositoryPath("/docs/plan.md"), "docs/plan.md");
    assert.equal(normalizeRepositoryPath("docs/plan.md/"), "docs/plan.md");
    assert.equal(normalizeRepositoryPath("///docs///"), "docs");
  });

  test("keeps names that merely look suspicious", () => {
    assert.equal(normalizeRepositoryPath("..hidden"), "..hidden");
    assert.equal(normalizeRepositoryPath("a..b/c"), "a..b/c");
    assert.equal(normalizeRepositoryPath(".gitignore"), ".gitignore");
    assert.equal(normalizeRepositoryPath("gitk/.git-blame"), "gitk/.git-blame");
  });

  test("refuses to leave the repository", () => {
    for (const bad of [
      "../secrets",
      "docs/../../etc/passwd",
      "..",
      "./..",
      "docs/./../..",
      "a//../..",
    ]) {
      assert.throws(() => normalizeRepositoryPath(bad), /relative segments|required/, bad);
    }
  });

  test("refuses anything inside .git at any depth", () => {
    for (const bad of [".git", ".git/config", "docs/.git/hooks/pre-commit", ".git/HEAD"]) {
      assert.throws(() => normalizeRepositoryPath(bad), /\.git directory/, bad);
    }
  });

  test("refuses NUL bytes, which Git would truncate at", () => {
    assert.throws(() => normalizeRepositoryPath("docs/plan.md\0.png"), /invalid character/);
  });

  test("only allows the root when the caller asked for it", () => {
    assert.equal(normalizeRepositoryPath("", { allowRoot: true }), "");
    assert.equal(normalizeRepositoryPath(".", { allowRoot: true }), "");
    assert.equal(normalizeRepositoryPath("/", { allowRoot: true }), "");
    assert.throws(() => normalizeRepositoryPath(""), /file path is required/);
  });
});

describe("resolveInCheckout", () => {
  let root: string;
  let checkout: string;

  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-paths-"));
    checkout = path.join(root, "checkout");
    fs.mkdirSync(path.join(checkout, "docs"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "docs", "plan.md"), "# Plan\n");
    fs.mkdirSync(path.join(root, "outside"), { recursive: true });
    fs.writeFileSync(path.join(root, "outside", "secret.txt"), "secret");
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("resolves paths that stay inside the checkout", () => {
    assert.equal(
      resolveInCheckout(checkout, "docs/plan.md"),
      path.join(fs.realpathSync(checkout), "docs/plan.md"),
    );
  });

  test("resolves a path whose file does not exist yet", () => {
    assert.equal(
      resolveInCheckout(checkout, "docs/new/deeply/nested.md"),
      path.join(fs.realpathSync(checkout), "docs/new/deeply/nested.md"),
    );
  });

  test("refuses a symlinked directory that points outside the checkout", () => {
    fs.symlinkSync(path.join(root, "outside"), path.join(checkout, "escape"));
    assert.throws(() => resolveInCheckout(checkout, "escape/secret.txt"), /escapes the repository/);
  });

  test("refuses a symlinked file that points outside the checkout", () => {
    fs.symlinkSync(path.join(root, "outside", "secret.txt"), path.join(checkout, "link.txt"));
    assert.throws(() => resolveInCheckout(checkout, "link.txt"), /escapes the repository/);
  });
});

describe("assertSafeBranchName", () => {
  test("accepts branch names people actually use", () => {
    for (const name of [
      "main",
      "feature/editor",
      "release-1.2.3",
      "genosyn/ada/1a2b3c4d",
      "fix_typo",
    ]) {
      assert.doesNotThrow(() => assertSafeBranchName(name), name);
    }
  });

  test("refuses names that would reach Git as an option or an invalid ref", () => {
    for (const name of [
      "",
      "--upload-pack=touch /tmp/x",
      "-b",
      "/leading",
      "trailing/",
      "has space",
      "has..dots",
      "double//slash",
      "stale.lock",
      "semi;colon",
      "quote'name",
      "$(whoami)",
    ]) {
      assert.throws(() => assertSafeBranchName(name), /branch name/i, name);
    }
  });
});

describe("assertSafeRef", () => {
  test("accepts the revisions the UI produces", () => {
    for (const ref of ["HEAD", "main", "origin/main", "HEAD~2", "abc123def456", "v1.0^"]) {
      assert.doesNotThrow(() => assertSafeRef(ref), ref);
    }
  });

  test("refuses option-shaped and range revisions", () => {
    for (const ref of ["", "--output=/tmp/x", "-n1", "main..other", "a b", "`id`"]) {
      assert.throws(() => assertSafeRef(ref), /revision/, ref);
    }
  });
});

describe("parseStatus", () => {
  const NUL = "\0";

  test("reads the branch header with upstream and divergence", () => {
    const status = parseStatus(`## main...origin/main [ahead 2, behind 3]${NUL}`);
    assert.equal(status.branch, "main");
    assert.equal(status.upstream, "origin/main");
    assert.equal(status.ahead, 2);
    assert.equal(status.behind, 3);
    assert.equal(status.unborn, false);
    assert.equal(status.detached, false);
  });

  test("reads a branch with no upstream", () => {
    const status = parseStatus(`## feature/editor${NUL}`);
    assert.equal(status.branch, "feature/editor");
    assert.equal(status.upstream, null);
    assert.equal(status.ahead, 0);
  });

  test("recognizes a repository before its first commit", () => {
    const status = parseStatus(`## No commits yet on main${NUL}`);
    assert.equal(status.unborn, true);
    assert.equal(status.branch, "main");
  });

  test("recognizes a detached HEAD", () => {
    const status = parseStatus(`## HEAD (no branch)${NUL}`);
    assert.equal(status.detached, true);
  });

  test("classifies staged and unstaged changes separately", () => {
    const status = parseStatus(
      [`## main`, `M  staged.md`, ` M unstaged.md`, `MM both.md`, `A  added.md`, `D  gone.md`, ``]
        .join(NUL),
    );
    assert.deepEqual(status.changes, [
      { path: "staged.md", fromPath: null, status: "modified", staged: true },
      { path: "unstaged.md", fromPath: null, status: "modified", staged: false },
      { path: "both.md", fromPath: null, status: "modified", staged: true },
      { path: "both.md", fromPath: null, status: "modified", staged: false },
      { path: "added.md", fromPath: null, status: "added", staged: true },
      { path: "gone.md", fromPath: null, status: "deleted", staged: true },
    ]);
  });

  test("reads a rename's second record as the original path", () => {
    const status = parseStatus([`## main`, `R  new.md`, `old.md`, `?? fresh.md`, ``].join(NUL));
    assert.deepEqual(status.changes, [
      { path: "new.md", fromPath: "old.md", status: "renamed", staged: true },
      { path: "fresh.md", fromPath: null, status: "untracked", staged: false },
    ]);
  });

  test("flags conflicts rather than reporting them as ordinary edits", () => {
    const status = parseStatus([`## main`, `UU conflicted.md`, `AA both-added.md`, ``].join(NUL));
    assert.deepEqual(
      status.changes.map((c) => c.status),
      ["conflicted", "conflicted"],
    );
  });

  test("survives a filename containing a newline", () => {
    const status = parseStatus([`## main`, ` M weird\nname.md`, ``].join(NUL));
    assert.deepEqual(status.changes, [
      { path: "weird\nname.md", fromPath: null, status: "modified", staged: false },
    ]);
  });

  test("handles a clean tree", () => {
    const status = parseStatus(`## main...origin/main${NUL}`);
    assert.deepEqual(status.changes, []);
  });
});

describe("parseCommits", () => {
  const record = (fields: string[]): string => fields.join("\x1f");

  test("reads a single commit", () => {
    const commits = parseCommits(
      record([
        "a".repeat(40),
        "aaaaaaa",
        "Add the plan",
        "Because we needed one.\n",
        "Ada",
        "ada@example.com",
        "2026-01-02T03:04:05+00:00",
        "b".repeat(40),
      ]) + "\x1e",
    );
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, "Add the plan");
    assert.equal(commits[0].body, "Because we needed one.");
    assert.equal(commits[0].authorName, "Ada");
    assert.deepEqual(commits[0].parents, ["b".repeat(40)]);
  });

  test("reads several commits and a merge's two parents", () => {
    const raw =
      record(["1", "1", "First", "", "A", "a@x", "t", "p1"]) +
      "\x1e" +
      record(["2", "2", "Merge", "", "B", "b@x", "t", "p1 p2"]) +
      "\x1e";
    const commits = parseCommits(raw);
    assert.equal(commits.length, 2);
    assert.deepEqual(commits[1].parents, ["p1", "p2"]);
  });

  test("reads a root commit's empty parent list", () => {
    const commits = parseCommits(record(["1", "1", "Root", "", "A", "a@x", "t", ""]) + "\x1e");
    assert.deepEqual(commits[0].parents, []);
  });

  test("returns nothing for empty output", () => {
    assert.deepEqual(parseCommits(""), []);
    assert.deepEqual(parseCommits("\n"), []);
  });
});

describe("summarizeDiff", () => {
  test("counts files, insertions, and deletions without recounting the headers", () => {
    const patch = [
      "diff --git a/a.md b/a.md",
      "index 111..222 100644",
      "--- a/a.md",
      "+++ b/a.md",
      "@@ -1,2 +1,2 @@",
      "-old line",
      "+new line",
      " context",
      "diff --git a/b.md b/b.md",
      "--- a/b.md",
      "+++ b/b.md",
      "@@ -1 +1,2 @@",
      " keep",
      "+added",
      "",
    ].join("\n");
    const summary = summarizeDiff(patch);
    assert.equal(summary.filesChanged, 2);
    assert.equal(summary.insertions, 2);
    assert.equal(summary.deletions, 1);
    assert.equal(summary.truncated, false);
    assert.equal(summary.patch, patch);
  });

  test("reports an empty diff as no change at all", () => {
    assert.deepEqual(summarizeDiff(""), {
      patch: "",
      truncated: false,
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
    });
  });

  test("truncates an enormous patch but still reports the true totals", () => {
    const line = "+" + "x".repeat(200);
    const patch = ["diff --git a/big b/big", "--- a/big", "+++ b/big", "@@ -0,0 +1,20000 @@"]
      .concat(Array.from({ length: 20000 }, () => line))
      .join("\n");
    const summary = summarizeDiff(patch);
    assert.equal(summary.truncated, true);
    assert.ok(summary.patch.length < patch.length);
    assert.equal(summary.insertions, 20000);
  });
});

describe("isBinary", () => {
  test("treats a NUL byte in the first 8 KB as binary, like Git does", () => {
    assert.equal(isBinary(Buffer.from("plain text\nwith lines\n")), false);
    assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d])), true);
    assert.equal(isBinary(Buffer.from("")), false);
  });

  test("does not read past the first 8 KB", () => {
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0x00])]);
    assert.equal(isBinary(late), false);
  });

  test("treats UTF-8 text as text", () => {
    assert.equal(isBinary(Buffer.from("héllo — naïve ✓\n", "utf8")), false);
  });
});
