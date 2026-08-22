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

  test("refuses a turn no signed-in Member is driving", async () => {
    await grantAccess();
    const employeeAuthority = issueMcpToken(employee.id, company.id, { authority: "employee" });
    try {
      const res = await callWith(employeeAuthority, "start_repository_work_session", {
        repository: "strategy",
        instruction: "Update the plan",
      });

      assert.equal(res.status, 403);
      assert.match(res.body.error ?? "", /access of the Member who asked for it/);
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
});

/**
 * Last, because these are the only tests that let the detached half actually
 * run. It cuts a real worktree and shells out to git, and doing that alongside
 * the refusal tests above stalls the loop enough to reset their connections.
 */
describe("a session that really starts", () => {
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
