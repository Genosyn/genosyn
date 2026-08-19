import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { after, afterEach, before, describe, test } from "node:test";
import { config } from "../../config.js";
import type { Repository } from "../db/entities/Repository.js";
import {
  checkoutRepositoryBranch,
  publishRepositoryToRemote,
  searchRepository,
  commitRepositoryChanges,
  createRepositoryBranch,
  createRepositoryDirectory,
  deleteRepositoryEntry,
  discardRepositoryChanges,
  ensureRepositoryWorkspace,
  listRepositoryTree,
  mergeBranchIntoCurrent,
  moveRepositoryEntry,
  pullRepositoryBranch,
  pushRepositoryBranch,
  readRepositoryFile,
  removeRepositoryWorkspace,
  repositoryBranches,
  repositoryCheckoutExists,
  repositoryCheckoutPath,
  repositoryCommitDiff,
  repositoryLog,
  repositoryStatus,
  repositoryWorkingDiff,
  writeRepositoryFile,
} from "./repositoryWorkspace.js";

const exec = promisify(execFile);

/**
 * End-to-end exercise of the App-owned repository checkout against real Git.
 *
 * These deliberately run with the *default* coding-tools configuration — which
 * is `enabled: true, executionMode: "disabled"` — because the single most
 * important property of this feature is that it works on a standard install
 * where the model sandbox is switched off. If someone reinstates the coding
 * gate on server-owned Git, every test in this file fails, which is exactly
 * what should happen.
 */

let dataDir: string;
const originalDataDir = config.dataDir;
const codingTools = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const originalCodingTools = { ...codingTools };

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-workspace-"));
  (config as { dataDir: string }).dataDir = dataDir;
  // The standard Docker default: command execution off entirely.
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.allowUnsafeHostExecution = false;
});

after(() => {
  (config as { dataDir: string }).dataDir = originalDataDir;
  Object.assign(codingTools, originalCodingTools);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let repoCounter = 0;

function makeRepository(overrides: Partial<Repository> = {}): Repository {
  repoCounter += 1;
  return {
    id: `repo-${repoCounter}`,
    companyId: "company-1",
    name: `Repository ${repoCounter}`,
    slug: `repository-${repoCounter}`,
    description: "",
    origin: "local",
    kind: "documents",
    gitUrl: "",
    defaultBranch: "main",
    authMode: "none",
    httpsUsername: null,
    encryptedToken: null,
    encryptedSshKey: null,
    committerName: "Genosyn Test",
    committerEmail: "test@genosyn.local",
    lastSyncedAt: null,
    lastSyncStatus: "unknown",
    lastSyncError: "",
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Repository;
}

async function localRepository(overrides: Partial<Repository> = {}): Promise<Repository> {
  const repo = makeRepository(overrides);
  await ensureRepositoryWorkspace(repo);
  return repo;
}

function changePaths(changes: { path: string }[]): string[] {
  return [...new Set(changes.map((c) => c.path))].sort();
}

// ───────────────────────────── lifecycle ────────────────────────────────

describe("a local repository", () => {
  test("is created with a real checkout and an initial commit", async () => {
    const repo = await localRepository();
    assert.equal(repositoryCheckoutExists(repo), true);
    assert.ok(fs.existsSync(path.join(repositoryCheckoutPath(repo), ".git")));

    const status = await repositoryStatus(repo);
    assert.equal(status.branch, "main");
    assert.equal(status.unborn, false, "the initial commit means HEAD is never unborn");
    assert.deepEqual(status.changes, []);

    const commits = await repositoryLog(repo);
    assert.equal(commits.length, 1);
    assert.equal(commits[0].subject, "Create repository");
  });

  test("starts with a README rather than an empty commit", async () => {
    const repo = await localRepository({
      name: "Company Strategy",
      description: "Where the plan lives.",
    });
    const readme = await readRepositoryFile(repo, "README.md");
    assert.equal(readme.content, "# Company Strategy\n\nWhere the plan lives.\n");
    // Seeded in the first commit, so there is nothing uncommitted to explain.
    assert.deepEqual((await repositoryStatus(repo)).changes, []);
  });

  test("omits the description line when there is no description", async () => {
    const repo = await localRepository({ name: "Runbooks", description: "" });
    assert.equal((await readRepositoryFile(repo, "README.md")).content, "# Runbooks\n");
  });

  test("honours a custom default branch", async () => {
    const repo = await localRepository({ defaultBranch: "trunk" });
    const status = await repositoryStatus(repo);
    assert.equal(status.branch, "trunk");
  });

  test("lives under .private, where no model process can reach it", async () => {
    const repo = await localRepository();
    const relative = path.relative(dataDir, repositoryCheckoutPath(repo));
    assert.ok(
      relative.startsWith(`.private${path.sep}repositories${path.sep}`),
      `expected a .private path, got ${relative}`,
    );
  });

  test("is idempotent — a second ensure does not disturb working-tree edits", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "notes.md", "work in progress");
    await ensureRepositoryWorkspace(repo);
    const file = await readRepositoryFile(repo, "notes.md");
    assert.equal(file.content, "work in progress");
  });

  test("is removed with its row", async () => {
    const repo = await localRepository();
    removeRepositoryWorkspace(repo.companyId, repo.id);
    assert.equal(repositoryCheckoutExists(repo), false);
  });
});

// ────────────────────────── browsing and editing ────────────────────────

describe("browsing and editing", () => {
  test("lists a directory with folders first and .git hidden", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "README.md", "# Read me\n");
    await writeRepositoryFile(repo, "docs/plan.md", "# Plan\n");
    await writeRepositoryFile(repo, "a-file.txt", "text");

    const root = await listRepositoryTree(repo, "");
    assert.deepEqual(
      root.map((e) => `${e.type}:${e.name}`),
      // Case-insensitive, the way a file browser should sort.
      ["directory:docs", "file:a-file.txt", "file:README.md"],
    );
    assert.ok(!root.some((e) => e.name === ".git"));

    const docs = await listRepositoryTree(repo, "docs");
    assert.deepEqual(
      docs.map((e) => e.path),
      ["docs/plan.md"],
    );
  });

  test("reports a helpful error for a missing or non-directory path", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "file.md", "x");
    await assert.rejects(() => listRepositoryTree(repo, "nope"), /Directory not found/);
    await assert.rejects(() => listRepositoryTree(repo, "file.md"), /not a directory/);
  });

  test("round-trips a file through write and read", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "docs/strategy/2026.md", "# Strategy\n\nGrow.\n");
    const file = await readRepositoryFile(repo, "docs/strategy/2026.md");
    assert.equal(file.content, "# Strategy\n\nGrow.\n");
    assert.equal(file.binary, false);
    assert.equal(file.tooLarge, false);
    assert.equal(file.ref, null);
  });

  test("reports a binary file instead of returning mangled text", async () => {
    const repo = await localRepository();
    fs.writeFileSync(
      path.join(repositoryCheckoutPath(repo), "logo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]),
    );
    const file = await readRepositoryFile(repo, "logo.png");
    assert.equal(file.binary, true);
    assert.equal(file.content, null);
  });

  test("reads a file as it was at an earlier revision", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "plan.md", "first\n");
    const first = await commitRepositoryChanges(repo, { message: "Add the plan" });
    assert.ok(first);
    await writeRepositoryFile(repo, "plan.md", "second\n");
    await commitRepositoryChanges(repo, { message: "Revise the plan" });

    const historical = await readRepositoryFile(repo, "plan.md", first.sha);
    assert.equal(historical.content, "first\n");
    assert.equal(historical.ref, first.sha);
    const current = await readRepositoryFile(repo, "plan.md");
    assert.equal(current.content, "second\n");
  });

  test("refuses to read or write outside the repository", async () => {
    const repo = await localRepository();
    for (const bad of ["../escape.md", ".git/config", "docs/../../escape.md"]) {
      await assert.rejects(() => readRepositoryFile(repo, bad), /\.git|relative segments/, bad);
      await assert.rejects(
        () => writeRepositoryFile(repo, bad, "x"),
        /\.git|relative segments/,
        bad,
      );
    }
  });

  test("creates a directory that survives a reload", async () => {
    const repo = await localRepository();
    await createRepositoryDirectory(repo, "docs/empty");
    const entries = await listRepositoryTree(repo, "docs/empty");
    assert.deepEqual(
      entries.map((e) => e.name),
      [".gitkeep"],
    );
    await assert.rejects(() => createRepositoryDirectory(repo, "docs/empty"), /already exists/);
  });

  test("moves and deletes entries", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "old.md", "content");
    await moveRepositoryEntry(repo, "old.md", "docs/new.md");
    assert.equal((await readRepositoryFile(repo, "docs/new.md")).content, "content");
    await assert.rejects(() => readRepositoryFile(repo, "old.md"), /not found/);

    await assert.rejects(() => moveRepositoryEntry(repo, "missing.md", "x.md"), /not found/);
    await writeRepositoryFile(repo, "occupied.md", "a");
    await assert.rejects(
      () => moveRepositoryEntry(repo, "docs/new.md", "occupied.md"),
      /already exists/,
    );

    await deleteRepositoryEntry(repo, "docs/new.md");
    await assert.rejects(() => readRepositoryFile(repo, "docs/new.md"), /not found/);
    await assert.rejects(() => deleteRepositoryEntry(repo, "docs/new.md"), /not found/);
  });
});

// ──────────────────────────── version control ───────────────────────────

describe("committing", () => {
  test("commits every change and records it in history", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "a.md", "a\n");
    await writeRepositoryFile(repo, "b.md", "b\n");

    const before = await repositoryStatus(repo);
    assert.deepEqual(changePaths(before.changes), ["a.md", "b.md"]);
    assert.deepEqual(
      before.changes.map((c) => c.status),
      ["untracked", "untracked"],
    );

    const result = await commitRepositoryChanges(repo, { message: "Add two notes" });
    assert.ok(result);
    assert.match(result.sha, /^[0-9a-f]{40}$/);

    const after = await repositoryStatus(repo);
    assert.deepEqual(after.changes, []);
    const commits = await repositoryLog(repo);
    assert.equal(commits[0].subject, "Add two notes");
  });

  test("commits only the paths it was given", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "wanted.md", "yes\n");
    await writeRepositoryFile(repo, "unwanted.md", "no\n");
    await commitRepositoryChanges(repo, { message: "Add one note", paths: ["wanted.md"] });

    const status = await repositoryStatus(repo);
    assert.deepEqual(changePaths(status.changes), ["unwanted.md"]);
  });

  test("attributes the commit to the Member who made it", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "note.md", "x\n");
    await commitRepositoryChanges(repo, {
      message: "Add a note",
      authorName: "Ada Lovelace",
      authorEmail: "ada@example.com",
    });
    const commits = await repositoryLog(repo);
    assert.equal(commits[0].authorName, "Ada Lovelace");
    assert.equal(commits[0].authorEmail, "ada@example.com");
  });

  test("returns null rather than making an empty commit", async () => {
    const repo = await localRepository();
    assert.equal(await commitRepositoryChanges(repo, { message: "Nothing here" }), null);
  });

  test("refuses a blank message", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "x.md", "x");
    await assert.rejects(
      () => commitRepositoryChanges(repo, { message: "   " }),
      /commit message is required/,
    );
  });

  test("records a deletion", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "gone.md", "here\n");
    await commitRepositoryChanges(repo, { message: "Add a note" });
    await deleteRepositoryEntry(repo, "gone.md");

    const status = await repositoryStatus(repo);
    assert.deepEqual(
      status.changes.map((c) => c.status),
      ["deleted"],
    );
    assert.ok(await commitRepositoryChanges(repo, { message: "Remove the note" }));
    assert.deepEqual((await repositoryStatus(repo)).changes, []);
  });
});

describe("discarding", () => {
  test("restores a tracked file and removes an untracked one", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "tracked.md", "original\n");
    await commitRepositoryChanges(repo, { message: "Add a note" });
    await writeRepositoryFile(repo, "tracked.md", "edited\n");
    await writeRepositoryFile(repo, "untracked.md", "new\n");

    await discardRepositoryChanges(repo, ["tracked.md", "untracked.md"]);

    assert.equal((await readRepositoryFile(repo, "tracked.md")).content, "original\n");
    await assert.rejects(() => readRepositoryFile(repo, "untracked.md"), /not found/);
    assert.deepEqual((await repositoryStatus(repo)).changes, []);
  });

  test("refuses to discard nothing in particular", async () => {
    const repo = await localRepository();
    await assert.rejects(() => discardRepositoryChanges(repo, []), /Select what to discard/);
  });

  test("leaves files it was not asked about alone", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "keep.md", "keep\n");
    await writeRepositoryFile(repo, "drop.md", "drop\n");
    await discardRepositoryChanges(repo, ["drop.md"]);
    assert.equal((await readRepositoryFile(repo, "keep.md")).content, "keep\n");
  });
});

describe("diffs", () => {
  test("shows an untracked file's whole content as additions", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "new.md", "one\ntwo\n");
    const diff = await repositoryWorkingDiff(repo);
    assert.match(diff.patch, /diff --git a\/new\.md b\/new\.md/);
    assert.match(diff.patch, /new file mode/);
    assert.match(diff.patch, /\+one/);
    assert.match(diff.patch, /\+two/);
    assert.equal(diff.insertions, 2);
  });

  test("marks a new file with no trailing newline", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "nonewline.md", "just one line");
    const diff = await repositoryWorkingDiff(repo);
    assert.match(diff.patch, /\\ No newline at end of file/);
  });

  test("shows an edit to a tracked file", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "plan.md", "before\n");
    await commitRepositoryChanges(repo, { message: "Add the plan" });
    await writeRepositoryFile(repo, "plan.md", "after\n");

    const diff = await repositoryWorkingDiff(repo);
    assert.match(diff.patch, /-before/);
    assert.match(diff.patch, /\+after/);
    assert.equal(diff.insertions, 1);
    assert.equal(diff.deletions, 1);
    assert.equal(diff.filesChanged, 1);
  });

  test("narrows to one path when asked", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "one.md", "one\n");
    await writeRepositoryFile(repo, "two.md", "two\n");
    const diff = await repositoryWorkingDiff(repo, "one.md");
    assert.match(diff.patch, /one\.md/);
    assert.ok(!diff.patch.includes("two.md"));
  });

  test("shows the diff of a single commit with its metadata", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "plan.md", "v1\n");
    const first = await commitRepositoryChanges(repo, { message: "Add the plan" });
    assert.ok(first);

    const detail = await repositoryCommitDiff(repo, first.sha);
    assert.equal(detail.commit?.subject, "Add the plan");
    assert.match(detail.patch, /\+v1/);
  });

  test("reports a clean tree as an empty diff", async () => {
    const repo = await localRepository();
    const diff = await repositoryWorkingDiff(repo);
    assert.equal(diff.patch, "");
    assert.equal(diff.filesChanged, 0);
  });
});

describe("history", () => {
  test("returns commits newest first and respects the limit", async () => {
    const repo = await localRepository();
    for (const n of [1, 2, 3]) {
      await writeRepositoryFile(repo, `note-${n}.md`, `${n}\n`);
      await commitRepositoryChanges(repo, { message: `Add note ${n}` });
    }
    const commits = await repositoryLog(repo, { limit: 2 });
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["Add note 3", "Add note 2"],
    );
  });

  test("narrows history to one file", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "a.md", "a\n");
    await commitRepositoryChanges(repo, { message: "Add a" });
    await writeRepositoryFile(repo, "b.md", "b\n");
    await commitRepositoryChanges(repo, { message: "Add b" });

    const commits = await repositoryLog(repo, { filePath: "a.md" });
    assert.deepEqual(
      commits.map((c) => c.subject),
      ["Add a"],
    );
  });
});

describe("branches", () => {
  test("creates, switches, and lists branches", async () => {
    const repo = await localRepository();
    await createRepositoryBranch(repo, "feature/editor");
    assert.equal((await repositoryStatus(repo)).branch, "feature/editor");

    const branches = await repositoryBranches(repo);
    const names = branches.map((b) => b.name).sort();
    assert.deepEqual(names, ["feature/editor", "main"]);
    assert.equal(branches.find((b) => b.name === "feature/editor")?.current, true);

    await checkoutRepositoryBranch(repo, "main");
    assert.equal((await repositoryStatus(repo)).branch, "main");
  });

  test("refuses an unsafe branch name before Git ever sees it", async () => {
    const repo = await localRepository();
    await assert.rejects(
      () => createRepositoryBranch(repo, "--upload-pack=touch /tmp/pwned"),
      /branch name/i,
    );
    await assert.rejects(() => checkoutRepositoryBranch(repo, "-b"), /branch name/i);
  });

  test("reports a branch that does not exist", async () => {
    const repo = await localRepository();
    await assert.rejects(() => checkoutRepositoryBranch(repo, "nope"), /does not exist/);
  });

  test("merges a branch back into the current one", async () => {
    const repo = await localRepository();
    await createRepositoryBranch(repo, "work");
    await writeRepositoryFile(repo, "from-branch.md", "branch work\n");
    await commitRepositoryChanges(repo, { message: "Do the work" });
    await checkoutRepositoryBranch(repo, "main");
    await assert.rejects(() => readRepositoryFile(repo, "from-branch.md"), /not found/);

    const result = await mergeBranchIntoCurrent(repo, "work");
    assert.equal(result.merged, true);
    assert.equal((await readRepositoryFile(repo, "from-branch.md")).content, "branch work\n");
  });

  test("refuses to merge over uncommitted work", async () => {
    const repo = await localRepository();
    await createRepositoryBranch(repo, "work");
    await writeRepositoryFile(repo, "branch.md", "x\n");
    await commitRepositoryChanges(repo, { message: "Branch work" });
    await checkoutRepositoryBranch(repo, "main");
    await writeRepositoryFile(repo, "mine.md", "unsaved\n");

    await assert.rejects(() => mergeBranchIntoCurrent(repo, "work"), /Commit or discard/);
  });

  test("aborts a conflicting merge instead of leaving the tree half-merged", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "shared.md", "base\n");
    await commitRepositoryChanges(repo, { message: "Add the shared note" });

    await createRepositoryBranch(repo, "theirs");
    await writeRepositoryFile(repo, "shared.md", "theirs\n");
    await commitRepositoryChanges(repo, { message: "Their edit" });

    await checkoutRepositoryBranch(repo, "main");
    await writeRepositoryFile(repo, "shared.md", "ours\n");
    await commitRepositoryChanges(repo, { message: "Our edit" });

    await assert.rejects(() => mergeBranchIntoCurrent(repo, "theirs"), /conflicts/);
    // The merge must be fully unwound: no conflict markers, no MERGE_HEAD.
    assert.equal((await readRepositoryFile(repo, "shared.md")).content, "ours\n");
    assert.deepEqual((await repositoryStatus(repo)).changes, []);
    assert.equal(
      fs.existsSync(path.join(repositoryCheckoutPath(repo), ".git", "MERGE_HEAD")),
      false,
    );
  });

  test("reports an already-merged branch as no change", async () => {
    const repo = await localRepository();
    await createRepositoryBranch(repo, "same");
    await checkoutRepositoryBranch(repo, "main");
    const result = await mergeBranchIntoCurrent(repo, "same");
    assert.equal(result.alreadyUpToDate, true);
  });
});

describe("a repository with no remote", () => {
  test("cannot be pushed or pulled, and says why", async () => {
    const repo = await localRepository();
    await assert.rejects(() => pushRepositoryBranch(repo, "main"), /no remote/);
    await assert.rejects(() => pullRepositoryBranch(repo, "main"), /no remote/);
  });
});

// ──────────────────────────── remote repositories ───────────────────────

/**
 * A dumb-HTTP Git server over a real bare repository on disk. Enough to prove
 * the clone and fetch paths work through the hardened server-owned runner;
 * pushing needs a smart server and is covered by its guard tests instead.
 */
describe("a remote repository", () => {
  let origin: string;
  let server: http.Server;
  let baseUrl: string;
  let fixtureRoot: string;

  before(async () => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-origin-"));
    const work = path.join(fixtureRoot, "work");
    origin = path.join(fixtureRoot, "origin.git");
    fs.mkdirSync(work, { recursive: true });
    const git = (args: string[], cwd: string) =>
      exec("git", args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.com",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.com",
        },
      });
    await git(["init", "--quiet", "--initial-branch=main"], work);
    fs.writeFileSync(path.join(work, "README.md"), "# Upstream\n");
    await git(["add", "-A"], work);
    await git(["commit", "--quiet", "-m", "Initial commit"], work);
    await git(["clone", "--bare", "--quiet", work, origin], fixtureRoot);
    // Dumb HTTP transport reads these instead of negotiating.
    await git(["update-server-info"], origin);

    server = http.createServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const candidate = path.resolve(origin, `.${decodeURIComponent(pathname)}`);
      const relative = path.relative(path.resolve(origin), candidate);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        res.writeHead(404).end();
        return;
      }
      fs.readFile(candidate, (error, body) => {
        if (error) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  test("clones on first use, with command execution switched off", async () => {
    assert.equal(codingTools.executionMode, "disabled");
    const repo = makeRepository({ origin: "remote", kind: "code", gitUrl: `${baseUrl}/` });
    await ensureRepositoryWorkspace(repo);

    assert.equal(repositoryCheckoutExists(repo), true);
    const file = await readRepositoryFile(repo, "README.md");
    assert.equal(file.content, "# Upstream\n");
    const commits = await repositoryLog(repo);
    assert.equal(commits[0].subject, "Initial commit");
  });

  test("refuses a clone URL that carries credentials or options", async () => {
    const repo = makeRepository({
      origin: "remote",
      gitUrl: "https://user:secret@example.invalid/acme/repo.git",
    });
    await assert.rejects(() => ensureRepositoryWorkspace(repo), /plain http/);
  });

  test("refuses to push a branch whose name Git would read as an option", async () => {
    const repo = makeRepository({ origin: "remote", gitUrl: `${baseUrl}/` });
    await ensureRepositoryWorkspace(repo);
    await assert.rejects(() => pushRepositoryBranch(repo, "--exec=whoami"), /branch name/i);
  });

  test("reports a missing HTTPS token instead of pushing anonymously", async () => {
    const repo = makeRepository({
      origin: "remote",
      gitUrl: "https://example.invalid/acme/repo.git",
      authMode: "https",
      encryptedToken: null,
    });
    // The checkout has to exist before push can be reached at all.
    const other = makeRepository({ origin: "remote", gitUrl: `${baseUrl}/` });
    await ensureRepositoryWorkspace(other);
    Object.assign(repo, { id: other.id, companyId: other.companyId });
    await assert.rejects(() => pushRepositoryBranch(repo, "main"), /token is missing/);
  });

  test("reports a branch the remote does not have when pulling", async () => {
    const repo = makeRepository({ origin: "remote", gitUrl: `${baseUrl}/` });
    await ensureRepositoryWorkspace(repo);
    await assert.rejects(() => pullRepositoryBranch(repo, "nonexistent"), /does not exist/);
  });
});

// ─────────────────────── concurrency and containment ────────────────────

describe("safety", () => {
  afterEach(() => {});

  test("serializes concurrent commits on one repository", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "a.md", "a\n");
    await writeRepositoryFile(repo, "b.md", "b\n");

    const [first, second] = await Promise.all([
      commitRepositoryChanges(repo, { message: "First", paths: ["a.md"] }),
      commitRepositoryChanges(repo, { message: "Second", paths: ["b.md"] }),
    ]);
    assert.ok(first, "the first commit must land");
    assert.ok(second, "the second must land too, not race the first's index");

    const commits = await repositoryLog(repo, { limit: 3 });
    assert.deepEqual(
      commits.slice(0, 2).map((c) => c.subject).sort(),
      ["First", "Second"],
    );
  });

  test("a symlink into the checkout cannot be used to read outside it", async () => {
    const repo = await localRepository();
    const secret = path.join(dataDir, "outside-secret.txt");
    fs.writeFileSync(secret, "do not read me");
    fs.symlinkSync(secret, path.join(repositoryCheckoutPath(repo), "sneaky.txt"));

    await assert.rejects(() => readRepositoryFile(repo, "sneaky.txt"), /escapes the repository/);
    // And the tree listing simply does not offer it.
    const entries = await listRepositoryTree(repo, "");
    assert.ok(!entries.some((e) => e.name === "sneaky.txt"));
  });

  test("a symlinked directory cannot be written through", async () => {
    const repo = await localRepository();
    const outside = path.join(dataDir, "outside-dir");
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(repositoryCheckoutPath(repo), "out"));

    await assert.rejects(
      () => writeRepositoryFile(repo, "out/planted.md", "x"),
      /escapes the repository/,
    );
    assert.equal(fs.existsSync(path.join(outside, "planted.md")), false);
  });
});

// ──────────────────── ignored files and searching ───────────────────────

describe("the file tree and .gitignore", () => {
  async function repositoryWithIgnores() {
    const repo = await localRepository();
    await writeRepositoryFile(repo, ".gitignore", "node_modules/\ndist/\n*.log\n");
    await writeRepositoryFile(repo, "src/index.ts", "export const x = 1;\n");
    await writeRepositoryFile(repo, "node_modules/left-pad/index.js", "module.exports = 1;\n");
    await writeRepositoryFile(repo, "dist/bundle.js", "console.log(1);\n");
    await writeRepositoryFile(repo, "debug.log", "noise\n");
    return repo;
  }

  test("hides ignored entries by default, which is what makes a code repo usable", async () => {
    const repo = await repositoryWithIgnores();
    const entries = await listRepositoryTree(repo, "");
    const names = entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, [".gitignore", "README.md", "src"]);
    assert.ok(!names.includes("node_modules"), "node_modules would bury the real files");
    assert.ok(!names.includes("dist"));
    assert.ok(!names.includes("debug.log"));
  });

  test("shows them, marked, when explicitly asked", async () => {
    const repo = await repositoryWithIgnores();
    const entries = await listRepositoryTree(repo, "", { showIgnored: true });
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    assert.equal(byName.get("node_modules")?.ignored, true);
    assert.equal(byName.get("dist")?.ignored, true);
    assert.equal(byName.get("debug.log")?.ignored, true);
    assert.equal(byName.get("src")?.ignored, false);
    assert.equal(byName.get(".gitignore")?.ignored, false);
  });

  test("filters inside a subdirectory too", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, ".gitignore", "src/generated/\n");
    await writeRepositoryFile(repo, "src/keep.ts", "export const a = 1;\n");
    await writeRepositoryFile(repo, "src/generated/api.ts", "export const b = 2;\n");
    const entries = await listRepositoryTree(repo, "src");
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ["keep.ts"],
    );
  });

  test("a repository with no .gitignore hides nothing", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "a.md", "a\n");
    await writeRepositoryFile(repo, "b.md", "b\n");
    const entries = await listRepositoryTree(repo, "");
    // The two written here plus the README every local repository starts with.
    assert.equal(entries.length, 3);
    assert.ok(entries.every((entry) => entry.ignored === false));
  });
});

describe("searching a repository", () => {
  async function searchable() {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "docs/plan.md", "# Plan\n\nGrow revenue in Q3.\n");
    await writeRepositoryFile(repo, "docs/notes.md", "Revenue is the theme.\n");
    await writeRepositoryFile(repo, ".gitignore", "vendor/\n");
    await writeRepositoryFile(repo, "vendor/big.md", "revenue revenue revenue\n");
    await commitRepositoryChanges(repo, { message: "Add the docs" });
    return repo;
  }

  test("finds matches with their path and line number", async () => {
    const repo = await searchable();
    const { matches } = await searchRepository(repo, "revenue");
    const paths = matches.map((match) => match.path).sort();
    assert.deepEqual(paths, ["docs/notes.md", "docs/plan.md"]);
    const plan = matches.find((match) => match.path === "docs/plan.md");
    assert.equal(plan?.line, 3);
    assert.match(plan?.text ?? "", /Grow revenue in Q3\./);
  });

  test("is case-insensitive", async () => {
    const repo = await searchable();
    const upper = await searchRepository(repo, "REVENUE");
    assert.ok(upper.matches.length >= 2);
  });

  test("skips ignored files, so vendored code does not drown the results", async () => {
    const repo = await searchable();
    const { matches } = await searchRepository(repo, "revenue");
    assert.ok(!matches.some((match) => match.path.startsWith("vendor/")));
  });

  test("finds a file that has never been committed", async () => {
    const repo = await searchable();
    await writeRepositoryFile(repo, "fresh.md", "revenue arrives here too\n");
    const { matches } = await searchRepository(repo, "arrives here");
    assert.deepEqual(
      matches.map((match) => match.path),
      ["fresh.md"],
    );
  });

  test("returns nothing rather than failing when there are no matches", async () => {
    const repo = await searchable();
    const result = await searchRepository(repo, "nothing matches this string");
    assert.deepEqual(result.matches, []);
    assert.equal(result.truncated, false);
  });

  test("refuses an empty query instead of returning the whole repository", async () => {
    const repo = await searchable();
    await assert.rejects(() => searchRepository(repo, "   "), /search for/);
  });

  test("treats the query as literal text, not a pattern", async () => {
    const repo = await localRepository();
    await writeRepositoryFile(repo, "code.ts", "const re = /a.*b/;\nconst plain = 'a.*b';\n");
    const { matches } = await searchRepository(repo, "a.*b");
    assert.equal(matches.length, 2, "a regex search would have matched differently");
  });

  test("honours the limit", async () => {
    const repo = await localRepository();
    const lines = Array.from({ length: 40 }, (_, i) => `hit ${i}`).join("\n");
    await writeRepositoryFile(repo, "many.md", `${lines}\n`);
    const { matches, truncated } = await searchRepository(repo, "hit", 5);
    assert.equal(matches.length, 5);
    assert.equal(truncated, true);
  });
});

describe("publishing a local repository to a remote", () => {
  test("refuses a remote URL that carries credentials", async () => {
    const repo = await localRepository();
    await assert.rejects(
      () => publishRepositoryToRemote(repo, "https://user:secret@example.invalid/acme/web.git"),
      /plain http/,
    );
  });

  test("refuses a repository that has no branches to publish", async () => {
    const repo = makeRepository();
    // Never materialized, so there is nothing to push.
    await assert.rejects(
      () => publishRepositoryToRemote(repo, "https://example.invalid/acme/web.git"),
      /./,
    );
  });
});
