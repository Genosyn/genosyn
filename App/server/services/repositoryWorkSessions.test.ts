import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import type { ChatResult, chatWithEmployee } from "./chat.js";
import {
  ensureRepositoryWorkspace,
  readRepositoryFile,
  repositoryLog,
  repositoryStatus,
  writeRepositoryFile,
  commitRepositoryChanges,
} from "./repositoryWorkspace.js";
import {
  composeWorkSystemPrompt,
  createRepositoryWorkSession,
  discardRepositoryWorkSession,
  publishRepositoryWorkSession,
  repositoryWorkSessionDiff,
  resolveSessionCheckout,
  runRepositoryWorkSession,
  sessionBranchName,
  sessionCommit,
  sessionDeleteFile,
  sessionListFiles,
  sessionReadFile,
  sessionSearch,
  sessionWriteFile,
  sessionWorktreePath,
  startRepositoryWorkSession,
} from "./repositoryWorkSessions.js";

/**
 * AI work sessions, end to end, with the model turn stubbed.
 *
 * The model is the one part that cannot run in a test, so `runChat` is
 * injected. Everything else is real: a real worktree, real Git, real commits,
 * and the real publish path. That is deliberate — the valuable behaviour here
 * is what happens to the *repository*, not what the model says.
 */

let dataDir: string;
const originalDataDir = config.dataDir;
const codingTools = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const originalCodingTools = { ...codingTools };

before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-sessions-"));
  (config as { dataDir: string }).dataDir = dataDir;
  // Sessions must work on an install with command execution switched off.
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.allowUnsafeHostExecution = false;
});

after(async () => {
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  Object.assign(codingTools, originalCodingTools);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let company: Company;
let requester: User;
let employee: AIEmployee;
let repository: Repository;

beforeEach(async () => {
  await resetTestDb();
  requester = await insert(User, {
    email: "member@example.com",
    name: "Member",
    passwordHash: "x",
    sessionVersion: 1,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: requester.id });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Engineer",
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-test",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  repository = await insert(Repository, {
    companyId: company.id,
    name: "Strategy",
    slug: "strategy",
    description: "",
    origin: "local",
    kind: "documents",
    gitUrl: "",
    defaultBranch: "main",
    authMode: "none",
    committerName: "Genosyn",
    committerEmail: "repositories@genosyn.local",
    lastSyncStatus: "unknown",
    lastSyncError: "",
  });
});

async function grantAccess(level: "read" | "write" = "write"): Promise<void> {
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: level,
  });
}

/**
 * A stand-in for the model turn. `work` runs with the session's own worktree,
 * exactly where the real `repository_*` tools would operate.
 */
function stubChat(
  work: (directory: string) => Promise<void> | void,
  result: Partial<ChatResult> = {},
): typeof chatWithEmployee {
  return (async (_companyId, _employeeId, _message, _history, options) => {
    const sessionId = (options as { repositoryWorkSessionId?: string })?.repositoryWorkSessionId;
    assert.ok(sessionId, "the turn must carry its work-session id");
    const checkout = await resolveSessionCheckout(company.id, sessionId);
    await work(checkout.directory);
    return {
      status: "ok",
      reply: "Done.",
      attachmentIds: [],
      sidecars: {},
      ...result,
    } as ChatResult;
  }) as typeof chatWithEmployee;
}

async function start(runChat: typeof chatWithEmployee, instruction = "Update the plan") {
  return startRepositoryWorkSession({
    companyId: company.id,
    repositoryId: repository.id,
    employeeId: employee.id,
    instruction,
    requesterUserId: requester.id,
    requesterSessionVersion: 1,
    runChat,
  });
}

// ────────────────────────────── guards ──────────────────────────────────

describe("starting a session", () => {
  test("refuses an employee with no grant on the repository", async () => {
    await assert.rejects(
      () => start(stubChat(() => {})),
      /not been granted access/,
    );
  });

  test("accepts a read grant — a session works on its own branch, not the trunk", async () => {
    await grantAccess("read");
    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "note.md", "hello\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.equal(session.status, "ready");
  });

  test("refuses an unknown repository or employee", async () => {
    await assert.rejects(
      () =>
        startRepositoryWorkSession({
          companyId: company.id,
          repositoryId: "00000000-0000-4000-8000-000000000000",
          employeeId: employee.id,
          instruction: "x",
          requesterUserId: requester.id,
          requesterSessionVersion: 1,
          runChat: stubChat(() => {}),
        }),
      /Repository not found/,
    );
  });

  test("refuses an employee with no AI Model connected", async () => {
    await grantAccess();
    await AppDataSource.getRepository(AIModel).delete({ employeeId: employee.id });
    await assert.rejects(() => start(stubChat(() => {})), /no AI Model/);
  });

  test("refuses on shared SaaS, where repositories are read-only", async () => {
    await grantAccess();
    const security = config.security as { multiTenant: boolean };
    const wasMultiTenant = security.multiTenant;
    security.multiTenant = true;
    try {
      await assert.rejects(() => start(stubChat(() => {})), /read-only in shared SaaS mode/);
      assert.equal(
        await AppDataSource.getRepository(RepositoryWorkSession).count(),
        0,
        "a refused session must not leave a row behind",
      );
    } finally {
      security.multiTenant = wasMultiTenant;
    }
  });
});

// ───────────────────── starting without waiting for it ──────────────────

/**
 * The split that lets a chat turn start a session.
 *
 * A chat turn cannot sit and wait for work allowed to take hours, so
 * `start_repository_work_session` awaits only the first half and hands the
 * Member a session id. Two properties make that honest: the id is real before
 * the model turn begins, and everything that could refuse the request has
 * already refused it.
 */
describe("creating a session without running it", () => {
  test("hands back a running row before the employee's turn starts", async () => {
    await grantAccess();
    const prepared = await createRepositoryWorkSession({
      companyId: company.id,
      repositoryId: repository.id,
      employeeId: employee.id,
      instruction: "Update the plan",
      requesterUserId: requester.id,
      requesterSessionVersion: 1,
    });

    assert.ok(prepared.session.id);
    assert.equal(prepared.session.status, "running");
    assert.equal(prepared.session.instruction, "Update the plan");
    assert.equal(prepared.session.requestedByUserId, requester.id);
    assert.equal(prepared.repo.id, repository.id);
    assert.equal(prepared.employee.id, employee.id);
    // Nothing has run yet, so there is no branch to point at.
    assert.equal(prepared.session.branch, null);
  });

  test("every refusal happens before a row exists, so there is none to explain", async () => {
    await assert.rejects(
      () =>
        createRepositoryWorkSession({
          companyId: company.id,
          repositoryId: repository.id,
          employeeId: employee.id,
          instruction: "Update the plan",
          requesterUserId: requester.id,
          requesterSessionVersion: 1,
        }),
      /not been granted access/,
    );
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 0);
  });

  test("running the prepared session finishes the same row it handed back", async () => {
    await grantAccess();
    const prepared = await createRepositoryWorkSession({
      companyId: company.id,
      repositoryId: repository.id,
      employeeId: employee.id,
      instruction: "Update the plan",
      requesterUserId: requester.id,
      requesterSessionVersion: 1,
      runChat: stubChat(async (directory) => {
        sessionWriteFile(directory, "note.md", "hello\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    });

    const finished = await runRepositoryWorkSession(prepared);

    assert.equal(finished.id, prepared.session.id);
    assert.equal(finished.status, "ready");
    assert.equal(finished.branch, sessionBranchName("ada", prepared.session.id));
    assert.equal(
      await AppDataSource.getRepository(RepositoryWorkSession).count(),
      1,
      "the two halves must share one row, not create a second",
    );
  });
});

// ──────────────────────────── the work itself ───────────────────────────

describe("a session that does work", () => {
  beforeEach(async () => {
    await grantAccess();
  });

  test("commits on its own branch and reports what changed", async () => {
    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n\nGrow revenue.\n");
        await sessionCommit(repository, directory, "Add the plan");
      }),
    );

    assert.equal(session.status, "ready");
    assert.equal(session.branch, sessionBranchName("ada", session.id));
    assert.ok(session.baseCommit);
    assert.ok(session.headCommit);
    assert.notEqual(session.headCommit, session.baseCommit);
    assert.equal(session.filesChanged, 1);
    assert.equal(session.insertions, 3);
    assert.equal(session.reply, "Done.");
    assert.ok(session.finishedAt);
  });

  test("leaves the Member's checkout untouched until it is published", async () => {
    await ensureRepositoryWorkspace(repository);
    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n");
        await sessionCommit(repository, directory, "Add the plan");
      }),
    );
    assert.equal(session.status, "ready");
    await assert.rejects(() => readRepositoryFile(repository, "docs/plan.md"), /not found/);
    assert.deepEqual((await repositoryStatus(repository)).changes, []);
  });

  test("records an empty outcome when the employee commits nothing", async () => {
    const session = await start(stubChat(() => {}));
    assert.equal(session.status, "empty");
    assert.equal(session.filesChanged, 0);
    assert.equal(
      fs.existsSync(sessionWorktreePath(repository, session.id)),
      false,
      "an empty session leaves no worktree behind",
    );
  });

  test("records uncommitted work as empty — it is discarded, and the row says so", async () => {
    const session = await start(
      stubChat((directory) => {
        sessionWriteFile(directory, "forgotten.md", "never committed\n");
      }),
    );
    assert.equal(session.status, "empty");
  });

  test("records a failed turn with the model's own explanation", async () => {
    const session = await start(
      stubChat(() => {}, { status: "error", reply: "The model is unavailable." }),
    );
    assert.equal(session.status, "failed");
    assert.match(session.error, /model is unavailable/);
    assert.equal(fs.existsSync(sessionWorktreePath(repository, session.id)), false);
  });

  test("records a thrown error rather than leaving the session running forever", async () => {
    const session = await start((() => {
      throw new Error("boom");
    }) as typeof chatWithEmployee);
    assert.equal(session.status, "failed");
    assert.match(session.error, /boom/);
  });

  test("gives two concurrent sessions separate branches and worktrees", async () => {
    const [first, second] = await Promise.all([
      start(
        stubChat(async (directory) => {
          sessionWriteFile(directory, "one.md", "one\n");
          await sessionCommit(repository, directory, "Add one");
        }),
      ),
      start(
        stubChat(async (directory) => {
          sessionWriteFile(directory, "two.md", "two\n");
          await sessionCommit(repository, directory, "Add two");
        }),
      ),
    ]);
    assert.notEqual(first.branch, second.branch);
    assert.equal(first.status, "ready");
    assert.equal(second.status, "ready");
  });
});

// ──────────────────────────── review and publish ────────────────────────

describe("reviewing and publishing", () => {
  beforeEach(async () => {
    await grantAccess();
  });

  async function readySession() {
    return start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n\nShip it.\n");
        await sessionCommit(repository, directory, "Add the plan");
      }),
    );
  }

  test("shows the Member the diff before they decide", async () => {
    const session = await readySession();
    const diff = await repositoryWorkSessionDiff(session);
    assert.match(diff.patch, /docs\/plan\.md/);
    assert.match(diff.patch, /\+# Plan/);
    assert.equal(diff.filesChanged, 1);
    assert.deepEqual(
      diff.commits.map((c) => c.subject),
      ["Add the plan"],
    );
  });

  test("merges the work into the Member's checkout on publish", async () => {
    const session = await readySession();
    const published = await publishRepositoryWorkSession(session.id, { push: false });

    assert.equal(published.status, "published");
    const file = await readRepositoryFile(repository, "docs/plan.md");
    assert.equal(file.content, "# Plan\n\nShip it.\n");
    const commits = await repositoryLog(repository);
    assert.ok(commits.some((c) => c.subject === "Add the plan"));
    assert.equal(
      fs.existsSync(sessionWorktreePath(repository, session.id)),
      false,
      "the worktree is cleaned up once the work has landed",
    );
  });

  test("does not try to push a repository with no remote", async () => {
    const session = await readySession();
    const published = await publishRepositoryWorkSession(session.id, { push: true });
    assert.equal(published.status, "published");
    assert.equal(published.publishedBranch, null);
  });

  test("refuses to publish twice", async () => {
    const session = await readySession();
    await publishRepositoryWorkSession(session.id, { push: false });
    await assert.rejects(
      () => publishRepositoryWorkSession(session.id, { push: false }),
      /no reviewed work/,
    );
  });

  test("refuses to publish a session that produced nothing", async () => {
    const session = await start(stubChat(() => {}));
    await assert.rejects(
      () => publishRepositoryWorkSession(session.id, { push: false }),
      /no reviewed work/,
    );
  });

  test("refuses to publish over the Member's own uncommitted edits", async () => {
    const session = await readySession();
    await writeRepositoryFile(repository, "mine.md", "unsaved\n");
    await assert.rejects(
      () => publishRepositoryWorkSession(session.id, { push: false }),
      /Commit or discard/,
    );
  });

  test("discarding removes the branch and the worktree", async () => {
    const session = await readySession();
    const discarded = await discardRepositoryWorkSession(session.id);
    assert.equal(discarded.status, "discarded");
    assert.equal(fs.existsSync(sessionWorktreePath(repository, session.id)), false);
    await assert.rejects(() => readRepositoryFile(repository, "docs/plan.md"), /not found/);
  });

  test("a conflicting session is refused rather than merged badly", async () => {
    await ensureRepositoryWorkspace(repository);
    await writeRepositoryFile(repository, "shared.md", "base\n");
    await commitRepositoryChanges(repository, { message: "Add the shared note" });

    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "shared.md", "the employee's version\n");
        await sessionCommit(repository, directory, "Rewrite the note");
      }),
    );
    await writeRepositoryFile(repository, "shared.md", "the human's version\n");
    await commitRepositoryChanges(repository, { message: "Rewrite it differently" });

    await assert.rejects(
      () => publishRepositoryWorkSession(session.id, { push: false }),
      /conflicts/,
    );
    assert.equal(
      (await readRepositoryFile(repository, "shared.md")).content,
      "the human's version\n",
    );
  });
});

// ─────────────────────────── the tool surface ───────────────────────────

describe("the tools an employee is given", () => {
  let directory: string;

  beforeEach(async () => {
    await grantAccess();
    const session = await start(
      stubChat(async (dir) => {
        directory = dir;
        sessionWriteFile(dir, "README.md", "# Read me\n");
        sessionWriteFile(dir, "docs/plan.md", "# Plan\n\nGrow revenue in Q3.\n");
        // Commit, so the session ends `ready` and keeps its worktree — an
        // empty session's worktree is cleaned up, by design.
        await sessionCommit(repository, dir, "Add the first documents");
      }),
    );
    assert.equal(session.status, "ready");
  });

  test("lists, reads, writes, and deletes within the worktree", () => {
    assert.deepEqual(
      sessionListFiles(directory, "").map((e) => `${e.type}:${e.name}`),
      ["directory:docs", "file:README.md"],
    );
    assert.equal(sessionReadFile(directory, "docs/plan.md"), "# Plan\n\nGrow revenue in Q3.\n");

    sessionWriteFile(directory, "docs/plan.md", "# Plan\n\nRewritten.\n");
    assert.equal(sessionReadFile(directory, "docs/plan.md"), "# Plan\n\nRewritten.\n");

    sessionDeleteFile(directory, "README.md");
    assert.throws(() => sessionReadFile(directory, "README.md"));
  });

  test("searches case-insensitively and reports where the match is", () => {
    const hits = sessionSearch(directory, "grow REVENUE");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].path, "docs/plan.md");
    assert.equal(hits[0].line, 3);
    assert.match(hits[0].text, /Grow revenue in Q3\./);
  });

  test("search never looks inside .git", () => {
    // "ref:" appears in .git/HEAD of every repository.
    const hits = sessionSearch(directory, "ref:");
    assert.deepEqual(hits, []);
  });

  test("refuses an empty search", () => {
    assert.throws(() => sessionSearch(directory, "   "), /search for/);
  });

  test("cannot write into .git and so cannot make the checkout hostile to Git", () => {
    for (const bad of [".git/config", ".git/hooks/pre-commit", "docs/../.git/config"]) {
      assert.throws(() => sessionWriteFile(directory, bad, "x"), /\.git|relative segments/, bad);
    }
    assert.equal(
      fs.readFileSync(path.join(directory, ".git"), "utf8").startsWith("gitdir:"),
      true,
      "the worktree's .git pointer is untouched",
    );
  });

  test("cannot escape the worktree", () => {
    for (const bad of ["../../escape.md", "docs/../../../escape.md"]) {
      assert.throws(() => sessionWriteFile(directory, bad, "x"), /relative segments/, bad);
      assert.throws(() => sessionReadFile(directory, bad), /relative segments/, bad);
      assert.throws(() => sessionDeleteFile(directory, bad), /relative segments/, bad);
    }
  });

  test("refuses to write more than the cap", () => {
    assert.throws(
      () => sessionWriteFile(directory, "huge.md", "x".repeat(300 * 1024)),
      /too large/,
    );
  });

  test("refuses to read a binary file as text", () => {
    fs.writeFileSync(path.join(directory, "logo.png"), Buffer.from([0x89, 0x00, 0x01]));
    assert.throws(() => sessionReadFile(directory, "logo.png"), /binary/);
  });
});

describe("session authority", () => {
  test("a finished session stops answering its tools", async () => {
    await grantAccess();
    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "note.md", "x\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    await assert.rejects(
      () => resolveSessionCheckout(company.id, session.id),
      /already finished/,
    );
  });

  test("a session cannot be reached from another company", async () => {
    await grantAccess();
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: requester.id });
    let sessionId = "";
    await start(
      stubChat(async (_directory) => {
        const row = await AppDataSource.getRepository(RepositoryWorkSession).findOne({
          where: { repositoryId: repository.id },
          order: { createdAt: "DESC" },
        });
        sessionId = row?.id ?? "";
        await assert.rejects(
          () => resolveSessionCheckout(other.id, sessionId),
          /not found/,
          "another company must not resolve this session",
        );
      }),
    );
    assert.ok(sessionId);
  });
});

describe("the briefing an employee receives", () => {
  test("names the session and tells the employee it must commit", () => {
    const prompt = composeWorkSystemPrompt(repository, "session-123");
    assert.match(prompt, /session-123/);
    assert.match(prompt, /You must commit/);
    assert.match(prompt, /repository_write_file/);
  });

  test("briefs a documents repository differently from a code one", () => {
    const documents = composeWorkSystemPrompt({ ...repository, kind: "documents" }, "s");
    const code = composeWorkSystemPrompt({ ...repository, kind: "code" }, "s");
    assert.match(documents, /documents rather than software/);
    assert.match(code, /conventions of the surrounding code/);
    assert.ok(!documents.includes("cannot run tests"));
  });
});

describe("branch naming", () => {
  test("namespaces the branch by employee and session", () => {
    const name = sessionBranchName("ada", "abcdef12-3456-7890-abcd-ef1234567890");
    assert.equal(name, "genosyn/ada/abcdef12");
  });

  test("survives an employee slug that is not branch-safe", () => {
    assert.equal(sessionBranchName("Ada Lovelace!", "abcdef12-3456"), "genosyn/ada-lovelace/abcdef12");
    assert.equal(sessionBranchName("", "abcdef12-3456"), "genosyn/employee/abcdef12");
  });
});
