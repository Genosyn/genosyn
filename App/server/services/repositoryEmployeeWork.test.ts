import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { CompanyPolicy } from "../db/entities/CompanyPolicy.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Membership } from "../db/entities/Membership.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { RepositoryWorkSessionTurn } from "../db/entities/RepositoryWorkSessionTurn.js";
import { User } from "../db/entities/User.js";
import { GITHUB_ENDPOINT } from "../integrations/providers/forge/client.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { encryptConnectionConfig } from "./integrations.js";
import {
  employeeRepositoryWorkSession,
  openEmployeeRepositoryWorkSessionPullRequest,
} from "./repositoryEmployeeWork.js";
import { sessionBranchName, type WorkSessionPullRequestDeps } from "./repositoryWorkSessions.js";

let company: Company;
let employee: AIEmployee;
let repository: Repository;
let connection: IntegrationConnection;
let session: RepositoryWorkSession;
let turn: RepositoryWorkSessionTurn;
let calls: string[];
let deps: Partial<WorkSessionPullRequestDeps>;

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  calls = [];
  company = await insert(Company, { name: "Acme", slug: "acme", ownerId: "owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Ada",
    slug: "ada",
    role: "Engineer",
  });
  connection = await insert(IntegrationConnection, {
    companyId: company.id,
    provider: "github",
    label: "Engineering",
    authMode: "apikey",
    status: "connected",
    encryptedConfig: encryptConnectionConfig({ token: "test-token" }),
  });
  repository = await insert(Repository, {
    companyId: company.id,
    name: "Product",
    slug: "product",
    origin: "remote",
    kind: "code",
    gitUrl: "https://github.com/acme/product.git",
    defaultBranch: "main",
    authMode: "none",
    githubConnectionId: connection.id,
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "write",
  });
  await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: connection.id });
  session = await insert(RepositoryWorkSession, {
    companyId: company.id,
    employeeId: employee.id,
    repositoryId: repository.id,
    requestedByUserId: null,
    instruction: "Fix the customer's issue",
    title: "Fix the issue",
    status: "ready",
    headCommit: "a".repeat(40),
    baseCommit: "b".repeat(40),
    turnCount: 1,
    reply: "Fixed the issue and added a passing regression test.",
  });
  session.branch = sessionBranchName(employee.slug, session.id);
  await AppDataSource.getRepository(RepositoryWorkSession).save(session);
  turn = await insert(RepositoryWorkSessionTurn, {
    companyId: company.id,
    sessionId: session.id,
    ordinal: 1,
    instruction: session.instruction,
    requestedByUserId: null,
    status: "ok",
    error: "",
  });
  deps = {
    resolveForge: async () => ({
      endpoint: GITHUB_ENDPOINT,
      token: "server-secret",
      remote: { owner: "acme", repo: "product" },
      name: "GitHub",
    }),
    push: async (_repo, branch) => {
      calls.push(`push:${branch}`);
      return { branch };
    },
    findOpenPullRequest: async () => {
      calls.push("find");
      return null;
    },
    branchExists: async () => true,
    createPullRequest: async (_endpoint, _token, args) => {
      calls.push("create");
      assert.equal(args.head, session.branch);
      assert.equal(args.base, "main");
      assert.equal(args.owner, "acme");
      assert.equal(args.repo, "product");
      return { number: 42, state: "open", htmlUrl: "https://github.com/acme/product/pull/42" };
    },
  };
});

function args() {
  return { companyId: company.id, employeeId: employee.id, sessionId: session.id };
}
function publish() {
  return openEmployeeRepositoryWorkSessionPullRequest({ ...args(), deps });
}
async function refuse(pattern: RegExp) {
  await assert.rejects(publish, pattern);
  assert.deepEqual(calls, [], "authorization must fail before any remote operation");
}

describe("proactive work-session results", () => {
  test("reads its own final report with a live read Grant", async () => {
    await AppDataSource.getRepository(EmployeeRepositoryGrant).update(
      { employeeId: employee.id },
      { accessLevel: "read" },
    );
    assert.equal((await employeeRepositoryWorkSession(args())).session.reply, session.reply);
  });
  test("does not reveal another employee's session", async () => {
    await assert.rejects(
      () => employeeRepositoryWorkSession({ ...args(), employeeId: "someone-else" }),
      /not found/,
    );
  });
  test("does not reveal another company's session", async () => {
    await assert.rejects(
      () => employeeRepositoryWorkSession({ ...args(), companyId: "another-company" }),
      /not found/,
    );
  });
  test("revoking a Repository Grant removes access to existing reports", async () => {
    await AppDataSource.getRepository(EmployeeRepositoryGrant).delete({ employeeId: employee.id });
    await assert.rejects(() => employeeRepositoryWorkSession(args()), /read Grant/);
  });
});

describe("bounded employee pull-request delivery", () => {
  test("checks company tool policy before any remote write", async () => {
    await insert(CompanyPolicy, {
      companyId: company.id,
      title: "Manual delivery",
      forbiddenTools: "open_repository_work_session_pull_request",
    });
    await refuse(/company policy.*Manual delivery/);
  });

  test("a company policy added during delivery stops the push", async () => {
    const resolve = deps.resolveForge!;
    deps.resolveForge = async (repo) => {
      await insert(CompanyPolicy, {
        companyId: company.id,
        title: "Manual delivery",
        forbiddenTools: "open_repository_work_session_pull_request",
      });
      return resolve(repo);
    };
    await refuse(/company policy/);
  });

  test("Member delegation is rechecked after resolving credentials", async () => {
    const member = await insert(User, {
      email: "admin@example.com",
      name: "Admin",
      passwordHash: "hash",
      sessionVersion: 1,
    });
    const membership = await insert(Membership, {
      companyId: company.id,
      userId: member.id,
      role: "admin",
    });
    const resolve = deps.resolveForge!;
    deps.resolveForge = async (repo) => {
      await AppDataSource.getRepository(Membership).update(membership.id, { role: "member" });
      return resolve(repo);
    };
    await assert.rejects(
      () =>
        openEmployeeRepositoryWorkSessionPullRequest({
          ...args(),
          deps,
          requester: { userId: member.id, sessionVersion: 1 },
        }),
      /no longer an owner or admin/,
    );
    assert.deepEqual(calls, []);
  });

  test("pushes only the session branch, then opens its PR and stores the URL", async () => {
    const result = await publish();
    assert.deepEqual(calls, [`push:${session.branch}`, "find", "create"]);
    assert.equal(result.status, "proposed");
    assert.equal(result.pullRequestUrl, "https://github.com/acme/product/pull/42");
    assert.equal(result.publishedBranch, session.branch);
  });
  test("reuses an existing PR on a retry", async () => {
    deps.findOpenPullRequest = async () => ({
      number: 7,
      state: "open",
      htmlUrl: "https://github.com/acme/product/pull/7",
    });
    assert.equal((await publish()).pullRequestNumber, 7);
    assert.deepEqual(calls, [`push:${session.branch}`]);
  });
  test("preserves evidence of a completed push when the PR API fails", async () => {
    deps.createPullRequest = async () => {
      throw new Error("forge unavailable");
    };
    await assert.rejects(publish, /forge unavailable/);
    const fresh = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(fresh.publishedBranch, session.branch);
    assert.equal(fresh.status, "ready");
    assert.equal(fresh.pullRequestUrl, null);
  });
  test("a failed push never creates a PR or records publication", async () => {
    deps.push = async () => {
      throw new Error("push failed");
    };
    await assert.rejects(publish, /push failed/);
    assert.deepEqual(calls, []);
    assert.equal(
      (await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({ id: session.id }))
        .publishedBranch,
      null,
    );
  });
  for (const status of ["running", "empty", "failed", "published", "discarded"] as const) {
    test(`refuses ${status} work before a remote write`, async () => {
      await AppDataSource.getRepository(RepositoryWorkSession).update(session.id, { status });
      await refuse(/no completed, committed work/);
    });
  }
  for (const status of ["running", "stopped", "failed"] as const) {
    test(`refuses a ready branch whose final turn was ${status}`, async () => {
      await AppDataSource.getRepository(RepositoryWorkSessionTurn).update(turn.id, { status });
      await refuse(/did not finish cleanly/);
    });
  }
  test("refuses work that hit its model-turn limit", async () => {
    await AppDataSource.getRepository(RepositoryWorkSessionTurn).update(turn.id, {
      error: "Reached turn limit",
    });
    await refuse(/did not finish cleanly/);
  });
  for (const branch of ["main", "release", "genosyn/another/session"]) {
    test(`cannot redirect delivery to ${branch}`, async () => {
      await AppDataSource.getRepository(RepositoryWorkSession).update(session.id, { branch });
      await refuse(/generated branch/);
    });
  }
  test("cannot publish a generated branch configured as the default branch", async () => {
    await AppDataSource.getRepository(Repository).update(repository.id, {
      defaultBranch: session.branch!,
    });
    await refuse(/generated branch/);
  });
  test("refuses a branch with no new commits", async () => {
    await AppDataSource.getRepository(RepositoryWorkSession).update(session.id, {
      headCommit: session.baseCommit,
    });
    await refuse(/generated branch/);
  });
  test("requires a live write Grant, not just read", async () => {
    await AppDataSource.getRepository(EmployeeRepositoryGrant).update(
      { employeeId: employee.id },
      { accessLevel: "read" },
    );
    await refuse(/write Grant/);
  });
  test("requires a separate Connection Grant", async () => {
    await AppDataSource.getRepository(EmployeeConnectionGrant).delete({ employeeId: employee.id });
    await refuse(/Grant.*Connection/);
  });
  for (const authMode of ["https", "ssh"] as const) {
    test(`cannot borrow a Repository's private ${authMode} credential`, async () => {
      await AppDataSource.getRepository(Repository).update(repository.id, { authMode });
      await refuse(/Member can publish/);
    });
  }
  test("requires an explicitly pinned Connection instead of the company's first matching account", async () => {
    await AppDataSource.getRepository(Repository).update(repository.id, {
      githubConnectionId: null,
    });
    await refuse(/connected through a granted/);
  });
  test("refuses a stale or disconnected Connection", async () => {
    await AppDataSource.getRepository(IntegrationConnection).update(connection.id, {
      status: "expired",
    });
    await refuse(/connected forge Connection/);
  });
  test("refuses cross-company Connection Grants", async () => {
    await AppDataSource.getRepository(IntegrationConnection).update(connection.id, {
      companyId: "other",
    });
    await refuse(/connected forge Connection/);
  });
  test("refuses a forge Connection on a different host", async () => {
    await AppDataSource.getRepository(Repository).update(repository.id, {
      gitUrl: "https://git.example.com/acme/product.git",
    });
    await refuse(/does not match/);
  });
  test("rechecks Grants after resolving credentials, before pushing", async () => {
    const resolve = deps.resolveForge!;
    deps.resolveForge = async (repo) => {
      await AppDataSource.getRepository(EmployeeConnectionGrant).delete({
        employeeId: employee.id,
      });
      return resolve(repo);
    };
    await refuse(/Grant/);
  });
  test("rechecks Grants after pushing, before opening the PR", async () => {
    deps.findOpenPullRequest = async () => {
      await AppDataSource.getRepository(EmployeeRepositoryGrant).delete({
        employeeId: employee.id,
      });
      return null;
    };
    await assert.rejects(publish, /write Grant/);
    assert.deepEqual(calls, [`push:${session.branch}`]);
  });
  test("rejects a remote changed while delivery is pending", async () => {
    const resolve = deps.resolveForge!;
    deps.resolveForge = async (repo) => {
      await AppDataSource.getRepository(Repository).update(repository.id, {
        gitUrl: "https://github.com/acme/another.git",
      });
      return resolve(repo);
    };
    await refuse(/changed before delivery/);
  });
  test("rejects concurrent attempts on the same session and releases the lock afterwards", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    deps.push = async (_repo, branch) => {
      entered();
      await gate;
      return { branch };
    };
    const first = publish();
    await ready;
    await assert.rejects(publish, /already opening/);
    await assert.rejects(
      () => openEmployeeRepositoryWorkSessionPullRequest({ ...args(), companyId: "other", deps }),
      /not found/,
      "a concurrent delivery must not reveal session activity to another company",
    );
    release();
    await first;
    assert.equal((await publish()).status, "proposed");
  });
  test("shared SaaS refuses employee delivery", async () => {
    const previous = config.security.multiTenant;
    (config.security as { multiTenant: boolean }).multiTenant = true;
    try {
      await refuse(/shared SaaS/);
    } finally {
      (config.security as { multiTenant: boolean }).multiTenant = previous;
    }
  });
});
