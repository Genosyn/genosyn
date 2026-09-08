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
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import { issueMcpToken, revokeMcpToken } from "../services/mcpTokens.js";
import { sessionWorktreePath } from "../services/repositoryWorkSessions.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";
// The client's own parser, deliberately. Chat opens this session beside the
// conversation instead of navigating to it, which only works if the link this
// tool dictates is one that parser recognises.
import { parseRepositoryWorkHref } from "../../client/lib/repositoryWorkLink.js";

/**
 * `start_repository_work_session` — the tool that lets an employee open the
 * door the `repository_*` tools work behind.
 *
 * The interesting cases are all refusals. Starting a session is the one part
 * of the repository flow an employee may now do on its own initiative, so what
 * bounds it is the whole security story: it acts only for a signed-in Member,
 * only on a repository it holds a Grant for, only once at a time, and never
 * from inside a session.
 */

let server: Server;
let baseUrl = "";
let token = "";
let dataDir: string;
const originalDataDir = config.dataDir;

let company: Company;
let employee: AIEmployee;
let requester: User;
let repository: Repository;

before(async () => {
  await initTestDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-session-tool-"));
  (config as { dataDir: string }).dataDir = dataDir;
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
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
  (config as { dataDir: string }).dataDir = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
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
    configJson: '{"apiKeyEncrypted":"test-placeholder"}',
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
  token = memberToken();
});

function memberToken(): string {
  return issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: requester.id,
    requesterSessionVersion: requester.sessionVersion,
  });
}

async function callWith(bearer: string, tool: string, body: unknown = {}) {
  const response = await fetch(`${baseUrl}/internal/mcp/tools/${tool}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
      // A session's detached half shells out to git, which stalls the loop
      // long enough for a pooled keep-alive socket to be reset under us. One
      // connection per call costs nothing here and removes the flake.
      connection: "close",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : {}) as Record<string, unknown> & { error?: string },
  };
}

async function start(body: unknown) {
  return callWith(token, "start_repository_work_session", body);
}

async function grantAccess(): Promise<void> {
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "write",
  });
}

/** A session row in the state the tool's guards care about. */
async function runningSession(): Promise<RepositoryWorkSession> {
  return insert(RepositoryWorkSession, {
    companyId: company.id,
    repositoryId: repository.id,
    employeeId: employee.id,
    requestedByUserId: requester.id,
    instruction: "Update the plan",
    status: "running",
  });
}

/**
 * The handler answers before the session's turn is over — that is the point of
 * it. Waiting for the row to settle keeps the detached half from running on
 * against a database the next test has already reset.
 */
async function settle(sessionId: string): Promise<void> {
  const repo = AppDataSource.getRepository(RepositoryWorkSession);
  for (let i = 0; i < 200; i += 1) {
    const row = await repo.findOneBy({ id: sessionId });
    if (!row || row.status !== "running") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("starting a work session from a tool call", () => {
  test("ordinary Members cannot delegate the forge delivery tool", async () => {
    const row = await runningSession();
    const result = await callWith(token, "open_repository_work_session_pull_request", {
      sessionId: row.id,
    });
    assert.equal(result.status, 403);
    assert.match(result.body.error ?? "", /owner or admin/);
  });

  test("a result lookup cannot read another employee's session", async () => {
    await grantAccess();
    const row = await runningSession();
    await AppDataSource.getRepository(RepositoryWorkSession).update(row.id, {
      employeeId: "another",
    });
    const result = await callWith(token, "get_repository_work_session", { sessionId: row.id });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /not found/);
  });

  test("result lookups require a live Repository Grant", async () => {
    const row = await runningSession();
    const result = await callWith(token, "get_repository_work_session", { sessionId: row.id });
    assert.equal(result.status, 400);
    assert.match(result.body.error ?? "", /read Grant/);
  });

  test("result and delivery arguments are validated at the API boundary", async () => {
    const result = await callWith(token, "get_repository_work_session", { sessionId: "invalid" });
    assert.equal(result.status, 400);
    await AppDataSource.getRepository(Membership).update(
      { userId: requester.id },
      { role: "admin" },
    );
    const delivery = await callWith(token, "open_repository_work_session_pull_request", {
      sessionId: "invalid",
      branch: "main",
    });
    assert.equal(delivery.status, 400);
  });

  test("refuses a repository the employee has no Grant for without confirming it exists", async () => {
    const res = await start({ repository: "strategy", instruction: "Update the plan" });

    assert.equal(res.status, 400);
    assert.match(res.body.error ?? "", /not been granted any repositories/);
    assert.doesNotMatch(
      res.body.error ?? "",
      /Strategy/,
      "an ungranted repository must not be named back",
    );
    assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 0);
  });

  test("a wrong name is answered with the repositories it actually has", async () => {
    await grantAccess();
    const res = await start({ repository: "nope", instruction: "Update the plan" });

    assert.equal(res.status, 400);
    assert.match(res.body.error ?? "", /Strategy \(strategy\)/);
  });

  test("refuses an unattended turn with only a read Grant", async () => {
    await insert(EmployeeRepositoryGrant, {
      employeeId: employee.id,
      repositoryId: repository.id,
      accessLevel: "read",
    });
    const employeeAuthority = issueMcpToken(employee.id, company.id, { authority: "employee" });
    try {
      const res = await callWith(employeeAuthority, "start_repository_work_session", {
        repository: "strategy",
        instruction: "Update the plan",
      });

      assert.equal(res.status, 400);
      assert.match(res.body.error ?? "", /not been granted write access/);
      assert.equal(await AppDataSource.getRepository(RepositoryWorkSession).count(), 0);
    } finally {
      revokeMcpToken(employeeAuthority);
    }
  });

  test("refuses a second session while the first is still running", async () => {
    await grantAccess();
    await runningSession();

    const res = await start({ repository: "strategy", instruction: "Also fix the typo" });

    assert.equal(res.status, 400);
    assert.match(res.body.error ?? "", /already have a work session running/);
    assert.equal(
      await AppDataSource.getRepository(RepositoryWorkSession).count(),
      1,
      "the refused request must not leave a second row behind",
    );
  });
});

describe("what a session's own turn may reach", () => {
  /** A token shaped like the one a running session's nested turn carries. */
  async function sessionToken(): Promise<string> {
    const session = await runningSession();
    return issueMcpToken(employee.id, company.id, {
      authority: "member",
      requesterUserId: requester.id,
      requesterSessionVersion: requester.sessionVersion,
      repositoryWorkSessionId: session.id,
    });
  }

  test("a session cannot start another session, so sessions cannot nest", async () => {
    await grantAccess();
    const bearer = await sessionToken();
    try {
      const res = await callWith(bearer, "start_repository_work_session", {
        repository: "strategy",
        instruction: "And another thing",
      });

      assert.equal(res.status, 403);
      assert.match(res.body.error ?? "", /only use the repository_\* tools/);
      assert.equal(
        await AppDataSource.getRepository(RepositoryWorkSession).count(),
        1,
        "no second session may be created",
      );
    } finally {
      revokeMcpToken(bearer);
    }
  });

  test("a session cannot reach tools outside the repository, whatever it discovers", async () => {
    const bearer = await sessionToken();
    try {
      // `send_mail` is an ordinary Member tool this employee could call on any
      // other turn. Its briefing promises a session affects nobody until a
      // human merges the diff, and that has to be true of every tool, not just
      // the six it was shown.
      const res = await callWith(bearer, "send_mail", {
        accountId: "whatever",
        to: "someone@example.com",
        subject: "hi",
        body: "hi",
      });

      assert.equal(res.status, 403);
      assert.match(res.body.error ?? "", /only use the repository_\* tools/);
    } finally {
      revokeMcpToken(bearer);
    }
  });

  test("but it can still use the repository tools it was sent to use", async () => {
    const bearer = await sessionToken();
    try {
      const res = await callWith(bearer, "repository_list_files", {});
      // It gets as far as resolving the worktree — which does not exist for a
      // row inserted straight into the database — rather than being refused
      // for the tool it chose.
      assert.notEqual(res.status, 403);
    } finally {
      revokeMcpToken(bearer);
    }
  });

  test("the command tool is one of them, and answers with a readable refusal", async () => {
    // The suite runs with command execution off, which is exactly the case
    // worth pinning: the tool must still be *reachable*, and must explain
    // itself, rather than coming back as "you may only use the repository_*
    // tools" — which would be both wrong and impossible to act on.
    const bearer = await sessionToken();
    try {
      const res = await callWith(bearer, "repository_run_command", { command: "npm test" });
      assert.notEqual(res.status, 403);
    } finally {
      revokeMcpToken(bearer);
    }
  });
});

describe("commands in a package directory", () => {
  async function commandSession(t: { after: (fn: () => void) => void }) {
    await grantAccess();
    const session = await runningSession();
    const directory = sessionWorktreePath(repository, session.id);
    fs.mkdirSync(path.join(directory, "App"), { recursive: true });
    fs.writeFileSync(path.join(directory, ".git"), "gitdir: /elsewhere/.git/worktrees/test\n");
    fs.writeFileSync(path.join(directory, "marker.txt"), "repository root");
    fs.writeFileSync(path.join(directory, "App", "marker.txt"), "App checked");
    fs.writeFileSync(
      path.join(directory, "App", "package.json"),
      JSON.stringify({ name: "guide-command-fixture", scripts: { lint: "cat marker.txt" } }),
    );
    const shim = path.join(dataDir, "command-bwrap");
    fs.writeFileSync(
      shim,
      [
        "#!/bin/bash",
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        '    --setenv) export "$2"="$3"; shift 3 ;;',
        "    --) shift; break ;;",
        "    *) shift ;;",
        "  esac",
        "done",
        'exec "$@"',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const originalCoding = { ...config.agent.codingTools };
    Object.assign(config.agent.codingTools, {
      enabled: true,
      executionMode: "bubblewrap",
      bubblewrapPath: shim,
    });
    t.after(() => Object.assign(config.agent.codingTools, originalCoding));
    await AppDataSource.getRepository(Repository).update(repository.id, {
      commandMode: "allowlist",
      allowedCommands: "",
    });
    const bearer = issueMcpToken(employee.id, company.id, {
      authority: "member",
      requesterUserId: requester.id,
      requesterSessionVersion: requester.sessionVersion,
      repositoryWorkSessionId: session.id,
    });
    t.after(() => revokeMcpToken(bearer));
    return { bearer, directory };
  }

  test("runs the package's lint script and returns its actual directory", async (t) => {
    const { bearer } = await commandSession(t);
    const result = await callWith(bearer, "repository_run_command", {
      command: "npm run lint",
      cwd: "App",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ran, true);
    assert.equal(result.body.exitCode, 0, String(result.body.output));
    assert.equal(result.body.command, "npm run lint");
    assert.equal(result.body.cwd, "App");
    assert.match(String(result.body.output), /App checked/);
  });

  test("omitting cwd runs at the root and reports that directory", async (t) => {
    const { bearer } = await commandSession(t);
    const result = await callWith(bearer, "repository_run_command", { command: "cat marker.txt" });
    assert.equal(result.status, 200);
    assert.equal(result.body.ran, true);
    assert.equal(result.body.exitCode, 0);
    assert.equal(result.body.cwd, ".");
    assert.equal(result.body.output, "repository root");
  });

  test("a failed command still records where it ran", async (t) => {
    const { bearer } = await commandSession(t);
    const result = await callWith(bearer, "repository_run_command", {
      command: "false",
      cwd: "App",
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.ran, true);
    assert.equal(result.body.exitCode, 1);
    assert.equal(result.body.cwd, "App");
  });

  test("validates the optional cwd field at the API boundary", async (t) => {
    const { bearer } = await commandSession(t);
    for (const cwd of [42, {}, null, "x".repeat(1001)]) {
      const result = await callWith(bearer, "repository_run_command", { command: "true", cwd });
      assert.equal(result.status, 400);
    }
    const unknown = await callWith(bearer, "repository_run_command", {
      command: "true",
      directory: "App",
    });
    assert.equal(
      unknown.status,
      400,
      "an unknown directory parameter must not silently run at root",
    );
  });

  test("a missing or invalid directory produces an explicit non-execution result", async (t) => {
    const { bearer } = await commandSession(t);
    for (const cwd of ["missing", "marker.txt", "../outside", "/tmp", ".git"]) {
      const result = await callWith(bearer, "repository_run_command", { command: "true", cwd });
      assert.equal(result.status, 200);
      assert.equal(result.body.ran, false);
      assert.match(String(result.body.reason), /Could not prepare the command/);
      assert.equal(result.body.exitCode, undefined);
      assert.equal(
        result.body.cwd,
        undefined,
        "a refused command must not claim it ran in a directory",
      );
    }
  });

  test("choosing a package preserves allowed-command and Grant enforcement", async (t) => {
    const { bearer, directory } = await commandSession(t);
    await AppDataSource.getRepository(Repository).update(repository.id, {
      allowedCommands: "npm run lint",
    });
    const refused = await callWith(bearer, "repository_run_command", {
      command: "touch unexpected.txt",
      cwd: "App",
    });
    assert.equal(refused.status, 200);
    assert.equal(refused.body.ran, false);
    assert.match(String(refused.body.reason), /not on this repository's list/);
    assert.equal(fs.existsSync(path.join(directory, "App", "unexpected.txt")), false);
    await AppDataSource.getRepository(EmployeeRepositoryGrant).delete({ employeeId: employee.id });
    const revoked = await callWith(bearer, "repository_run_command", {
      command: "npm run lint",
      cwd: "App",
    });
    assert.equal(revoked.status, 400);
    assert.match(revoked.body.error ?? "", /not been granted/);
  });
});

/**
 * Last, because these are the only tests that let the detached half actually
 * run. It cuts a real worktree and shells out to git, and doing that alongside
 * the refusal tests above stalls the loop enough to reset their connections.
 */
describe("a session that really starts", () => {
  test("trusted unattended work starts using its own Grant and records no fictional Member", async () => {
    await grantAccess();
    const bearer = issueMcpToken(employee.id, company.id, { authority: "employee" });
    try {
      const res = await callWith(bearer, "start_repository_work_session", {
        repository: "strategy",
        instruction: "Investigate the customer's reported issue",
      });
      assert.equal(res.status, 200);
      const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
        id: res.body.sessionId as string,
      });
      assert.equal(row.requestedByUserId, null);
      assert.equal(row.employeeId, employee.id);
      assert.match(String(res.body.note), /Wakeup/);
      await settle(row.id);
      const report = await callWith(bearer, "get_repository_work_session", { sessionId: row.id });
      assert.equal(report.status, 200);
      assert.equal(report.body.sessionId, row.id);
    } finally {
      revokeMcpToken(bearer);
    }
  });

  test("hands back the session and where to review it", async () => {
    await grantAccess();
    const res = await start({ repository: "strategy", instruction: "Update the plan" });

    assert.equal(res.status, 200);
    assert.equal(res.body.repository, "strategy");
    assert.equal(res.body.status, "running");
    assert.ok(res.body.sessionId, "the employee must be told which session it started");
    assert.equal(
      res.body.reviewUrl,
      `/c/acme/repositories/strategy/ai/${res.body.sessionId as string}`,
      "the link must open the session itself, not the list it is somewhere in",
    );

    // The employee is told to paste one exact markdown link, and chat reads
    // that link to decide whether to open the work beside the thread. If the
    // note stops dictating a link, or dictates a different shape, the panel
    // silently stops opening — so the contract is pinned from both ends.
    const note = String(res.body.note ?? "");
    assert.ok(
      note.includes(`[Strategy → AI work](${res.body.reviewUrl as string})`),
      "the note must dictate the exact markdown chat knows how to open",
    );
    assert.deepEqual(
      parseRepositoryWorkHref(res.body.reviewUrl as string, "acme"),
      { repositorySlug: "strategy", sessionId: res.body.sessionId as string },
      "the chat panel must recognise the link this tool hands out",
    );
    assert.ok(
      /opens beside this conversation/.test(note),
      "the employee should say where the work opens, because that is where it opens",
    );

    const row = await AppDataSource.getRepository(RepositoryWorkSession).findOneBy({
      id: res.body.sessionId as string,
    });
    assert.ok(row);
    assert.equal(row.instruction, "Update the plan");
    assert.equal(row.title, "Update the plan", "a session the employee opened is still named");
    assert.equal(row.turnCount, 1, "the opening instruction is the session's first turn");
    assert.equal(row.employeeId, employee.id);
    // The session runs for the Member, which is whose access it uses.
    assert.equal(row.requestedByUserId, requester.id);

    await settle(res.body.sessionId as string);
  });

  /**
   * `list_repositories` is owner/admin-only and the repositories prompt
   * section is absent on a standard install, so an employee often has no way
   * to have learned a slug. Accepting the name a human would have said is what
   * keeps the tool usable on its own.
   */
  test("accepts the repository's name, not only its slug", async () => {
    await grantAccess();
    const res = await start({ repository: "Strategy", instruction: "Update the plan" });

    assert.equal(res.status, 200);
    assert.equal(res.body.repository, "strategy");
    await settle(res.body.sessionId as string);
  });

  /**
   * Nothing reconciles `running` at boot, so a process killed mid-session
   * leaves a row that says `running` for good. If that blocked the tool, one
   * crash would disable it for that employee and repository permanently — and
   * the Member has no way to clear it, because the UI only offers Throw away
   * on a session that has finished.
   */
  test("is not blocked forever by a session left running by a crash", async () => {
    await grantAccess();
    const stale = await runningSession();
    // Older than a turn is allowed to live, so nothing is still working on it.
    await AppDataSource.getRepository(RepositoryWorkSession).update(stale.id, {
      createdAt: new Date(Date.now() - 7 * 60 * 60 * 1000),
    });

    const res = await start({ repository: "strategy", instruction: "Update the plan" });

    assert.equal(res.status, 200);
    await settle(res.body.sessionId as string);
  });
});
