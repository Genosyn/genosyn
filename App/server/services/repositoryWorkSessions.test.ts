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
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  CHAT_HARD_TIMEOUT_MS,
  type ChatResult,
  type ChatTurn,
  type chatWithEmployee,
} from "./chat.js";
import {
  checkoutRepositoryBranch,
  createRepositoryBranch,
  ensureRepositoryWorkspace,
  readRepositoryFile,
  repositoryLog,
  repositoryStatus,
  writeRepositoryFile,
  commitRepositoryChanges,
} from "./repositoryWorkspace.js";
import {
  MAX_AGENTS_GUIDE_BYTES,
  MAX_REPLAYED_TURNS,
  composeTurnHistory,
  composeWorkSystemPrompt,
  createRepositoryWorkSession,
  deriveWorkSessionTitle,
  ensureSessionWorktree,
  liveRepositoryWorkSession,
  prepareWorkSessionRevision,
  readAgentsGuide,
  renameRepositoryWorkSession,
  REPOSITORY_SESSION_TOOLS,
  repositorySessionResidentTools,
  repositoryWorkSessionTurns,
  reviseRepositoryWorkSession,
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
    await assert.rejects(() => start(stubChat(() => {})), /not been granted access/);
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

// ────────────────────────── revising a session ──────────────────────────

/**
 * The half that makes a session a conversation.
 *
 * These tests are about continuity: the same branch, the same worktree, the
 * same employee, and a transcript it can remember. A revision that quietly
 * started again from the trunk would still look like it worked — the diff
 * would be plausible and the earlier work would simply be gone — so the
 * assertions are deliberately about *where* the commits land, not only that
 * some landed.
 */
describe("revising a session", () => {
  beforeEach(async () => {
    await grantAccess();
  });

  /** Capture what the revision's turn was handed, which is the whole point. */
  function recordingChat(
    seen: { message?: string; history?: ChatTurn[]; options?: Record<string, unknown> },
    work: (directory: string) => Promise<void> | void,
    result: Partial<ChatResult> = {},
  ): typeof chatWithEmployee {
    return (async (_companyId, _employeeId, message, history, options) => {
      seen.message = message;
      seen.history = history;
      seen.options = options as Record<string, unknown>;
      const sessionId = (options as { repositoryWorkSessionId?: string })?.repositoryWorkSessionId;
      assert.ok(sessionId);
      const checkout = await resolveSessionCheckout(company.id, sessionId);
      await work(checkout.directory);
      return {
        status: "ok",
        reply: "Revised.",
        attachmentIds: [],
        sidecars: {},
        ...result,
      } as ChatResult;
    }) as typeof chatWithEmployee;
  }

  async function revise(
    sessionId: string,
    runChat: typeof chatWithEmployee,
    instruction = "Also mention the risks",
    requesterUserId = requester.id,
  ) {
    return reviseRepositoryWorkSession({
      companyId: company.id,
      sessionId,
      instruction,
      requesterUserId,
      requesterSessionVersion: 1,
      runChat,
    });
  }

  async function firstTurn() {
    return start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n\nShip it.\n");
        await sessionCommit(repository, directory, "Add the plan");
      }),
    );
  }

  test("commits onto the same branch in the same working copy", async () => {
    const session = await firstTurn();
    const worktree = sessionWorktreePath(repository, session.id);
    const revised = await revise(
      session.id,
      recordingChat({}, async (directory) => {
        assert.equal(directory, worktree, "a revision must reuse the session's own worktree");
        assert.equal(
          sessionReadFile(directory, "docs/plan.md"),
          "# Plan\n\nShip it.\n",
          "the earlier turn's work is still there to build on",
        );
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n\nShip it.\n\n## Risks\n");
        await sessionCommit(repository, directory, "Note the risks");
      }),
    );

    assert.equal(revised.id, session.id);
    assert.equal(revised.branch, session.branch);
    assert.equal(revised.status, "ready");
    assert.equal(revised.baseCommit, session.baseCommit, "the branch point never moves");
    assert.notEqual(revised.headCommit, session.headCommit);
    assert.equal(revised.turnCount, 2);
    assert.equal(revised.reply, "Revised.");

    const diff = await repositoryWorkSessionDiff(revised);
    assert.equal(diff.filesChanged, 1);
    assert.deepEqual(diff.commits.map((commit) => commit.subject).sort(), [
      "Add the plan",
      "Note the risks",
    ]);
  });

  test("replays the earlier turns so the employee knows what it already did", async () => {
    const session = await firstTurn();
    const seen: { history?: ChatTurn[]; message?: string } = {};
    await revise(
      session.id,
      recordingChat(seen, async (directory) => {
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n\nShip it well.\n");
        await sessionCommit(repository, directory, "Tighten the wording");
      }),
    );

    assert.deepEqual(seen.history, [
      { role: "user", content: "Update the plan" },
      { role: "assistant", content: "Done." },
    ]);
    assert.match(seen.message ?? "", /Continue your work/);
    assert.match(seen.message ?? "", /Also mention the risks/);
  });

  test("records each turn's own changes as well as the session's", async () => {
    const session = await firstTurn();
    await revise(
      session.id,
      recordingChat({}, async (directory) => {
        sessionWriteFile(directory, "docs/risks.md", "# Risks\n");
        await sessionCommit(repository, directory, "Add the risks");
      }),
    );

    const turns = await repositoryWorkSessionTurns(session.id);
    assert.deepEqual(
      turns.map((turn) => turn.ordinal),
      [1, 2],
    );
    assert.equal(turns[0].instruction, "Update the plan");
    assert.equal(turns[0].reply, "Done.");
    assert.equal(turns[0].status, "ok");
    assert.equal(turns[0].filesChanged, 1);
    assert.equal(turns[1].instruction, "Also mention the risks");
    assert.equal(turns[1].status, "ok");
    assert.equal(
      turns[1].filesChanged,
      1,
      "the second turn touched one file, not both files the session has",
    );
    assert.equal(turns[1].baseCommit, turns[0].headCommit, "turns chain head to base");

    const session2 = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(session2.filesChanged, 2, "the session totals both turns");
  });

  test("tells the employee it is continuing, not starting over", async () => {
    const prompt = composeWorkSystemPrompt(repository, "s", { revision: true });
    assert.match(prompt, /follow-up/);
    assert.match(prompt, /read the files again/);
    assert.ok(!composeWorkSystemPrompt(repository, "s").includes("follow-up"));
  });

  test("rescues a session that committed nothing the first time", async () => {
    const session = await start(stubChat(() => {}));
    assert.equal(session.status, "empty");
    assert.equal(
      fs.existsSync(sessionWorktreePath(repository, session.id)),
      false,
      "an empty session leaves no worktree, so the revision has to rebuild one",
    );

    const revised = await revise(
      session.id,
      recordingChat({}, async (directory) => {
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n");
        await sessionCommit(repository, directory, "Write the plan after all");
      }),
      "There is something to change — do it",
    );
    assert.equal(revised.status, "ready");
    assert.equal(revised.branch, session.branch);
    assert.equal(revised.turnCount, 2);
  });

  test("retries on the same branch after a failed turn", async () => {
    const session = await start(
      stubChat(() => {}, { status: "error", reply: "The model is unavailable." }),
    );
    assert.equal(session.status, "failed");

    const revised = await revise(
      session.id,
      recordingChat({}, async (directory) => {
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n");
        await sessionCommit(repository, directory, "Add the plan");
      }),
      "Try again",
    );
    assert.equal(revised.status, "ready");
    assert.equal(revised.error, "", "a retry that worked must not keep the old failure on the row");
    assert.equal(revised.branch, session.branch);
  });

  test("a failed revision keeps the work the earlier turns committed", async () => {
    const session = await firstTurn();
    const revised = await revise(
      session.id,
      recordingChat({}, () => {}, { status: "error", reply: "Ran out of context." }),
    );

    assert.equal(revised.status, "failed");
    assert.match(revised.error, /Ran out of context/);
    assert.equal(revised.headCommit, session.headCommit, "the branch is where it was");
    assert.equal(
      fs.existsSync(sessionWorktreePath(repository, session.id)),
      true,
      "a worktree with commits in it survives a failed follow-up",
    );
    const turns = await repositoryWorkSessionTurns(session.id);
    assert.equal(turns[1].status, "failed");
    assert.equal(turns[0].status, "ok", "the earlier turn is untouched");
  });

  test("runs on the access of whoever asked for the revision", async () => {
    const second = await insert(User, {
      email: "second@example.com",
      name: "Second",
      passwordHash: "x",
      sessionVersion: 4,
    });
    const session = await firstTurn();
    const seen: { options?: Record<string, unknown> } = {};
    await revise(
      session.id,
      recordingChat(seen, async (directory) => {
        sessionWriteFile(directory, "docs/plan.md", "# Plan\n\nAgain.\n");
        await sessionCommit(repository, directory, "Rewrite it");
      }),
      "Rewrite it",
      second.id,
    );
    assert.equal(seen.options?.requesterUserId, second.id);
    const turns = await repositoryWorkSessionTurns(session.id);
    assert.equal(turns[1].requestedByUserId, second.id);
  });

  test("refuses while the session is still working", async () => {
    const session = await firstTurn();
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { status: "running" },
    );
    await assert.rejects(
      () =>
        revise(
          session.id,
          recordingChat({}, () => {}),
        ),
      /still working/,
    );
  });

  test("refuses once the work has been accepted", async () => {
    const session = await firstTurn();
    await publishRepositoryWorkSession(session.id, { push: false });
    await assert.rejects(
      () =>
        revise(
          session.id,
          recordingChat({}, () => {}),
        ),
      /already been accepted/,
    );
  });

  test("refuses once the work has been thrown away", async () => {
    const session = await firstTurn();
    await discardRepositoryWorkSession(session.id);
    await assert.rejects(
      () =>
        revise(
          session.id,
          recordingChat({}, () => {}),
        ),
      /thrown away/,
    );
  });

  test("refuses when the employee's grant was taken away mid-session", async () => {
    const session = await firstTurn();
    await AppDataSource.getRepository(EmployeeRepositoryGrant).delete({
      employeeId: employee.id,
      repositoryId: repository.id,
    });
    await assert.rejects(
      () =>
        revise(
          session.id,
          recordingChat({}, () => {}),
        ),
      /not been granted access/,
    );
    const unchanged = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(unchanged.status, "ready", "a refused revision must not disturb the session");
    assert.equal(unchanged.turnCount, 1);
  });

  test("refuses when the employee's model was disconnected", async () => {
    const session = await firstTurn();
    await AppDataSource.getRepository(AIModel).delete({ employeeId: employee.id });
    await assert.rejects(
      () =>
        revise(
          session.id,
          recordingChat({}, () => {}),
        ),
      /no AI Model connected/,
    );
  });

  test("refuses on shared SaaS, where repositories are read-only", async () => {
    const session = await firstTurn();
    const security = config.security as { multiTenant: boolean };
    security.multiTenant = true;
    try {
      await assert.rejects(
        () =>
          revise(
            session.id,
            recordingChat({}, () => {}),
          ),
        /read-only in shared SaaS/,
      );
    } finally {
      security.multiTenant = false;
    }
  });

  test("refuses a session from another company", async () => {
    const session = await firstTurn();
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: requester.id });
    await assert.rejects(
      () =>
        reviseRepositoryWorkSession({
          companyId: other.id,
          sessionId: session.id,
          instruction: "Change it",
          requesterUserId: requester.id,
          requesterSessionVersion: 1,
          runChat: recordingChat({}, () => {}),
        }),
      /not found/,
    );
  });

  test("marks the session running while the follow-up is in flight", async () => {
    const session = await firstTurn();
    const prepared = await prepareWorkSessionRevision({
      companyId: company.id,
      sessionId: session.id,
      instruction: "Keep going",
      requesterUserId: requester.id,
      requesterSessionVersion: 1,
      runChat: recordingChat({}, () => {}),
    });
    const live = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(live.status, "running", "the client must see the session working straight away");
    assert.equal(prepared.turn.ordinal, 2);
    assert.equal(prepared.turn.status, "running");
  });

  test("finds a fresh revision even when the session itself is older than the timeout", async () => {
    const session = await start(stubChat(() => {}));
    await AppDataSource.getRepository(RepositoryWorkSession).update(session.id, {
      createdAt: new Date(Date.now() - CHAT_HARD_TIMEOUT_MS - 60_000),
    });
    const prepared = await prepareWorkSessionRevision({
      companyId: company.id,
      sessionId: session.id,
      instruction: "Try it now",
      requesterUserId: requester.id,
      requesterSessionVersion: 1,
      runChat: stubChat(() => {}),
    });

    const live = await liveRepositoryWorkSession({
      companyId: company.id,
      repositoryId: repository.id,
      employeeId: employee.id,
    });
    assert.equal(live?.id, session.id);

    await runRepositoryWorkSession(prepared);
  });

  test("does not discard a fresh revision on an old session", async () => {
    const session = await start(stubChat(() => {}));
    await AppDataSource.getRepository(RepositoryWorkSession).update(session.id, {
      createdAt: new Date(Date.now() - CHAT_HARD_TIMEOUT_MS - 60_000),
    });
    const prepared = await prepareWorkSessionRevision({
      companyId: company.id,
      sessionId: session.id,
      instruction: "Try it now",
      requesterUserId: requester.id,
      requesterSessionVersion: 1,
      runChat: stubChat(() => {}),
    });

    await assert.rejects(() => discardRepositoryWorkSession(session.id), /still working/);
    assert.equal(
      (await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({ id: session.id }))
        .status,
      "running",
    );

    await runRepositoryWorkSession(prepared);
  });

  test("publishes work that several turns built up", async () => {
    const session = await firstTurn();
    await revise(
      session.id,
      recordingChat({}, async (directory) => {
        sessionWriteFile(directory, "docs/risks.md", "# Risks\n");
        await sessionCommit(repository, directory, "Add the risks");
      }),
    );
    const published = await publishRepositoryWorkSession(session.id, { push: false });
    assert.equal(published.status, "published");
    assert.equal(
      (await readRepositoryFile(repository, "docs/plan.md")).content,
      "# Plan\n\nShip it.\n",
    );
    assert.equal((await readRepositoryFile(repository, "docs/risks.md")).content, "# Risks\n");
  });
});

// ─────────────────────── the transcript and its title ───────────────────

describe("session history", () => {
  beforeEach(async () => {
    await grantAccess();
  });

  test("writes the opening instruction as turn one", async () => {
    const session = await start(
      stubChat(() => {}),
      "Tidy the README",
    );
    const turns = await repositoryWorkSessionTurns(session.id);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].ordinal, 1);
    assert.equal(turns[0].instruction, "Tidy the README");
    assert.equal(turns[0].sessionId, session.id);
    assert.equal(turns[0].companyId, company.id);
    assert.equal(session.turnCount, 1);
  });

  test("only replays turns that have finished, and only the recent ones", async () => {
    const session = await start(
      stubChat(() => {}),
      "First",
    );
    const turnRepo = AppDataSource.getRepository(RepositoryWorkSessionTurn);
    for (let ordinal = 2; ordinal <= MAX_REPLAYED_TURNS + 4; ordinal += 1) {
      await turnRepo.save(
        turnRepo.create({
          companyId: company.id,
          sessionId: session.id,
          ordinal,
          instruction: `Instruction ${ordinal}`,
          reply: `Reply ${ordinal}`,
          status: "ok",
        }),
      );
    }
    await turnRepo.save(
      turnRepo.create({
        companyId: company.id,
        sessionId: session.id,
        ordinal: MAX_REPLAYED_TURNS + 5,
        instruction: "The one being run now",
        status: "running",
      }),
    );

    const history = await composeTurnHistory(session.id, MAX_REPLAYED_TURNS + 5);
    assert.equal(history.length, MAX_REPLAYED_TURNS * 2);
    assert.equal(history[0].role, "user");
    assert.equal(
      history.some((entry) => entry.content === "The one being run now"),
      false,
      "the turn being run must not be replayed to itself",
    );
    assert.equal(history.at(-1)?.content, `Reply ${MAX_REPLAYED_TURNS + 4}`);
  });

  test("replays a failed turn's error, so the retry knows what went wrong", async () => {
    const session = await start(
      stubChat(() => {}, { status: "error", reply: "Tool call failed." }),
      "Do the thing",
    );
    const history = await composeTurnHistory(session.id, 2);
    assert.deepEqual(history, [
      { role: "user", content: "Do the thing" },
      { role: "assistant", content: "Tool call failed." },
    ]);
  });

  test("gives a session that predates turns the turn it always had", async () => {
    // Exactly the row shape the old schema left behind: the whole exchange on
    // the session, no turns, no title, no count.
    const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
    const legacy = await sessionRepo.save(
      sessionRepo.create({
        companyId: company.id,
        repositoryId: repository.id,
        employeeId: employee.id,
        requestedByUserId: requester.id,
        title: "",
        instruction: "Rewrite the pricing section",
        status: "ready",
        branch: "genosyn/ada/deadbeef",
        baseCommit: "aaaa",
        headCommit: "bbbb",
        reply: "Rewrote it.",
        turnCount: 0,
        filesChanged: 2,
        insertions: 9,
        deletions: 4,
      }),
    );

    const turns = await repositoryWorkSessionTurns(legacy.id);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].ordinal, 1);
    assert.equal(turns[0].instruction, "Rewrite the pricing section");
    assert.equal(turns[0].reply, "Rewrote it.");
    assert.equal(turns[0].status, "ok");
    assert.equal(turns[0].filesChanged, 2);
    assert.equal(turns[0].headCommit, "bbbb");

    const migrated = await sessionRepo.findOneByOrFail({ id: legacy.id });
    assert.equal(migrated.turnCount, 1);
    assert.equal(migrated.title, "Rewrite the pricing section");

    // Reading again must not add a second copy of the same exchange.
    assert.equal((await repositoryWorkSessionTurns(legacy.id)).length, 1);
  });

  test("replays a legacy session's one exchange into its first revision", async () => {
    const sessionRepo = AppDataSource.getRepository(RepositoryWorkSession);
    const legacy = await sessionRepo.save(
      sessionRepo.create({
        companyId: company.id,
        repositoryId: repository.id,
        employeeId: employee.id,
        requestedByUserId: requester.id,
        title: "",
        instruction: "Draft the plan",
        status: "empty",
        reply: "Nothing needed changing.",
        turnCount: 0,
      }),
    );
    const prepared = await prepareWorkSessionRevision({
      companyId: company.id,
      sessionId: legacy.id,
      instruction: "It does need changing",
      requesterUserId: requester.id,
      requesterSessionVersion: 1,
    });
    assert.equal(prepared.turn.ordinal, 2, "the old exchange takes ordinal 1");
    assert.deepEqual(await composeTurnHistory(legacy.id, 2), [
      { role: "user", content: "Draft the plan" },
      { role: "assistant", content: "Nothing needed changing." },
    ]);
  });

  test("titles a session from its opening instruction", async () => {
    const session = await start(
      stubChat(() => {}),
      "  Rewrite the pricing page\nand commit it  ",
    );
    assert.equal(session.title, "Rewrite the pricing page and commit it");
  });

  test("truncates a long title on a word boundary", () => {
    const long = deriveWorkSessionTitle(
      "Refactor the billing service so invoices are generated asynchronously and the webhook handler is idempotent",
    );
    assert.ok(long.length <= 73, long);
    assert.match(long, /…$/);
    assert.ok(!long.includes("  "));
    assert.equal(deriveWorkSessionTitle("   "), "Untitled session");
    assert.equal(deriveWorkSessionTitle("Short one"), "Short one");
  });

  test("renames a session", async () => {
    const session = await start(
      stubChat(() => {}),
      "Do a thing",
    );
    const renamed = await renameRepositoryWorkSession(company.id, session.id, "  Pricing page  ");
    assert.equal(renamed.title, "Pricing page");
    await assert.rejects(
      () => renameRepositoryWorkSession(company.id, session.id, "   "),
      /needs a name/,
    );
    const other = await insert(Company, { name: "Other", slug: "other", ownerId: requester.id });
    await assert.rejects(
      () => renameRepositoryWorkSession(other.id, session.id, "Theirs"),
      /not found/,
    );
  });
});

// ───────────────────────── the worktree it keeps ────────────────────────

describe("the session worktree", () => {
  beforeEach(async () => {
    await grantAccess();
  });

  test("is kept while there is committed work to build on", async () => {
    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "note.md", "x\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.equal(fs.existsSync(sessionWorktreePath(repository, session.id)), true);
  });

  test("is rebuilt from the branch when it has gone missing", async () => {
    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "note.md", "x\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    fs.rmSync(sessionWorktreePath(repository, session.id), { recursive: true, force: true });

    const directory = await ensureSessionWorktree(repository, session);
    assert.equal(directory, sessionWorktreePath(repository, session.id));
    assert.equal(
      sessionReadFile(directory, "note.md"),
      "x\n",
      "the rebuilt worktree is the branch, so the work is all there",
    );
  });

  test("is a no-op when it is already there", async () => {
    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "note.md", "x\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    const directory = await ensureSessionWorktree(repository, session);
    // An uncommitted edit is the evidence: recreating the worktree would have
    // thrown it away, and a follow-up turn must not lose the tree it is in.
    sessionWriteFile(directory, "scratch.md", "in progress\n");
    const again = await ensureSessionWorktree(repository, session);
    assert.equal(sessionReadFile(again, "scratch.md"), "in progress\n");
  });

  test("refuses to rebuild a session that never had a branch", async () => {
    await assert.rejects(
      () => ensureSessionWorktree(repository, { id: "nope", branch: null, baseCommit: null }),
      /no branch/,
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

  test("cannot be redirected by a symlink a command planted in the worktree", () => {
    // A command can create symlinks; the file tools must not follow one. Two
    // shapes matter and they fail for different reasons: a link pointing back
    // *inside* the worktree reaches `.git` under a name the path check allows,
    // and a *dangling* link resolves to nothing, so a containment check on the
    // realpath falls back to a parent that is legitimately contained.
    const pointerBefore = fs.readFileSync(path.join(directory, ".git"), "utf8");
    const outside = path.join(directory, "..", "planted.txt");

    fs.symlinkSync(".git", path.join(directory, "gitlink"));
    fs.symlinkSync("../planted.txt", path.join(directory, "outlink"));
    fs.symlinkSync("/etc/hosts", path.join(directory, "abslink"));

    for (const bad of ["gitlink", "outlink", "abslink"]) {
      assert.throws(() => sessionWriteFile(directory, bad, "pwned\n"), /symlink|escapes/, bad);
    }
    assert.equal(
      fs.readFileSync(path.join(directory, ".git"), "utf8"),
      pointerBefore,
      "the worktree's .git pointer is untouched",
    );
    assert.equal(fs.existsSync(outside), false, "nothing was created outside the worktree");
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
    await assert.rejects(() => resolveSessionCheckout(company.id, session.id), /already finished/);
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

  test("says there is no shell where the install cannot give it one", () => {
    // The suite runs with execution disabled, which is the case this covers.
    const prompt = composeWorkSystemPrompt(
      { ...repository, kind: "code", commandMode: "all" },
      "s",
    );
    assert.match(prompt, /no shell and cannot run tests/);
    assert.ok(!prompt.includes("repository_run_command"));
  });
});

/**
 * What changes once commands are available.
 *
 * Both halves matter and for the same reason: an employee acts on what the
 * briefing says. Told it has no shell it will not reach for one, and told it
 * has one where it does not it spends the turn discovering otherwise.
 */
describe("a session that can run commands", () => {
  beforeEach(() => {
    codingTools.executionMode = "bubblewrap";
  });
  after(() => {
    codingTools.executionMode = "disabled";
  });

  test("tells the employee to verify its own work before committing", () => {
    const prompt = composeWorkSystemPrompt({ ...repository, kind: "code" }, "s");
    assert.match(prompt, /repository_run_command/);
    assert.match(prompt, /Verify your own work before you commit/);
    assert.ok(!prompt.includes("no shell and cannot run tests"));
  });

  test("still says nothing about commands on a repository that forbids them", () => {
    const prompt = composeWorkSystemPrompt(
      { ...repository, kind: "code", commandMode: "off" },
      "s",
    );
    assert.ok(!prompt.includes("repository_run_command"));
    assert.match(prompt, /no shell and cannot run tests/);
  });

  test("a documents repository is briefed about its prose, commands or not", () => {
    const prompt = composeWorkSystemPrompt({ ...repository, kind: "documents" }, "s");
    assert.match(prompt, /documents rather than software/);
    assert.match(prompt, /repository_run_command/);
  });

  test("loads the command tool up front only where it would work", () => {
    assert.ok(repositorySessionResidentTools(repository).includes("repository_run_command"));
    assert.ok(
      !repositorySessionResidentTools({ ...repository, commandMode: "off" }).includes(
        "repository_run_command",
      ),
    );
    codingTools.executionMode = "disabled";
    assert.ok(!repositorySessionResidentTools(repository).includes("repository_run_command"));
  });

  test("the MCP allowlist keeps the tool whatever one repository decided", () => {
    // A repository that forbids commands answers with a refusal that names who
    // can change it. Dropping the tool from the seam would answer instead with
    // "you may only use the repository_* tools", which is both wrong and useless.
    assert.ok(REPOSITORY_SESSION_TOOLS.includes("repository_run_command"));
  });
});

describe("branch naming", () => {
  test("namespaces the branch by employee and session", () => {
    const name = sessionBranchName("ada", "abcdef12-3456-7890-abcd-ef1234567890");
    assert.equal(name, "genosyn/ada/abcdef12");
  });

  test("survives an employee slug that is not branch-safe", () => {
    assert.equal(
      sessionBranchName("Ada Lovelace!", "abcdef12-3456"),
      "genosyn/ada-lovelace/abcdef12",
    );
    assert.equal(sessionBranchName("", "abcdef12-3456"), "genosyn/employee/abcdef12");
  });
});

// ────────────── the trunk a session branches from ───────────────────────

/**
 * A session used to branch from the Member checkout's `HEAD` — whatever branch
 * somebody last switched to, however far behind it had been left. These pin
 * the replacement: work starts from the repository's *default branch*, brought
 * up to date first, and a session already under way is never re-based out from
 * under the human reading its diff.
 */
describe("the trunk a session branches from", () => {
  test("is the default branch, not whatever the Member last checked out", async () => {
    await grantAccess();
    await ensureRepositoryWorkspace(repository);
    await writeRepositoryFile(repository, "trunk.md", "the plan of record\n");
    const trunk = await commitRepositoryChanges(repository, { message: "Set the plan" });
    assert.ok(trunk);

    // A Member wanders off to a side branch and leaves the checkout there.
    await createRepositoryBranch(repository, "member-side");
    await checkoutRepositoryBranch(repository, "member-side");
    await writeRepositoryFile(repository, "side.md", "half-finished\n");
    const side = await commitRepositoryChanges(repository, { message: "Side work" });
    assert.ok(side);
    assert.equal((await repositoryStatus(repository)).branch, "member-side");

    let sawSideFile = true;
    const session = await start(
      stubChat(async (directory) => {
        sawSideFile = fs.existsSync(path.join(directory, "side.md"));
        sessionWriteFile(directory, "note.md", "from the trunk\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );

    assert.equal(session.baseCommit, trunk.sha, "the session must start from the trunk");
    assert.notEqual(session.baseCommit, side.sha);
    assert.equal(sawSideFile, false, "the employee must not inherit unrelated side-branch work");
    // The Member's checkout is exactly where they left it.
    assert.equal((await repositoryStatus(repository)).branch, "member-side");
  });

  test("picks up a commit made on the trunk since the last session", async () => {
    await grantAccess();
    await ensureRepositoryWorkspace(repository);
    await writeRepositoryFile(repository, "plan.md", "v1\n");
    await commitRepositoryChanges(repository, { message: "Plan v1" });

    const first = await start(
      stubChat(() => {}),
      "Look around",
    );
    await writeRepositoryFile(repository, "plan.md", "v2\n");
    const moved = await commitRepositoryChanges(repository, { message: "Plan v2" });
    assert.ok(moved);

    let seen = "";
    const second = await start(
      stubChat((directory) => {
        seen = sessionReadFile(directory, "plan.md");
      }),
      "Now update it",
    );

    assert.notEqual(second.baseCommit, first.baseCommit);
    assert.equal(second.baseCommit, moved.sha);
    assert.equal(seen, "v2\n", "a session started after a change must see the change");
  });

  test("does not re-base a session that is already under way", async () => {
    await grantAccess();
    await ensureRepositoryWorkspace(repository);
    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "draft.md", "first pass\n");
        await sessionCommit(repository, directory, "First pass");
      }),
    );
    const originalBase = session.baseCommit;
    assert.ok(originalBase);

    // The trunk moves while the human is reading the diff.
    await writeRepositoryFile(repository, "unrelated.md", "meanwhile\n");
    const advanced = await commitRepositoryChanges(repository, { message: "Unrelated work" });
    assert.ok(advanced);

    const revised = await reviseRepositoryWorkSession({
      companyId: company.id,
      sessionId: session.id,
      instruction: "Add a second paragraph",
      requesterUserId: requester.id,
      requesterSessionVersion: 1,
      runChat: stubChat(async (directory) => {
        // The earlier commit is still here: this is the same branch.
        assert.equal(sessionReadFile(directory, "draft.md"), "first pass\n");
        sessionWriteFile(directory, "draft.md", "first pass\nsecond pass\n");
        await sessionCommit(repository, directory, "Second pass");
      }),
    });

    assert.equal(
      revised.baseCommit,
      originalBase,
      "moving the base under a diff a human is reviewing is worse than a stale base",
    );
    assert.notEqual(revised.baseCommit, advanced.sha);
  });

  test("still starts when the stored default branch names a branch that is gone", async () => {
    await grantAccess();
    await ensureRepositoryWorkspace(repository);
    await writeRepositoryFile(repository, "plan.md", "v1\n");
    const head = await commitRepositoryChanges(repository, { message: "Plan v1" });
    assert.ok(head);
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      { defaultBranch: "trunk-that-was-renamed" },
    );
    repository.defaultBranch = "trunk-that-was-renamed";

    const session = await start(
      stubChat(async (directory) => {
        sessionWriteFile(directory, "note.md", "still works\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.equal(session.status, "ready");
    assert.equal(session.baseCommit, head.sha, "a wrong default branch must not block the work");
  });
});

// ──────────────── the repository's own contributor guide ────────────────

/**
 * A repository that keeps an `AGENTS.md` is telling contributors how to work
 * in it. An employee that never reads it produces work a human sends back for
 * reasons that were written down all along — so the session briefing carries
 * it.
 */
describe("AGENTS.md", () => {
  const guide = "# AGENTS\n\nUse the word Routine, never Task.\n";

  async function repositoryWithGuide(body = guide): Promise<void> {
    await ensureRepositoryWorkspace(repository);
    await writeRepositoryFile(repository, "AGENTS.md", body);
    await commitRepositoryChanges(repository, { message: "Add the contributor guide" });
  }

  /** The system prompt the run path actually handed the model. */
  function capturingChat(): { chat: typeof chatWithEmployee; brief: () => string } {
    let captured = "";
    const chat = (async (_companyId, _employeeId, _message, _history, options) => {
      const opts = options as { repositoryWorkSessionId?: string; extraSystem?: string };
      captured = opts.extraSystem ?? "";
      const checkout = await resolveSessionCheckout(company.id, opts.repositoryWorkSessionId ?? "");
      sessionWriteFile(checkout.directory, "note.md", "ok\n");
      await sessionCommit(repository, checkout.directory, "Add a note");
      return { status: "ok", reply: "Done.", attachmentIds: [], sidecars: {} } as ChatResult;
    }) as typeof chatWithEmployee;
    return { chat, brief: () => captured };
  }

  test("reaches the employee's briefing when the repository has one", async () => {
    await grantAccess();
    await repositoryWithGuide();

    const capture = capturingChat();
    const session = await start(capture.chat);
    assert.equal(session.status, "ready");

    const brief = capture.brief();
    assert.match(brief, /Use the word Routine, never Task\./, "the guide's own text must be there");
    assert.match(brief, /<AGENTS\.md>/);
    assert.match(brief, /<\/AGENTS\.md>/);
  });

  test("is not mentioned in the briefing of a repository without one", async () => {
    await grantAccess();
    await ensureRepositoryWorkspace(repository);

    const capture = capturingChat();
    await start(capture.chat);
    assert.ok(
      !capture.brief().includes("AGENTS.md"),
      "an absent guide must not leave an empty section behind",
    );
  });

  test("is read from the session's own worktree", async () => {
    await grantAccess();
    await repositoryWithGuide();

    let seen: string | null = "not read";
    await start(
      stubChat(async (directory) => {
        seen = readAgentsGuide(directory);
        sessionWriteFile(directory, "note.md", "ok\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.equal(seen, guide);
  });

  test("is absent, and harmless, when the repository has no guide", async () => {
    await grantAccess();
    await ensureRepositoryWorkspace(repository);

    let seen: string | null = "not read";
    const session = await start(
      stubChat(async (directory) => {
        seen = readAgentsGuide(directory);
        sessionWriteFile(directory, "note.md", "ok\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.equal(seen, null);
    assert.equal(session.status, "ready");
    const brief = composeWorkSystemPrompt(repository, "s", { agentsGuide: null });
    assert.ok(!brief.includes("AGENTS.md"), "no guide means no section, not an empty one");
  });

  test("says the briefing wins where the guide disagrees with it", async () => {
    const brief = composeWorkSystemPrompt(repository, "s", { agentsGuide: guide });
    assert.match(brief, /the instructions above win/);
    assert.match(brief, /it is how this team expects work here to be done/);
    // The guide is quoted after the rules it cannot override.
    assert.ok(
      brief.indexOf("the instructions above win") < brief.indexOf("<AGENTS.md>"),
      "the precedence line has to be read before the document it is about",
    );
  });

  test("truncates a guide too large to inline, and says it did", async () => {
    const huge = `# AGENTS\n\n${"Follow the house style.\n".repeat(4000)}`;
    assert.ok(Buffer.byteLength(huge) > MAX_AGENTS_GUIDE_BYTES, "the fixture must exceed the cap");
    await grantAccess();
    await repositoryWithGuide(huge);

    let seen: string | null = null;
    await start(
      stubChat(async (directory) => {
        seen = readAgentsGuide(directory);
        sessionWriteFile(directory, "note.md", "ok\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.ok(seen);
    const read = seen as unknown as string;
    assert.ok(
      Buffer.byteLength(read) < Buffer.byteLength(huge),
      "an unbounded guide would crowd out the instruction",
    );
    assert.match(
      read,
      /\[Truncated\. Read `AGENTS\.md` with `repository_read_file` for the rest\.\]/,
    );
    assert.ok(read.startsWith("# AGENTS"), "the beginning is the part worth keeping");
    // Cut on a line boundary, so the guide never ends mid-sentence.
    const lines = read.split("\n");
    assert.ok(
      lines.some((line) => line === "Follow the house style."),
      "whole lines survive the cut",
    );
  });

  test("treats an empty or whitespace-only guide as no guide", async () => {
    await grantAccess();
    await repositoryWithGuide("   \n\n\t\n");

    let seen: string | null = "not read";
    await start(
      stubChat(async (directory) => {
        seen = readAgentsGuide(directory);
        sessionWriteFile(directory, "note.md", "ok\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.equal(seen, null);
  });

  test("refuses an AGENTS.md symlinked out of the worktree", async () => {
    await grantAccess();
    await ensureRepositoryWorkspace(repository);
    const secret = path.join(dataDir, "outside-agents.md");
    fs.writeFileSync(secret, "# Read the operator's private notes\n");

    let seen: string | null = "not read";
    await start(
      stubChat(async (directory) => {
        fs.symlinkSync(secret, path.join(directory, "AGENTS.md"));
        seen = readAgentsGuide(directory);
        sessionWriteFile(directory, "note.md", "ok\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.equal(seen, null, "a guide is not worth following a symlink out of the worktree for");
  });

  test("only reads the guide at the root, not one nested in the tree", async () => {
    await grantAccess();
    await ensureRepositoryWorkspace(repository);
    await writeRepositoryFile(repository, "docs/AGENTS.md", "# Not the root guide\n");
    await commitRepositoryChanges(repository, { message: "Add a nested file" });

    let seen: string | null = "not read";
    await start(
      stubChat(async (directory) => {
        seen = readAgentsGuide(directory);
        sessionWriteFile(directory, "note.md", "ok\n");
        await sessionCommit(repository, directory, "Add a note");
      }),
    );
    assert.equal(seen, null);
  });
});
