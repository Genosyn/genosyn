import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { Membership } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionEvent } from "../db/entities/RepositoryWorkSessionEvent.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import type { ChatResult, chatWithEmployee } from "../services/chat.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import {
  SessionActivityRecorder,
  nextSessionEventOrdinal,
  registerRunningSessionTurn,
  runningSessionTurn,
  unregisterRunningSessionTurn,
} from "../services/repositoryWorkSessionActivity.js";
import {
  REPOSITORY_SESSION_TOOLS,
  resolveSessionCheckout,
  sessionReadFile,
  sessionWriteFile,
  startRepositoryWorkSession,
} from "../services/repositoryWorkSessions.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The `repository_*` tools, called over HTTP the way an employee's turn calls
 * them, against a session that is really running.
 *
 * The model turn is stubbed to *wait*: `startRepositoryWorkSession` cuts the
 * worktree and registers the turn exactly as in production, then hands control
 * to a stub that blocks until the test is done with the session. While it
 * waits, the session row is `running`, its worktree exists, and a token bound
 * to it reaches every handler under test. Releasing the stub lets the real
 * finish path record the outcome, so a test can also check what the tools'
 * commits left on the row.
 */

let server: Server;
let baseUrl = "";
let dataDir: string;
const originalDataDir = config.dataDir;
const codingTools = config.agent.codingTools as {
  enabled: boolean;
  executionMode: "host" | "bubblewrap" | "disabled";
  allowUnsafeHostExecution: boolean;
};
const originalCodingTools = { ...codingTools };

let company: Company;
let employee: AIEmployee;
let requester: User;
let repository: Repository;

before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-session-tools-"));
  (config as { dataDir: string }).dataDir = dataDir;
  // Git on the App-owned worktree is server-owned plumbing and works with the
  // sandbox off; nothing here needs a command to run.
  codingTools.enabled = true;
  codingTools.executionMode = "disabled";
  codingTools.allowUnsafeHostExecution = false;
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  Object.assign(codingTools, originalCodingTools);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetTestDb();
  requester = await insert(User, {
    email: "member@example.com",
    passwordHash: "hash",
    name: "Member",
    emailVerifiedAt: new Date(),
    sessionVersion: 0,
  });
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: requester.id });
  await insert(Membership, {
    companyId: company.id,
    userId: requester.id,
    role: "member",
    financeAccess: "none",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Engineer",
    soulBody: "",
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
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "write",
  });
});

type ToolResponse = {
  status: number;
  body: Record<string, unknown> & { error?: string };
  /** The flattened MCP text envelope, when the tool answered with one. */
  text: string;
};

async function callWith(bearer: string, tool: string, body: unknown = {}): Promise<ToolResponse> {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      connection: "close",
    },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  const parsed = (raw ? JSON.parse(raw) : {}) as Record<string, unknown> & { error?: string };
  const content = parsed.content as Array<{ type: string; text: string }> | undefined;
  const text = Array.isArray(content)
    ? content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
    : "";
  return { status: response.status, body: parsed, text };
}

function memberToken(repositoryWorkSessionId?: string): string {
  return issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: requester.id,
    requesterSessionVersion: requester.sessionVersion,
    ...(repositoryWorkSessionId ? { repositoryWorkSessionId } : {}),
  });
}

type OpenSession = {
  id: string;
  directory: string;
  token: string;
  call: (tool: string, body?: unknown) => Promise<ToolResponse>;
  /** Let the stubbed turn return, then wait for the session to settle. */
  finish: () => Promise<RepositoryWorkSession>;
};

/**
 * Start a session for real and hold its model turn open.
 *
 * Resolves once the turn has begun — worktree cut, turn registered — with a
 * token shaped like the one the turn's own tool calls carry.
 */
async function openSession(instruction = "Update the plan"): Promise<OpenSession> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let begun!: (checkout: { sessionId: string; directory: string }) => void;
  const turnBegun = new Promise<{ sessionId: string; directory: string }>((resolve) => {
    begun = resolve;
  });
  const runChat = (async (_companyId, _employeeId, _message, _history, options) => {
    const sessionId =
      (options as { repositoryWorkSessionId?: string }).repositoryWorkSessionId ?? "";
    const checkout = await resolveSessionCheckout(company.id, sessionId);
    begun({ sessionId, directory: checkout.directory });
    await released;
    return { status: "ok", reply: "Done.", attachmentIds: [], sidecars: {} } as ChatResult;
  }) as typeof chatWithEmployee;

  const finished = startRepositoryWorkSession({
    companyId: company.id,
    repositoryId: repository.id,
    employeeId: employee.id,
    instruction,
    requesterUserId: requester.id,
    requesterSessionVersion: requester.sessionVersion,
    runChat,
  });
  // A session that fails before its turn begins never reaches the stub; the
  // race turns that into a readable failure instead of a hang.
  const opened = await Promise.race([
    turnBegun.then((checkout) => ({ kind: "begun" as const, ...checkout })),
    finished.then((session) => ({ kind: "finished" as const, session })),
  ]);
  if (opened.kind === "finished") {
    throw new Error(
      `the session ended before its turn began: ${opened.session.status} ${opened.session.error}`,
    );
  }
  const token = memberToken(opened.sessionId);
  return {
    id: opened.sessionId,
    directory: opened.directory,
    token,
    call: (tool, body = {}) => callWith(token, tool, body),
    finish: async () => {
      release();
      try {
        return await finished;
      } finally {
        revokeMcpToken(token);
      }
    },
  };
}

/** Run `work` against an open session and always let the session finish. */
async function withSession(work: (session: OpenSession) => Promise<void>): Promise<void> {
  const session = await openSession();
  try {
    await work(session);
  } finally {
    await session.finish();
  }
}

const PLAN = "# Plan\n\nGrow revenue.\nCut costs.\nShip it.\n";

/** A small tree with something to find, something to skip, and something ignored. */
function seedTree(directory: string): void {
  sessionWriteFile(directory, "docs/plan.md", PLAN);
  sessionWriteFile(directory, "notes/todo.md", "Revenue targets\nrevenue again\n");
  sessionWriteFile(directory, "src/app.ts", "export const revenue = 1;\n");
  sessionWriteFile(directory, ".gitignore", "dist/\n");
  sessionWriteFile(directory, "dist/bundle.js", "revenue\n");
}

// ───────────────────────────── reading ──────────────────────────────────

describe("repository_read_file", () => {
  test("answers with the text envelope and numbered lines", async () => {
    await withSession(async (s) => {
      sessionWriteFile(s.directory, "docs/plan.md", PLAN);
      const res = await s.call("repository_read_file", { path: "docs/plan.md" });

      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body), ["content"]);
      assert.equal((res.body.content as unknown[]).length, 1);
      assert.equal(
        res.text,
        [
          "   1\t# Plan",
          "   2\t",
          "   3\tGrow revenue.",
          "   4\tCut costs.",
          "   5\tShip it.",
        ].join("\n"),
      );
    });
  });

  test("honours offset and limit, and says how to continue", async () => {
    await withSession(async (s) => {
      sessionWriteFile(s.directory, "docs/plan.md", PLAN);
      const window = await s.call("repository_read_file", {
        path: "docs/plan.md",
        offset: 3,
        limit: 2,
      });
      assert.equal(window.status, 200);
      assert.equal(
        window.text,
        "   3\tGrow revenue.\n   4\tCut costs.\n\n[Lines 3–4 of 5. Call again with offset=5 to continue.]",
      );

      const tail = await s.call("repository_read_file", { path: "docs/plan.md", offset: 4 });
      assert.equal(tail.text, "   4\tCut costs.\n   5\tShip it.\n\n[Lines 4–5 of 5.]");

      const past = await s.call("repository_read_file", { path: "docs/plan.md", offset: 9 });
      assert.equal(past.status, 200);
      assert.equal(past.text, "(docs/plan.md has 5 lines; offset 9 is past the end)");
    });
  });

  test("refuses what it cannot read, in words the employee can act on", async () => {
    await withSession(async (s) => {
      sessionWriteFile(s.directory, "docs/plan.md", PLAN);
      const missing = await s.call("repository_read_file", { path: "nope.md" });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error, "No such file: nope.md");

      const folder = await s.call("repository_read_file", { path: "docs" });
      assert.equal(folder.status, 400);
      assert.match(folder.body.error ?? "", /is a directory — use repository_list_files/);

      const badWindow = await s.call("repository_read_file", { path: "docs/plan.md", offset: 0 });
      assert.equal(badWindow.status, 400);
      assert.equal(badWindow.body.error, "ValidationError");
    });
  });
});

// ───────────────────────────── editing ──────────────────────────────────

describe("repository_edit_file", () => {
  test("replaces an exact string and shows the edited region", async () => {
    await withSession(async (s) => {
      sessionWriteFile(s.directory, "docs/plan.md", PLAN);
      const res = await s.call("repository_edit_file", {
        path: "docs/plan.md",
        old_string: "Grow revenue.",
        new_string: "Grow revenue fast.",
      });

      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.path, "docs/plan.md");
      assert.equal(res.body.replacements, 1);
      assert.equal(res.body.line, 3);
      assert.match(String(res.body.snippet), /^ {3}1\t# Plan\n/);
      assert.match(String(res.body.snippet), /\n {3}3\tGrow revenue fast\.\n/);
      assert.equal(
        sessionReadFile(s.directory, "docs/plan.md"),
        "# Plan\n\nGrow revenue fast.\nCut costs.\nShip it.\n",
      );
    });
  });

  test("refuses a string it cannot find, and an ambiguous one without replace_all", async () => {
    await withSession(async (s) => {
      sessionWriteFile(s.directory, "docs/plan.md", PLAN);
      const missing = await s.call("repository_edit_file", {
        path: "docs/plan.md",
        old_string: "Raise prices.",
        new_string: "Lower prices.",
      });
      assert.equal(missing.status, 400);
      assert.equal(
        missing.body.error,
        "old_string was not found in docs/plan.md. Read the file again and copy the text exactly, including whitespace and indentation.",
      );

      const ambiguous = await s.call("repository_edit_file", {
        path: "docs/plan.md",
        old_string: ".",
        new_string: "!",
      });
      assert.equal(ambiguous.status, 400);
      assert.match(ambiguous.body.error ?? "", /appears 3 times in docs\/plan\.md/);
      assert.equal(sessionReadFile(s.directory, "docs/plan.md"), PLAN, "nothing was applied");

      const all = await s.call("repository_edit_file", {
        path: "docs/plan.md",
        old_string: ".",
        new_string: "!",
        replace_all: true,
      });
      assert.equal(all.status, 200);
      assert.equal(all.body.replacements, 3);
      assert.equal(
        sessionReadFile(s.directory, "docs/plan.md"),
        "# Plan\n\nGrow revenue!\nCut costs!\nShip it!\n",
      );
    });
  });

  test("points a missing file at the write tool, and refuses an empty old_string", async () => {
    await withSession(async (s) => {
      const missing = await s.call("repository_edit_file", {
        path: "docs/new.md",
        old_string: "x",
        new_string: "y",
      });
      assert.equal(missing.status, 400);
      assert.equal(
        missing.body.error,
        "No such file: docs/new.md. To create a file, use repository_write_file.",
      );

      const empty = await s.call("repository_edit_file", {
        path: "README.md",
        old_string: "",
        new_string: "y",
      });
      assert.equal(empty.status, 400);
      assert.equal(empty.body.error, "ValidationError");
    });
  });
});

describe("repository_write_file", () => {
  test("writes the file and reports how many lines it now has", async () => {
    await withSession(async (s) => {
      const three = await s.call("repository_write_file", {
        path: "docs/notes.md",
        content: "a\nb\nc\n",
      });
      assert.equal(three.status, 200);
      assert.equal(three.body.ok, true);
      assert.equal(three.body.path, "docs/notes.md");
      assert.equal(three.body.lines, 3);
      assert.equal(three.body.bytes, 6);
      assert.equal(sessionReadFile(s.directory, "docs/notes.md"), "a\nb\nc\n");

      const noTrailingNewline = await s.call("repository_write_file", {
        path: "docs/notes.md",
        content: "a\nb",
      });
      assert.equal(noTrailingNewline.body.lines, 2);

      const empty = await s.call("repository_write_file", { path: "docs/empty.md", content: "" });
      assert.equal(empty.body.lines, 0);
      assert.equal(empty.body.bytes, 0);
    });
  });
});

// ─────────────────────────── search and glob ────────────────────────────

describe("repository_search", () => {
  test("lists files, counts, or shows matches with context", async () => {
    await withSession(async (s) => {
      seedTree(s.directory);
      const files = await s.call("repository_search", {
        pattern: "revenue",
        output_mode: "files",
      });
      assert.equal(files.status, 200);
      assert.equal(files.text, "docs/plan.md\nnotes/todo.md\nsrc/app.ts");

      const counts = await s.call("repository_search", {
        pattern: "revenue",
        ignore_case: true,
        output_mode: "count",
        path: "notes",
      });
      assert.equal(counts.status, 200);
      assert.equal(counts.text, "notes/todo.md: 2");

      const content = await s.call("repository_search", {
        pattern: "^Grow",
        path: "docs/plan.md",
        context: 1,
      });
      assert.equal(content.status, 200);
      assert.equal(
        content.text,
        ["docs/plan.md-2-", "docs/plan.md:3:Grow revenue.", "docs/plan.md-4-Cut costs."].join("\n"),
      );
    });
  });

  test("narrows by glob and never looks inside an ignored folder", async () => {
    await withSession(async (s) => {
      seedTree(s.directory);
      const typescript = await s.call("repository_search", {
        pattern: "revenue",
        glob: "*.ts",
        output_mode: "files",
      });
      assert.equal(typescript.text, "src/app.ts");

      const javascript = await s.call("repository_search", {
        pattern: "revenue",
        glob: "*.js",
        output_mode: "files",
      });
      assert.equal(javascript.text, "(no matches)", "dist/ is gitignored and must stay unseen");
    });
  });

  test("refuses an invalid regular expression and an unknown path", async () => {
    await withSession(async (s) => {
      const invalid = await s.call("repository_search", { pattern: "(" });
      assert.equal(invalid.status, 400);
      assert.match(invalid.body.error ?? "", /^Invalid regular expression:/);

      const nowhere = await s.call("repository_search", { pattern: "x", path: "nope" });
      assert.equal(nowhere.status, 400);
      assert.equal(nowhere.body.error, "No such path: nope");

      const badMode = await s.call("repository_search", { pattern: "x", output_mode: "json" });
      assert.equal(badMode.status, 400);
      assert.equal(badMode.body.error, "ValidationError");
    });
  });
});

describe("repository_glob", () => {
  test("matches basenames anywhere, or paths when the pattern has a slash", async () => {
    await withSession(async (s) => {
      seedTree(s.directory);
      const markdown = await s.call("repository_glob", { pattern: "*.md" });
      assert.equal(markdown.status, 200);
      assert.equal(markdown.text, "README.md\ndocs/plan.md\nnotes/todo.md");

      const scoped = await s.call("repository_glob", { pattern: "*.md", path: "docs" });
      assert.equal(scoped.text, "docs/plan.md");

      const deep = await s.call("repository_glob", { pattern: "**/*.ts" });
      assert.equal(deep.text, "src/app.ts");

      const ignored = await s.call("repository_glob", { pattern: "*.js" });
      assert.equal(ignored.text, "(no matches)");
    });
  });
});

// ─────────────────────────── listing a tree ─────────────────────────────

describe("repository_list_files", () => {
  test("lists one level by default, marking what git ignores", async () => {
    await withSession(async (s) => {
      seedTree(s.directory);
      const root = await s.call("repository_list_files", {});
      assert.equal(root.status, 200);
      const lines = root.text.split("\n");
      assert.ok(lines.includes("dist/  (ignored)"), root.text);
      assert.ok(lines.includes("docs/"), root.text);
      assert.ok(lines.includes("README.md  (11 B)"), root.text);
      assert.ok(
        lines.indexOf("docs/") < lines.indexOf("README.md  (11 B)"),
        "folders are listed before files",
      );
      assert.ok(!root.text.includes("plan.md"), "depth 1 does not descend");
      assert.ok(!root.text.includes("bundle.js"), "an ignored folder is never opened");
    });
  });

  test("descends to the requested depth and lists a subfolder", async () => {
    await withSession(async (s) => {
      seedTree(s.directory);
      const deep = await s.call("repository_list_files", { depth: 2 });
      assert.equal(deep.status, 200);
      assert.match(deep.text, /^docs\/\n {2}plan\.md {2}\(42 B\)$/m);
      assert.ok(!deep.text.includes("bundle.js"));

      const docs = await s.call("repository_list_files", { path: "docs" });
      assert.equal(docs.text, "plan.md  (42 B)");
    });
  });

  test("refuses a file, a missing folder, and a depth it will not go to", async () => {
    await withSession(async (s) => {
      const file = await s.call("repository_list_files", { path: "README.md" });
      assert.equal(file.status, 400);
      assert.match(file.body.error ?? "", /is a file — read it with repository_read_file/);

      const missing = await s.call("repository_list_files", { path: "nope" });
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error, "No such folder: nope");

      const tooDeep = await s.call("repository_list_files", { depth: 5 });
      assert.equal(tooDeep.status, 400);
      assert.equal(tooDeep.body.error, "ValidationError");
    });
  });
});

// ─────────────────────── status, diff, and commit ───────────────────────

describe("status, diff, and commit", () => {
  test("show the employee what it has changed, then what it recorded", async () => {
    await withSession(async (s) => {
      sessionWriteFile(s.directory, "docs/plan.md", PLAN);
      sessionWriteFile(s.directory, "notes/todo.md", "Revenue targets\nrevenue again\n");

      const before = await s.call("repository_status", {});
      assert.equal(before.status, 200);
      assert.match(before.text, /^Branch: genosyn\/ada\/[0-9a-f]{8}$/m);
      assert.match(before.text, /^Based on: [0-9a-f]{7}$/m);
      assert.match(before.text, /^Commits on this branch so far: 0$/m);
      assert.match(before.text, /^Uncommitted changes: 2$/m);
      assert.match(before.text, /^ {2}\?\? docs\/plan\.md$/m);
      assert.match(before.text, /^ {2}\?\? notes\/todo\.md$/m);

      const uncommitted = await s.call("repository_diff", {});
      assert.equal(uncommitted.status, 200);
      assert.match(uncommitted.text, /^2 files changed, \+7 −0\n\n/);
      assert.match(
        uncommitted.text,
        /diff --git a\/docs\/plan\.md b\/docs\/plan\.md\nnew file mode 100644/,
      );
      assert.match(uncommitted.text, /^\+# Plan$/m);

      const nothingCommitted = await s.call("repository_diff", { committed: true });
      assert.equal(nothingCommitted.text, "(no committed changes on this branch yet)");

      const commit = await s.call("repository_commit", {
        message: "Add the plan",
        paths: ["docs/plan.md"],
      });
      assert.equal(commit.status, 200);
      assert.equal(commit.body.committed, true);
      assert.match(String(commit.body.commit), /^[0-9a-f]{40}$/);
      assert.equal(commit.body.filesChanged, 1);
      assert.equal(commit.body.insertions, 5);
      assert.equal(commit.body.deletions, 0);

      const after = await s.call("repository_status", {});
      assert.match(after.text, /^Commits on this branch so far: 1$/m);
      assert.match(after.text, /^ {2}[0-9a-f]{7} Add the plan$/m);
      assert.match(after.text, /^Uncommitted changes: 1$/m);
      assert.match(after.text, /^ {2}\?\? notes\/todo\.md$/m);

      const committed = await s.call("repository_diff", { committed: true });
      assert.match(committed.text, /^1 file changed, \+5 −0\n\n/);
      assert.ok(committed.text.includes("docs/plan.md"));
      assert.ok(!committed.text.includes("notes/todo.md"), "only what was committed");

      const stillPending = await s.call("repository_diff", {});
      assert.match(stillPending.text, /^1 file changed, \+2 −0\n\n/);
      assert.ok(stillPending.text.includes("notes/todo.md"));
      assert.ok(!stillPending.text.includes("docs/plan.md"));

      const again = await s.call("repository_commit", {
        message: "Add the plan again",
        paths: ["docs/plan.md"],
      });
      assert.equal(again.status, 200);
      assert.equal(again.body.committed, false);
      assert.match(String(again.body.message), /Nothing had changed/);

      await s.call("repository_edit_file", {
        path: "docs/plan.md",
        old_string: "Ship it.",
        new_string: "Ship it soon.",
      });
      const scoped = await s.call("repository_diff", { path: "docs/plan.md" });
      assert.match(scoped.text, /^1 file changed, \+1 −1\n\n/);
      assert.match(scoped.text, /^-Ship it\.$/m);
      assert.match(scoped.text, /^\+Ship it soon\.$/m);
      assert.ok(!scoped.text.includes("notes/todo.md"));

      const everything = await s.call("repository_commit", { message: "Finish" });
      assert.equal(everything.body.committed, true);
      assert.equal(everything.body.filesChanged, 2);
      assert.equal(everything.body.insertions, 3);
      assert.equal(everything.body.deletions, 1);

      const clean = await s.call("repository_status", {});
      assert.match(clean.text, /^Commits on this branch so far: 2$/m);
      assert.match(clean.text, /^Uncommitted changes: 0$/m);
    });
  });

  test("what the tools commit is what the finished session reports", async () => {
    const s = await openSession();
    sessionWriteFile(s.directory, "docs/plan.md", PLAN);
    const commit = await s.call("repository_commit", { message: "Add the plan" });
    assert.equal(commit.body.committed, true);

    const finished = await s.finish();
    assert.equal(finished.status, "ready");
    assert.equal(finished.filesChanged, 1);
    assert.equal(finished.insertions, 5);
    assert.equal(finished.headCommit, commit.body.commit);
    assert.notEqual(finished.headCommit, finished.baseCommit);

    // The turn is over, so its token no longer reaches the worktree.
    const late = await callWith(memberToken(s.id), "repository_status", {});
    assert.equal(late.status, 400);
    assert.match(late.body.error ?? "", /already finished/);
  });

  test("a bad path in a commit is refused before anything is staged", async () => {
    await withSession(async (s) => {
      sessionWriteFile(s.directory, "docs/plan.md", PLAN);
      const res = await s.call("repository_commit", {
        message: "Escape",
        paths: ["../outside.md"],
      });
      assert.equal(res.status, 400);
      assert.match(res.body.error ?? "", /relative segments/);
      const status = await s.call("repository_status", {});
      assert.match(status.text, /^Commits on this branch so far: 0$/m);
    });
  });
});

// ─────────────────────────────── steps ──────────────────────────────────

describe("repository_update_steps", () => {
  const steps = [
    { text: "Read the plan", status: "completed" },
    { text: "Edit it", status: "in_progress" },
    { text: "Commit", status: "pending" },
  ];

  test("is refused when no turn is registered, and recorded once one is", async () => {
    await withSession(async (s) => {
      // The real run registered its turn; take it away to see the refusal.
      assert.ok(runningSessionTurn(s.id), "a running session has a registered turn");
      unregisterRunningSessionTurn(s.id);
      const refused = await s.call("repository_update_steps", { steps });
      assert.equal(refused.status, 400);
      assert.equal(
        refused.body.error,
        "This turn is not running in a way that can show steps, so the list was not recorded.",
      );
      assert.equal(await AppDataSource.getRepository(RepositoryWorkSessionEvent).count(), 0);

      const turn = await AppDataSource.getRepository(RepositoryWorkSessionTurn).findOneByOrFail({
        sessionId: s.id,
      });
      const recorder = new SessionActivityRecorder(
        { companyId: company.id, repositoryId: repository.id, sessionId: s.id, turnId: turn.id },
        await nextSessionEventOrdinal(s.id),
      );
      const controller = new AbortController();
      registerRunningSessionTurn(s.id, { controller, recorder, stoppedByUserId: null });

      const res = await s.call("repository_update_steps", { steps });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, {
        ok: true,
        done: 1,
        total: 3,
        steps: ["1. [completed] Read the plan", "2. [in_progress] Edit it", "3. [pending] Commit"],
      });

      await recorder.finish();
      const rows = await AppDataSource.getRepository(RepositoryWorkSessionEvent).findBy({
        sessionId: s.id,
      });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].kind, "steps");
      assert.equal(rows[0].turnId, turn.id);
      assert.equal(rows[0].ordinal, 1);
      assert.equal(rows[0].summary, "1 of 3 steps done");
      assert.deepEqual(JSON.parse(rows[0].detailJson), { steps });
    });
  });

  test("lands in the feed of a session that is really running", async () => {
    const s = await openSession();
    const res = await s.call("repository_update_steps", { steps: steps.slice(0, 1) });
    assert.equal(res.status, 200);
    await s.finish();

    const rows = await AppDataSource.getRepository(RepositoryWorkSessionEvent).findBy({
      sessionId: s.id,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, "steps");
    assert.equal(rows[0].summary, "1 of 1 steps done");
    assert.equal(runningSessionTurn(s.id), null, "a finished turn is no longer registered");
  });

  test("refuses a list with two steps in progress, and an unknown status", async () => {
    await withSession(async (s) => {
      const two = await s.call("repository_update_steps", {
        steps: [
          { text: "One", status: "in_progress" },
          { text: "Two", status: "in_progress" },
        ],
      });
      assert.equal(two.status, 400);
      assert.equal(two.body.error, "Only one step can be in_progress at a time.");

      const unknown = await s.call("repository_update_steps", {
        steps: [{ text: "One", status: "done" }],
      });
      assert.equal(unknown.status, 400);
      assert.equal(unknown.body.error, "ValidationError");
    });
  });
});

// ─────────────────────────── the allowlist ──────────────────────────────

describe("what a session token may reach", () => {
  test("nothing outside the repository tools, whatever the employee discovers", async () => {
    await withSession(async (s) => {
      const res = await s.call("list_routines", {});
      assert.equal(res.status, 403);
      assert.match(res.body.error ?? "", /only use the repository_\* tools/);
    });
  });

  test("every repository tool, including the ones that answer with a refusal", async () => {
    await withSession(async (s) => {
      for (const tool of REPOSITORY_SESSION_TOOLS) {
        const res = await s.call(tool, {});
        assert.notEqual(res.status, 403, `${tool} must not be refused by the allowlist`);
      }
    });
  });

  test("outside a session, the tools say how to get into one", async () => {
    const bearer = memberToken();
    try {
      const calls: Array<[string, unknown]> = [
        ["repository_list_files", {}],
        ["repository_read_file", { path: "README.md" }],
        ["repository_edit_file", { path: "README.md", old_string: "a", new_string: "b" }],
        ["repository_write_file", { path: "x.md", content: "x" }],
        ["repository_search", { pattern: "x" }],
        ["repository_glob", { pattern: "*" }],
        ["repository_status", {}],
        ["repository_diff", {}],
        ["repository_update_steps", { steps: [] }],
        ["repository_commit", { message: "x" }],
      ];
      for (const [tool, body] of calls) {
        const res = await callWith(bearer, tool, body);
        assert.equal(res.status, 400, tool);
        assert.match(res.body.error ?? "", /you are not in one/, tool);
        assert.match(res.body.error ?? "", /start_repository_work_session/, tool);
      }
    } finally {
      revokeMcpToken(bearer);
    }
  });
});
