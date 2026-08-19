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
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Repository } from "../db/entities/Repository.js";
import { RepositoryWorkSession } from "../db/entities/RepositoryWorkSession.js";
import { User } from "../db/entities/User.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { encryptConnectionConfig } from "./integrations.js";
import { encryptRepoSecret } from "./repositories.js";
import {
  parseGithubRemote,
  type GithubPullRequest,
  type GithubPullRequestArgs,
} from "./repositoryGithub.js";
import type { ChatResult, chatWithEmployee } from "./chat.js";
import {
  openRepositoryWorkSessionPullRequest,
  publishRepositoryWorkSession,
  resolveRepositoryGithubToken,
  sessionCommit,
  sessionWriteFile,
  startRepositoryWorkSession,
  type WorkSessionPullRequestDeps,
} from "./repositoryWorkSessions.js";
import { resolveSessionCheckout } from "./repositoryWorkSessions.js";

/**
 * Handing a session's work to GitHub as a pull request.
 *
 * The network is stubbed — what is worth testing is everything around it: that
 * the branch is pushed *before* the pull request is asked for, that pressing
 * the button twice updates rather than fails, that a repository which cannot
 * have a pull request says so instead of failing inside an API call, and that
 * the credential comes from somewhere the model cannot reach.
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "genosyn-repo-pr-"));
  (config as { dataDir: string }).dataDir = dataDir;
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
  // Created local, promoted to a GitHub remote per test by `asGithubRemote`.
  // Sessions have to run first, and materializing a *remote* repository would
  // clone it — these tests must never touch the network, and a test that
  // silently depends on github.com/acme/product existing is not a test.
  repository = await insert(Repository, {
    companyId: company.id,
    name: "Product",
    slug: "product",
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
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: repository.id,
    accessLevel: "write",
  });
});

/**
 * Point the repository at a remote, after the session has already been cut.
 *
 * Nothing in the pull-request path materializes a checkout, so the remote can
 * arrive late — which is exactly what keeps git off the network here.
 */
async function asGithubRemote(gitUrl = "https://github.com/acme/product.git"): Promise<void> {
  await AppDataSource.getRepository(Repository).update(
    { id: repository.id },
    { origin: "remote", gitUrl },
  );
}

function stubChat(work: (directory: string) => Promise<void> | void): typeof chatWithEmployee {
  return (async (_companyId, _employeeId, _message, _history, options) => {
    const sessionId = (options as { repositoryWorkSessionId?: string })?.repositoryWorkSessionId;
    assert.ok(sessionId);
    const checkout = await resolveSessionCheckout(company.id, sessionId);
    await work(checkout.directory);
    return {
      status: "ok",
      reply: "Added the endpoint and a test.",
      attachmentIds: [],
      sidecars: {},
    } as ChatResult;
  }) as typeof chatWithEmployee;
}

async function readySession(): Promise<RepositoryWorkSession> {
  return startRepositoryWorkSession({
    companyId: company.id,
    repositoryId: repository.id,
    employeeId: employee.id,
    instruction: "Add a health check endpoint",
    requesterUserId: requester.id,
    requesterSessionVersion: 1,
    runChat: stubChat(async (directory) => {
      sessionWriteFile(directory, "health.ts", "export const ok = true;\n");
      await sessionCommit(repository, directory, "Add a health check");
    }),
  });
}

type Recorded = {
  pushed: string[];
  created: GithubPullRequestArgs[];
  looked: Array<{ owner: string; repo: string; head: string }>;
};

function stubDeps(
  recorded: Recorded,
  options: { existing?: GithubPullRequest | null } = {},
): Partial<WorkSessionPullRequestDeps> {
  return {
    push: (async (_repo: Repository, branch: string) => {
      recorded.pushed.push(branch);
      return { branch };
    }) as WorkSessionPullRequestDeps["push"],
    resolveToken: async () => "gh-token",
    findOpenPullRequest: async (_token, args) => {
      recorded.looked.push(args);
      return options.existing ?? null;
    },
    createPullRequest: async (_token, args) => {
      recorded.created.push(args);
      return { number: 42, htmlUrl: "https://github.com/acme/product/pull/42", state: "open" };
    },
  };
}

function recorder(): Recorded {
  return { pushed: [], created: [], looked: [] };
}

describe("opening a pull request", () => {
  test("pushes the branch, opens the request, and records it on the session", async () => {
    const session = await readySession();
    await asGithubRemote();
    const recorded = recorder();

    const updated = await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded),
    });

    assert.deepEqual(recorded.pushed, [session.branch]);
    assert.equal(recorded.created.length, 1);
    assert.deepEqual(
      {
        owner: recorded.created[0].owner,
        repo: recorded.created[0].repo,
        head: recorded.created[0].head,
        base: recorded.created[0].base,
      },
      { owner: "acme", repo: "product", head: session.branch, base: "main" },
    );
    assert.equal(updated.status, "proposed");
    assert.equal(updated.pullRequestNumber, 42);
    assert.equal(updated.pullRequestUrl, "https://github.com/acme/product/pull/42");
    assert.equal(updated.publishedBranch, session.branch);
  });

  test("describes the work with the session's title and the employee's report", async () => {
    const session = await readySession();
    await asGithubRemote();
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded),
    });

    assert.equal(recorded.created[0].title, "Add a health check endpoint");
    assert.match(recorded.created[0].body, /Add a health check endpoint/);
    assert.match(recorded.created[0].body, /Added the endpoint and a test\./);
    assert.match(recorded.created[0].body, /Genosyn AI work session/);
  });

  test("uses a title and body the Member wrote instead", async () => {
    const session = await readySession();
    await asGithubRemote();
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      title: "Health endpoint",
      body: "Reviewed by me first.",
      deps: stubDeps(recorded),
    });
    assert.equal(recorded.created[0].title, "Health endpoint");
    assert.equal(recorded.created[0].body, "Reviewed by me first.");
  });

  test("pressing it again pushes the new commits into the request already open", async () => {
    const session = await readySession();
    await asGithubRemote();
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded),
    });

    const second = recorder();
    const updated = await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(second, {
        existing: { number: 42, htmlUrl: "https://github.com/acme/product/pull/42", state: "open" },
      }),
    });

    assert.deepEqual(second.pushed, [session.branch], "the update is the push");
    assert.equal(second.created.length, 0, "a second pull request must not be opened");
    assert.deepEqual(second.looked, [
      { owner: "acme", repo: "product", head: session.branch as string },
    ]);
    assert.equal(updated.pullRequestNumber, 42);
    assert.equal(updated.status, "proposed");
  });

  test("still lets a Member merge the work here afterwards", async () => {
    const session = await readySession();
    await asGithubRemote();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorder()),
    });
    const published = await publishRepositoryWorkSession(session.id, { push: false });
    assert.equal(published.status, "published");
  });

  test("refuses a session that committed nothing", async () => {
    const session = await startRepositoryWorkSession({
      companyId: company.id,
      repositoryId: repository.id,
      employeeId: employee.id,
      instruction: "Have a look",
      requesterUserId: requester.id,
      requesterSessionVersion: 1,
      runChat: stubChat(() => {}),
    });
    assert.equal(session.status, "empty");
    await asGithubRemote();
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({
          sessionId: session.id,
          deps: stubDeps(recorder()),
        }),
      /no committed work/,
    );
  });

  test("refuses a repository that lives only in Genosyn", async () => {
    const session = await readySession();
    const recorded = recorder();
    await assert.rejects(
      () => openRepositoryWorkSessionPullRequest({ sessionId: session.id, deps: stubDeps(recorded) }),
      /nowhere to open a pull request/,
    );
    assert.deepEqual(recorded.pushed, [], "nothing may be pushed by a refused request");
  });

  test("refuses a remote that is not GitHub", async () => {
    const session = await readySession();
    await asGithubRemote("https://gitlab.com/acme/product.git");
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({
          sessionId: session.id,
          deps: stubDeps(recorder()),
        }),
      /only supported for GitHub remotes/,
    );
  });

  test("refuses an unknown session", async () => {
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({
          sessionId: "8f3f6d0e-0000-4000-8000-000000000000",
          deps: stubDeps(recorder()),
        }),
      /not found/,
    );
  });

  test("does not ask GitHub for anything when the push fails", async () => {
    const session = await readySession();
    await asGithubRemote();
    const recorded = recorder();
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({
          sessionId: session.id,
          deps: {
            ...stubDeps(recorded),
            push: (async () => {
              throw new Error("remote rejected the push");
            }) as WorkSessionPullRequestDeps["push"],
          },
        }),
      /remote rejected/,
    );
    assert.equal(recorded.created.length, 0);
    const unchanged = await AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(unchanged.status, "ready", "a failed push leaves the session reviewable");
    assert.equal(unchanged.pullRequestUrl, null);
  });
});

describe("where the GitHub credential comes from", () => {
  test("uses the repository's own token when it has one", async () => {
    await asGithubRemote();
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      {
        authMode: "https",
        httpsUsername: "x-access-token",
        encryptedToken: encryptRepoSecret("ghp_repo_token", company.id),
      },
    );
    const repo = await AppDataSource.getRepository(Repository).findOneByOrFail({
      id: repository.id,
    });
    assert.equal(await resolveRepositoryGithubToken(repo), "ghp_repo_token");
  });

  test("falls back to the company's GitHub Connection", async () => {
    await asGithubRemote();
    await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "github",
      label: "GitHub",
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig(
        { apiKey: "ghp_connection_token", login: "acme" } as never,
        company.id,
      ),
    });
    const repo = await AppDataSource.getRepository(Repository).findOneByOrFail({
      id: repository.id,
    });
    assert.equal(await resolveRepositoryGithubToken(repo), "ghp_connection_token");
  });

  test("says so when there is no credential at all", async () => {
    await asGithubRemote();
    const repo = await AppDataSource.getRepository(Repository).findOneByOrFail({
      id: repository.id,
    });
    await assert.rejects(() => resolveRepositoryGithubToken(repo), /No GitHub credential/);
  });

  test("refuses a remote it could never authenticate", async () => {
    await asGithubRemote("git@github.com:acme/product.git");
    const repo = await AppDataSource.getRepository(Repository).findOneByOrFail({
      id: repository.id,
    });
    await assert.rejects(() => resolveRepositoryGithubToken(repo), /https:\/\/github\.com/);
  });
});

describe("reading a GitHub remote", () => {
  test("splits owner and repository out of a clone URL", () => {
    assert.deepEqual(parseGithubRemote("https://github.com/acme/product.git"), {
      owner: "acme",
      repo: "product",
    });
    assert.deepEqual(parseGithubRemote("https://github.com/acme/product"), {
      owner: "acme",
      repo: "product",
    });
    assert.deepEqual(parseGithubRemote("https://GitHub.com/Acme/Product.GIT"), {
      owner: "Acme",
      repo: "Product",
    });
  });

  test("refuses anything that is not a GitHub HTTPS clone URL", () => {
    assert.equal(parseGithubRemote("git@github.com:acme/product.git"), null);
    assert.equal(parseGithubRemote("https://gitlab.com/acme/product.git"), null);
    assert.equal(parseGithubRemote("https://github.com/acme"), null);
    assert.equal(parseGithubRemote("not a url"), null);
    assert.equal(parseGithubRemote(""), null);
  });
});
