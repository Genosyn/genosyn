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
import {
  ForgeApiError,
  GITHUB_ENDPOINT,
  forgejoEndpoint,
  parseForgeRemote,
  type ForgeEndpoint,
} from "../integrations/providers/forge/client.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { encryptConnectionConfig } from "./integrations.js";
import { encryptRepoSecret } from "./repositories.js";
import type { ForgePullRequest } from "./repositoryForge.js";
import type { ChatResult, chatWithEmployee } from "./chat.js";
import {
  openRepositoryWorkSessionPullRequest,
  publishRepositoryWorkSession,
  resolveRepositoryForge,
  resolveSessionCheckout,
  sessionCommit,
  sessionWriteFile,
  startRepositoryWorkSession,
  type WorkSessionPullRequestDeps,
} from "./repositoryWorkSessions.js";

/**
 * Handing a session's work to a git forge as a pull request.
 *
 * The network is stubbed — what is worth testing is everything around it: that
 * the branch is pushed *before* the pull request is asked for, that the push
 * is recorded on the row before anything that can fail, that pressing the
 * button twice updates rather than fails, that a repository which cannot have
 * a pull request says so instead of failing inside an API call, and that the
 * credential comes from somewhere the model cannot reach.
 *
 * Every one of those now has to hold on two forges rather than one, and the
 * sentences a Member reads have to name the right one. So the shared cases run
 * against both endpoints, and the two error vocabularies — GitHub's nested
 * `errors[]`, Forgejo's flat `{message}` — are asserted separately, because a
 * matcher that only reads `fieldCode()` passes every GitHub test and silently
 * degrades to a bare validation string on Forgejo.
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

const FORGEJO_BASE = "https://git.acme.com";
const FORGEJO_ENDPOINT = forgejoEndpoint(FORGEJO_BASE);
const GITHUB_GIT_URL = "https://github.com/acme/product.git";
const FORGEJO_GIT_URL = `${FORGEJO_BASE}/acme/product.git`;

/** One forge to run a shared behaviour against. */
type ForgeCase = {
  /** What the sentences a Member reads should call it. */
  name: string;
  endpoint: ForgeEndpoint;
  gitUrl: string;
  /** Web URL shape differs: GitHub says `/pull/42`, Forgejo says `/pulls/42`. */
  pullUrl: string;
};

const FORGE_CASES: readonly ForgeCase[] = [
  {
    name: "GitHub",
    endpoint: GITHUB_ENDPOINT,
    gitUrl: GITHUB_GIT_URL,
    pullUrl: "https://github.com/acme/product/pull/42",
  },
  {
    name: "Forgejo",
    endpoint: FORGEJO_ENDPOINT,
    gitUrl: FORGEJO_GIT_URL,
    pullUrl: `${FORGEJO_BASE}/acme/product/pulls/42`,
  },
];

const GITHUB_CASE = FORGE_CASES[0];
const FORGEJO_CASE = FORGE_CASES[1];

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
  // Created local, promoted to a remote per test by `asRemote`. Sessions have
  // to run first, and materializing a *remote* repository would clone it —
  // these tests must never touch the network, and a test that silently depends
  // on github.com/acme/product existing is not a test.
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
async function asRemote(gitUrl = GITHUB_GIT_URL): Promise<void> {
  await AppDataSource.getRepository(Repository).update(
    { id: repository.id },
    { origin: "remote", gitUrl },
  );
}

/** Load the repository row back, for assertions about what was written to it. */
async function storedRepository(): Promise<Repository> {
  return AppDataSource.getRepository(Repository).findOneByOrFail({ id: repository.id });
}

/** Load the session row back, rather than trusting the in-memory entity. */
async function storedSession(id: string): Promise<RepositoryWorkSession> {
  return AppDataSource.getRepository(RepositoryWorkSession).findOneByOrFail({ id });
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

type CreateCall = {
  endpoint: ForgeEndpoint;
  token: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
  title: string;
  body: string;
};

type LookupCall = {
  endpoint: ForgeEndpoint;
  token: string;
  owner: string;
  repo: string;
  head: string;
  number?: number | null;
};

type BaseCall = { endpoint: ForgeEndpoint; token: string; owner: string; repo: string };

type Recorded = {
  pushed: string[];
  created: CreateCall[];
  looked: LookupCall[];
  /** Every call to the forge's default-branch lookup, so a path that must not
   *  resolve a base can prove it did not. */
  baseLookups: BaseCall[];
};

function recorder(): Recorded {
  return { pushed: [], created: [], looked: [], baseLookups: [] };
}

/**
 * Both default-branch lookups are stubbed by default, and deliberately return
 * nothing. The real ones reach the forge's API and the local clone
 * respectively; leaving either unstubbed would put these tests on the network.
 * A test that cares what the trunk is says so explicitly through `options`.
 */
function stubDeps(
  recorded: Recorded,
  options: {
    /** Which forge `resolveForge` claims this repository lives on. */
    forge?: ForgeCase;
    token?: string;
    existing?: ForgePullRequest | null;
    remoteDefaultBranch?: string | null;
    localDefaultBranch?: string | null;
    /** Which branches the remote is pretending to already have. */
    remoteBranches?: string[];
    createFails?: unknown;
    pushFails?: unknown;
  } = {},
): Partial<WorkSessionPullRequestDeps> {
  const forge = options.forge ?? GITHUB_CASE;
  const token = options.token ?? "forge-token";
  return {
    push: (async (_repo: Repository, branch: string) => {
      recorded.pushed.push(branch);
      if (options.pushFails) throw options.pushFails;
      return { branch };
    }) as WorkSessionPullRequestDeps["push"],
    resolveForge: async () => ({
      endpoint: forge.endpoint,
      token,
      remote: { owner: "acme", repo: "product" },
      name: forge.name,
    }),
    remoteDefaultBranch: async (endpoint, callToken, owner, repo) => {
      recorded.baseLookups.push({ endpoint, token: callToken, owner, repo });
      return options.remoteDefaultBranch ?? null;
    },
    localDefaultBranch: async () => options.localDefaultBranch ?? null,
    branchExists: async (_repo, name) => (options.remoteBranches ?? []).includes(name),
    findOpenPullRequest: async (endpoint, callToken, args) => {
      recorded.looked.push({ ...args, endpoint, token: callToken });
      return options.existing ?? null;
    },
    createPullRequest: async (endpoint, callToken, args) => {
      recorded.created.push({ ...args, endpoint, token: callToken });
      if (options.createFails) throw options.createFails;
      return { number: 42, htmlUrl: forge.pullUrl, state: "open" };
    },
  };
}

describe("opening a pull request", () => {
  for (const forge of FORGE_CASES) {
    test(`${forge.name}: pushes the branch, opens the request, and records it on the session`, async () => {
      const session = await readySession();
      await asRemote(forge.gitUrl);
      const recorded = recorder();

      const updated = await openRepositoryWorkSessionPullRequest({
        sessionId: session.id,
        deps: stubDeps(recorded, { forge, token: "forge-token" }),
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
      // The endpoint and token come from one resolution, so a self-hosted
      // forge cannot end up being asked at api.github.com with its own token.
      assert.equal(recorded.created[0].endpoint, forge.endpoint);
      assert.equal(recorded.created[0].token, "forge-token");
      assert.equal(recorded.looked[0].endpoint, forge.endpoint);

      assert.equal(updated.status, "proposed");
      assert.equal(updated.pullRequestNumber, 42);
      assert.equal(updated.pullRequestUrl, forge.pullUrl);
      assert.equal(updated.publishedBranch, session.branch);
    });
  }

  test("records the pushed branch before the API call, so a later failure still says the work left the building", async () => {
    const session = await readySession();
    await asRemote();
    await assert.rejects(() =>
      openRepositoryWorkSessionPullRequest({
        sessionId: session.id,
        deps: stubDeps(recorder(), {
          createFails: new ForgeApiError("Validation Failed", 422, { message: "boom" }, "github"),
        }),
      }),
    );

    const stored = await storedSession(session.id);
    assert.equal(
      stored.publishedBranch,
      session.branch,
      "the push cannot be recalled, so the branch it created must be on the row",
    );
    assert.equal(stored.status, "ready", "a refused pull request leaves the session reviewable");
    assert.equal(stored.pullRequestUrl, null);
  });

  test("describes the work with the session's title and the employee's report", async () => {
    const session = await readySession();
    await asRemote();
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
    await asRemote();
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

  /**
   * Both forges reject an over-long body, and an employee's report of a large
   * refactor is genuinely long. Truncating with a pointer back to the session
   * is the difference between a pull request that opens and one that dies on a
   * validation error nobody can act on.
   */
  test("truncates a report too long for the forge and says where the rest is", async () => {
    const session = await readySession();
    await asRemote();
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { reply: "x".repeat(70_000) },
    );
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded),
    });

    assert.equal(recorded.created[0].body.length, 65_536);
    assert.match(recorded.created[0].body, /_Truncated — the full report is on the session/);
  });

  test("truncates a body the Member wrote too, not only the composed one", async () => {
    const session = await readySession();
    await asRemote();
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      body: "y".repeat(70_000),
      deps: stubDeps(recorded),
    });
    assert.equal(recorded.created[0].body.length, 65_536);
    assert.match(recorded.created[0].body, /_Truncated — the full report is on the session/);
  });

  test("leaves a report that fits exactly as the employee wrote it", async () => {
    const session = await readySession();
    await asRemote();
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded),
    });
    assert.doesNotMatch(recorded.created[0].body, /_Truncated/);
  });

  for (const forge of FORGE_CASES) {
    test(`${forge.name}: pressing it again pushes the new commits into the request already open`, async () => {
      const session = await readySession();
      await asRemote(forge.gitUrl);
      await openRepositoryWorkSessionPullRequest({
        sessionId: session.id,
        deps: stubDeps(recorder(), { forge }),
      });

      const second = recorder();
      const updated = await openRepositoryWorkSessionPullRequest({
        sessionId: session.id,
        deps: stubDeps(second, {
          forge,
          existing: { number: 42, htmlUrl: forge.pullUrl, state: "open" },
        }),
      });

      assert.deepEqual(second.pushed, [session.branch], "the update is the push");
      assert.equal(second.created.length, 0, "a second pull request must not be opened");
      // The number goes with the lookup: it is the only way to find the open
      // pull request again with a credential that may create one but may not
      // list them, which otherwise made every press after the first fail.
      assert.deepEqual(
        second.looked.map((call) => ({
          owner: call.owner,
          repo: call.repo,
          head: call.head,
          number: call.number,
        })),
        [{ owner: "acme", repo: "product", head: session.branch as string, number: 42 }],
      );
      // Updating keeps the base the pull request was opened with, so nothing
      // in this path needs to know what the trunk is called — and a forge that
      // is down or a credential that cannot read the repository must not stop
      // a Member from pushing a revision.
      assert.deepEqual(second.baseLookups, [], "the base must not be resolved again");
      assert.equal(updated.pullRequestNumber, 42);
      assert.equal(updated.pullRequestUrl, forge.pullUrl);
      assert.equal(updated.status, "proposed");
    });
  }

  test("still lets a Member merge the work here afterwards", async () => {
    const session = await readySession();
    await asRemote();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorder()),
    });
    const published = await publishRepositoryWorkSession(session.id, { push: false });
    assert.equal(published.status, "published");
  });

  test("does not ask the forge for anything when the push fails", async () => {
    const session = await readySession();
    await asRemote();
    const recorded = recorder();
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({
          sessionId: session.id,
          deps: stubDeps(recorded, { pushFails: new Error("remote rejected the push") }),
        }),
      /remote rejected/,
    );
    assert.equal(recorded.created.length, 0);
    assert.equal(recorded.looked.length, 0);
    const unchanged = await storedSession(session.id);
    assert.equal(unchanged.status, "ready", "a failed push leaves the session reviewable");
    assert.equal(unchanged.pullRequestUrl, null);
    assert.equal(
      unchanged.publishedBranch,
      null,
      "nothing reached the remote, so nothing may claim it did",
    );
  });
});

describe("refusing to open a pull request at all", () => {
  test("a session that committed nothing", async () => {
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
    await asRemote();
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({
          sessionId: session.id,
          deps: stubDeps(recorder()),
        }),
      /no committed work/,
    );
  });

  test("a session whose branch was lost", async () => {
    const session = await readySession();
    await asRemote();
    await AppDataSource.getRepository(RepositoryWorkSession).update(
      { id: session.id },
      { branch: null },
    );
    const recorded = recorder();
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({
          sessionId: session.id,
          deps: stubDeps(recorded),
        }),
      /no branch/,
    );
    assert.deepEqual(recorded.pushed, [], "there is nothing to push without a branch");
  });

  test("a repository that lives only in Genosyn", async () => {
    const session = await readySession();
    const recorded = recorder();
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({ sessionId: session.id, deps: stubDeps(recorded) }),
      /nowhere to open a pull request/,
    );
    assert.deepEqual(recorded.pushed, [], "nothing may be pushed by a refused request");
  });

  /**
   * The refusal this whole change exists to fix. A host no Connection speaks
   * for is a host Genosyn has not been *configured* for — not a host that is
   * "not GitHub". Telling somebody running their own Forgejo that pull
   * requests are a GitHub feature sent them looking for a product limitation
   * that does not exist, instead of at the Connection they had not made.
   */
  test("a host no forge Connection speaks for says to connect it, not that this is a GitHub feature", async () => {
    const session = await readySession();
    await asRemote("https://gitlab.com/acme/product.git");
    const recorded = recorder();
    const error = await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      // The real resolver, deliberately: this refusal is its job.
      deps: { push: stubDeps(recorded).push },
    }).then(
      () => null,
      (err: unknown) => err as Error,
    );

    assert.ok(error, "a host with no forge behind it cannot open a pull request");
    assert.match(
      error.message,
      /does not know how to open a pull request on this repository's host/,
    );
    assert.match(error.message, /Forgejo \/ Gitea/, "the self-hosted option has to be named");
    assert.doesNotMatch(
      error.message,
      /only supported for GitHub|GitHub feature/,
      "a self-hosted forge is not an unsupported one",
    );
    assert.deepEqual(recorded.pushed, [], "a repository with no forge is never pushed to");
  });

  test("an unknown session", async () => {
    await assert.rejects(
      () =>
        openRepositoryWorkSessionPullRequest({
          sessionId: "8f3f6d0e-0000-4000-8000-000000000000",
          deps: stubDeps(recorder()),
        }),
      /not found/,
    );
  });
});

/**
 * The bug this covers: `Repository.defaultBranch` is pre-filled with `main` by
 * the create form and never checked against the remote, so every repository
 * whose trunk is `master` opened its pull requests against a branch that does
 * not exist — and the forge answered with an unreadable "Validation Failed".
 */
describe("choosing the branch to open the pull request against", () => {
  test("keeps a stored branch the remote actually has, and does not rewrite the row", async () => {
    const session = await readySession();
    await asRemote();
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      { defaultBranch: "develop" },
    );
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded, { remoteDefaultBranch: "master", remoteBranches: ["develop"] }),
    });

    assert.equal(recorded.created[0].base, "develop", "a Member's choice is not overridden");
    assert.equal((await storedRepository()).defaultBranch, "develop");
  });

  test("asks the forge for the real trunk when the stored branch is not on the remote", async () => {
    const session = await readySession();
    await asRemote();
    const recorded = recorder();

    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded, { remoteDefaultBranch: "master" }),
    });

    assert.equal(recorded.created[0].base, "master");
    assert.deepEqual(
      recorded.baseLookups.map((call) => ({ owner: call.owner, repo: call.repo })),
      [{ owner: "acme", repo: "product" }],
      "the trunk is asked for on the same forge the pull request goes to",
    );
  });

  test("writes the correction back so the rest of the product stops being wrong", async () => {
    const session = await readySession();
    await asRemote();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorder(), { remoteDefaultBranch: "master" }),
    });

    assert.equal((await storedRepository()).defaultBranch, "master");
  });

  test("falls back to the clone's own origin/HEAD when the forge cannot be asked", async () => {
    const session = await readySession();
    await asRemote();
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded, { remoteDefaultBranch: null, localDefaultBranch: "trunk" }),
    });
    assert.equal(recorded.created[0].base, "trunk");
    assert.equal((await storedRepository()).defaultBranch, "trunk");
  });

  test("keeps the stored value when nothing else knows better", async () => {
    const session = await readySession();
    await asRemote();
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded),
    });
    assert.equal(recorded.created[0].base, "main");
    assert.equal((await storedRepository()).defaultBranch, "main", "nothing was detected to write");
  });

  test("falls back to main when the row carries no branch and nobody answers", async () => {
    const session = await readySession();
    await asRemote();
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      { defaultBranch: "" },
    );
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded),
    });
    assert.equal(recorded.created[0].base, "main");
  });

  /**
   * The API's answer is written straight onto the row that the branch-checkout
   * and branch-create paths later validate. A forge that returns something
   * that is not a legal git ref — a compromised or simply broken one — must
   * not be able to put it there.
   */
  test("refuses a branch name from the API that git would not accept", async () => {
    const session = await readySession();
    await asRemote();
    const recorded = recorder();
    await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorded, { remoteDefaultBranch: "--upload-pack=touch /tmp/pwned" }),
    });

    assert.equal(recorded.created[0].base, "main", "the stored branch survives a bad answer");
    assert.equal((await storedRepository()).defaultBranch, "main", "and the row is not poisoned");
  });
});

/**
 * The half most likely to fail on somebody else's repository: a credential
 * that cloned a public repo read-only cannot push a branch to it. Git's own
 * stderr never names Genosyn's side of that, so it read as a broken button.
 */
describe("when the push is refused", () => {
  async function refusal(message: string, forge: ForgeCase = GITHUB_CASE): Promise<Error> {
    const session = await readySession();
    await asRemote(forge.gitUrl);
    const error = await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorder(), { forge, pushFails: new Error(message) }),
    }).then(
      () => null,
      (err: unknown) => err as Error,
    );
    assert.ok(error, "a failed push must not resolve");
    return error;
  }

  test("a credential without write access names the account it authenticated as", async () => {
    const error = await refusal(
      "git push failed: remote: Permission to acme/product.git denied to octocat. | fatal: unable to access",
    );
    assert.match(error.message, /^GitHub refused the push to acme\/product:/);
    assert.match(error.message, /authenticates as "octocat", which cannot write/);
  });

  test("the same refusal on a self-hosted forge names that forge, not GitHub", async () => {
    const error = await refusal(
      "git push failed: remote: Permission to acme/product.git denied to ada.",
      FORGEJO_CASE,
    );
    assert.match(error.message, /^Forgejo refused the push to acme\/product:/);
    assert.doesNotMatch(error.message, /GitHub/);
  });

  test("a rejected credential points at the token, not at the branch", async () => {
    const error = await refusal(
      "git push failed: fatal: Authentication failed for 'https://github.com/acme/product.git/'",
    );
    assert.match(error.message, /acme\/product rejected the credential Genosyn pushed with/);
    assert.match(error.message, /reconnect GitHub in Settings → Integrations/);
  });

  test("a rejected credential on a self-hosted forge sends the Member to that Connection", async () => {
    const error = await refusal(
      "git push failed: could not read Username for 'https://git.acme.com': terminal prompts disabled",
      FORGEJO_CASE,
    );
    assert.match(error.message, /reconnect Forgejo in Settings → Integrations/);
  });

  test("a GitHub ruleset says which rule and offers the way round it", async () => {
    const error = await refusal(
      "git push failed: remote: error: GH013: Repository rule violations found for refs/heads/genosyn/ada/abcd1234",
    );
    assert.match(error.message, /acme\/product has a rule that refuses this push/);
    assert.match(error.message, /accept the work here instead/);
    assert.match(error.message, /GH013/, "the raw git output is kept for whoever owns the rules");
  });

  test("GitHub's other protected-branch code is recognised too", async () => {
    const error = await refusal(
      "git push failed: remote: error: GH006: Protected branch update failed",
    );
    assert.match(error.message, /has a rule that refuses this push/);
  });

  /**
   * Forgejo refuses a protected branch in its own words. Matching only
   * GitHub's `GH0xx` codes would drop a self-hosted install straight back to
   * raw git stderr — which is the exact failure this function exists to end.
   */
  test("Forgejo's own protected-branch wording is recognised as the same thing", async () => {
    const error = await refusal(
      "git push failed: remote: Gitea: branch is protected | ! [remote rejected] main -> main (pre-receive hook declined)",
      FORGEJO_CASE,
    );
    assert.match(error.message, /has a rule that refuses this push/);
  });

  test("a branch someone else moved says to start again rather than blaming the credential", async () => {
    const session = await readySession();
    await asRemote();
    const error = await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorder(), {
        pushFails: new Error(
          "git push failed: ! [rejected] non-fast-forward | hint: Updates were rejected because the tip is behind",
        ),
      }),
    }).then(
      () => null,
      (err: unknown) => err as Error,
    );
    assert.ok(error);
    assert.match(error.message, new RegExp(`The branch "${session.branch}" on acme/product`));
    assert.match(error.message, /has moved on since Genosyn last pushed it/);
    assert.match(error.message, /start a new session/);
  });

  test("a repository the credential cannot see names the forge to reconnect", async () => {
    const error = await refusal(
      "git push failed: remote: Repository not found. | fatal: repository not found",
      FORGEJO_CASE,
    );
    assert.match(error.message, /Forgejo cannot find acme\/product with this credential/);
    assert.match(error.message, /Forgejo Connection can see the repository/);
  });

  test("an unrecognised git failure is passed through unchanged rather than reworded", async () => {
    const original = new Error("git push failed: something entirely new");
    const session = await readySession();
    await asRemote();
    const error = await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorder(), { pushFails: original }),
    }).then(
      () => null,
      (err: unknown) => err as Error,
    );
    assert.equal(error, original, "a message nobody has a better sentence for is left alone");
  });
});

/**
 * Two forges, two error envelopes, one set of sentences.
 *
 * GitHub nests the useful half in `errors: [{field, code, message}]`; Forgejo
 * sends a flat `{message}` and nothing else, so `fieldCode()` returns null on
 * every Forgejo error. Every case below is therefore asserted on both shapes —
 * a matcher that only reads `fieldCode` passes the GitHub half and silently
 * degrades to a bare validation string exactly where a self-hoster is.
 */
describe("when the forge refuses the pull request", () => {
  async function refusal(error: unknown, forge: ForgeCase = GITHUB_CASE): Promise<Error> {
    const session = await readySession();
    await asRemote(forge.gitUrl);
    const thrown = await openRepositoryWorkSessionPullRequest({
      sessionId: session.id,
      deps: stubDeps(recorder(), { forge, createFails: error }),
    }).then(
      () => null,
      (err: unknown) => err as Error,
    );
    assert.ok(thrown, "a refused pull request must not resolve");
    return thrown;
  }

  function githubValidation(errors: unknown[], message = "Validation Failed"): ForgeApiError {
    return new ForgeApiError(message, 422, { message, errors }, "github");
  }

  function forgejoError(message: string, status: number): ForgeApiError {
    // Forgejo's whole error body, verbatim: a message and a doc link.
    return new ForgeApiError(
      message,
      status,
      { message, url: `${FORGEJO_BASE}/api/swagger` },
      "forgejo",
    );
  }

  test("GitHub: a bad base branch names the branch and where to fix it", async () => {
    const error = await refusal(
      githubValidation([{ resource: "PullRequest", field: "base", code: "invalid" }]),
    );
    assert.match(error.message, /acme\/product has no branch called "main"/);
    assert.match(error.message, /check it in repository settings/);
  });

  test("Forgejo: a bad base branch reaches the same sentence through the flat message", async () => {
    const error = await refusal(forgejoError("Base branch does not exist", 422), FORGEJO_CASE);
    assert.match(error.message, /acme\/product has no branch called "main"/);
    assert.match(error.message, /Genosyn asks Forgejo for the repository's default branch/);
  });

  test("GitHub: an unpushed head branch points at the push, not at the base", async () => {
    const error = await refusal(
      githubValidation([{ resource: "PullRequest", field: "head", code: "invalid" }]),
    );
    assert.match(error.message, /GitHub cannot see the branch "genosyn\//);
    assert.match(error.message, /allowed to push branches/);
  });

  test("Forgejo: an unpushed head branch reaches the same sentence", async () => {
    const error = await refusal(forgejoError("Head branch does not exist", 422), FORGEJO_CASE);
    assert.match(error.message, /Forgejo cannot see the branch "genosyn\//);
  });

  test("GitHub: an empty branch says there is nothing to propose", async () => {
    const error = await refusal(
      githubValidation([{ message: "No commits between main and genosyn/ada/abcd1234" }]),
    );
    assert.match(error.message, /There is nothing to propose/);
    assert.match(error.message, /holds no commits that "main" does not already have/);
  });

  test("Forgejo: an empty branch reaches the same sentence", async () => {
    const error = await refusal(
      forgejoError("The branches are identical, there is nothing to compare", 422),
      FORGEJO_CASE,
    );
    assert.match(error.message, /There is nothing to propose/);
  });

  test("GitHub: a duplicate pull request says the push still landed", async () => {
    const error = await refusal(
      githubValidation([
        { message: "A pull request already exists for acme:genosyn/ada/abcd1234." },
      ]),
    );
    assert.match(error.message, /already exists on acme\/product/);
    assert.match(error.message, /Open it on GitHub — the push above brought it up to date/);
  });

  /**
   * The most common way to reach any of this is pressing the button twice, and
   * Forgejo answers that with a status GitHub never uses. A 409 that fell past
   * the 422 branch would report the forge's raw wording instead of the one
   * thing a Member needs to know: the revision was pushed anyway.
   */
  test("Forgejo: a duplicate pull request answers 409 and still says the push landed", async () => {
    const error = await refusal(
      forgejoError("pull request already exists for these targets", 409),
      FORGEJO_CASE,
    );
    assert.match(error.message, /already exists on acme\/product/);
    assert.match(error.message, /Open it on Forgejo — the push above brought it up to date/);
  });

  test("Forgejo: an archived repository says so instead of blaming the credential", async () => {
    const error = await refusal(forgejoError("Repository is archived", 423), FORGEJO_CASE);
    assert.match(error.message, /acme\/product is archived on Forgejo/);
    assert.doesNotMatch(error.message, /credential/, "nothing about the token is wrong here");
  });

  test("a permission failure points at the credential, not at the branch", async () => {
    const error = await refusal(
      new ForgeApiError(
        "Resource not accessible by integration",
        403,
        { message: "Resource not accessible by integration" },
        "github",
      ),
    );
    assert.match(error.message, /GitHub refused to open a pull request on acme\/product/);
    assert.match(error.message, /pull-request write access/);
  });

  test("Forgejo: a permission failure names Forgejo", async () => {
    const error = await refusal(
      forgejoError("token does not have at least one of required scope(s)", 403),
      FORGEJO_CASE,
    );
    assert.match(error.message, /Forgejo refused to open a pull request on acme\/product/);
    assert.match(error.message, /pull-request write access/);
  });

  test("Forgejo: a repository the token cannot see says to check the clone URL", async () => {
    const error = await refusal(forgejoError("The target couldn't be found.", 404), FORGEJO_CASE);
    assert.match(error.message, /Forgejo cannot find acme\/product with this credential/);
    assert.match(error.message, /Forgejo Connection can see the repository/);
  });

  test("Forgejo: a validation nobody has a sentence for keeps the forge's own wording", async () => {
    const error = await refusal(
      forgejoError("user does not exist [uid: 0, name: acme]", 422),
      FORGEJO_CASE,
    );
    assert.match(error.message, /user does not exist \[uid: 0, name: acme\]/);
  });

  test("a failure that is not a forge error at all is passed through unchanged", async () => {
    const original = new Error("socket hang up");
    const error = await refusal(original);
    assert.equal(error, original);
  });

  test("the session stays reviewable when the forge refuses", async () => {
    const session = await readySession();
    await asRemote();
    await assert.rejects(() =>
      openRepositoryWorkSessionPullRequest({
        sessionId: session.id,
        deps: stubDeps(recorder(), {
          createFails: githubValidation([{ field: "base", code: "invalid" }]),
        }),
      }),
    );
    const unchanged = await storedSession(session.id);
    assert.equal(unchanged.status, "ready");
    assert.equal(unchanged.pullRequestUrl, null);
  });
});

/**
 * Where the credential and the API root come from.
 *
 * These two used to be one question answered by comparing a hostname to
 * `github.com`. They are now independent: *where* comes from the host, and a
 * host is only a forge because a Connection carries its base URL; *which
 * credential* is the older rule, unchanged.
 */
describe("resolving a repository's forge", () => {
  async function reload(): Promise<Repository> {
    return storedRepository();
  }

  async function connectForgejo(
    label: string,
    overrides: Partial<{ baseUrl: string; apiKey: string; login: string }> = {},
  ): Promise<IntegrationConnection> {
    return insert(IntegrationConnection, {
      companyId: company.id,
      provider: "forgejo",
      label,
      authMode: "apikey",
      status: "connected",
      encryptedConfig: encryptConnectionConfig(
        {
          baseUrl: overrides.baseUrl ?? FORGEJO_BASE,
          apiKey: overrides.apiKey ?? "forgejo_connection_token",
          login: overrides.login ?? "ada",
        } as never,
        company.id,
      ),
    });
  }

  test("a repository with its own HTTPS token uses that token, not a Connection's", async () => {
    await asRemote();
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
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      {
        authMode: "https",
        httpsUsername: "x-access-token",
        encryptedToken: encryptRepoSecret("ghp_repo_token", company.id),
      },
    );

    const forge = await resolveRepositoryForge(await reload());
    assert.equal(forge.token, "ghp_repo_token");
    assert.equal(forge.name, "GitHub");
    assert.deepEqual(forge.remote, { owner: "acme", repo: "product" });
    assert.equal(forge.endpoint.apiBase, "https://api.github.com");
  });

  /**
   * Falling through to the Connection here used to report "no credential at
   * all" and send someone to connect the forge — which would not have helped,
   * because the Connection lookup only answers for a repository with no
   * credential of its own. A token that will not decrypt has exactly one
   * remedy, and it is not that one.
   */
  test("a token that will not decrypt says to re-enter it instead of blaming the Connection", async () => {
    await asRemote();
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
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      { authMode: "https", httpsUsername: "x-access-token", encryptedToken: "not-a-cipher-blob" },
    );

    const error = await resolveRepositoryForge(await reload()).then(
      () => null,
      (err: unknown) => err as Error,
    );
    assert.ok(error);
    assert.match(error.message, /could not be decrypted/);
    assert.match(error.message, /Re-enter it in repository settings/);
    assert.doesNotMatch(
      error.message,
      /Settings → Integrations/,
      "connecting the forge again would not fix this",
    );
  });

  test("a repository with no credential of its own borrows the company's Connection", async () => {
    await asRemote();
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

    const forge = await resolveRepositoryForge(await reload());
    assert.equal(forge.token, "ghp_connection_token");
    assert.equal(forge.name, "GitHub");
  });

  /**
   * The case the whole change exists for: a repository on a server the company
   * hosts. Nothing about the URL says "forge" — it is a forge because a
   * Forgejo Connection carries that base URL and nothing else.
   */
  test("a self-hosted remote resolves through the Connection that carries its server URL", async () => {
    await asRemote(FORGEJO_GIT_URL);
    await connectForgejo("Acme Forgejo");

    const forge = await resolveRepositoryForge(await reload());
    assert.equal(forge.token, "forgejo_connection_token");
    assert.equal(forge.name, "Forgejo");
    assert.equal(forge.endpoint.apiBase, `${FORGEJO_BASE}/api/v1`);
    assert.deepEqual(forge.remote, { owner: "acme", repo: "product" });
  });

  test("a Connection for a different server does not speak for this one", async () => {
    await asRemote(FORGEJO_GIT_URL);
    await connectForgejo("Other Forgejo", { baseUrl: "https://git.other.test" });

    await assert.rejects(
      async () => resolveRepositoryForge(await reload()),
      /does not know how to open a pull request/,
    );
  });

  /**
   * A second kind of forge must not make every repository ambiguous. Host
   * matching runs before counting, so exactly one Connection can ever speak
   * for a given remote.
   */
  test("a company with both a GitHub and a Forgejo Connection is not ambiguous", async () => {
    await asRemote();
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
    await connectForgejo("Acme Forgejo");

    const forge = await resolveRepositoryForge(await reload());
    assert.equal(forge.token, "ghp_connection_token");
    assert.equal(forge.name, "GitHub");
  });

  test("two Connections that could both reach the server name the count and which ones", async () => {
    await asRemote(FORGEJO_GIT_URL);
    await connectForgejo("Platform team");
    await connectForgejo("Release bot");

    const error = await resolveRepositoryForge(await reload()).then(
      () => null,
      (err: unknown) => err as Error,
    );
    assert.ok(error);
    assert.match(
      error.message,
      /This company has 2 Forgejo Connections that could reach this server/,
    );
    assert.match(error.message, /Platform team/);
    assert.match(error.message, /Release bot/);
    assert.match(error.message, /give it its own HTTPS token/);
  });

  test("an ambiguity is settled by the Connection pinned on the repository", async () => {
    await asRemote(FORGEJO_GIT_URL);
    const chosen = await connectForgejo("Platform team", { apiKey: "pinned_token" });
    await connectForgejo("Release bot", { apiKey: "other_token" });
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      { githubConnectionId: chosen.id },
    );

    const forge = await resolveRepositoryForge(await reload());
    assert.equal(forge.token, "pinned_token");
  });

  test("a Connection missing its token names the forge to reconnect", async () => {
    await asRemote(FORGEJO_GIT_URL);
    await connectForgejo("Acme Forgejo", { apiKey: "" });

    await assert.rejects(
      async () => resolveRepositoryForge(await reload()),
      /Forgejo Connection is missing its credentials/,
    );
  });

  test("says so when there is no credential at all, naming the forge to connect", async () => {
    await asRemote();
    await assert.rejects(
      async () => resolveRepositoryForge(await reload()),
      /No GitHub credential is available for this repository/,
    );
  });

  test("a repository that authenticates with an SSH key is told why that cannot work", async () => {
    // An https clone URL with `authMode: "ssh"` is the shape that reaches this
    // branch: the URL is what makes the host knowable, the auth mode is what
    // makes the credential unusable for an API call.
    await asRemote();
    await AppDataSource.getRepository(Repository).update(
      { id: repository.id },
      { authMode: "ssh" },
    );

    const error = await resolveRepositoryForge(await reload()).then(
      () => null,
      (err: unknown) => err as Error,
    );
    assert.ok(error);
    assert.match(error.message, /SSH key, which cannot open a pull request/);
    assert.match(error.message, /connect GitHub in Settings → Integrations/);
  });

  test("an scp-style SSH remote is a host no forge can be matched to", async () => {
    await asRemote("git@github.com:acme/product.git");
    await assert.rejects(
      async () => resolveRepositoryForge(await reload()),
      /does not know how to open a pull request on this repository's host/,
    );
  });
});

/**
 * Which repository a clone URL names, for the forge that claims it. This was
 * `parseGithubRemote` and a hostname comparison; it is now the rule that
 * decides whether a Connection's token may be sent to a host at all, so the
 * cases it used to protect are worth keeping here beside the code that
 * depends on them.
 */
describe("reading a forge remote", () => {
  test("splits owner and repository out of a clone URL", () => {
    assert.deepEqual(parseForgeRemote(GITHUB_ENDPOINT, "https://github.com/acme/product.git"), {
      owner: "acme",
      repo: "product",
    });
    assert.deepEqual(parseForgeRemote(GITHUB_ENDPOINT, "https://github.com/acme/product"), {
      owner: "acme",
      repo: "product",
    });
    assert.deepEqual(parseForgeRemote(GITHUB_ENDPOINT, "https://github.com/Acme/Product.GIT"), {
      owner: "Acme",
      repo: "Product",
    });
  });

  test("refuses anything the endpoint cannot serve", () => {
    assert.equal(parseForgeRemote(GITHUB_ENDPOINT, "git@github.com:acme/product.git"), null);
    assert.equal(parseForgeRemote(GITHUB_ENDPOINT, "https://gitlab.com/acme/product.git"), null);
    assert.equal(parseForgeRemote(GITHUB_ENDPOINT, "https://github.com/acme"), null);
    assert.equal(parseForgeRemote(GITHUB_ENDPOINT, "not a url"), null);
    assert.equal(parseForgeRemote(GITHUB_ENDPOINT, ""), null);
  });

  test("a self-hosted endpoint serves its own host and nothing else", () => {
    assert.deepEqual(parseForgeRemote(FORGEJO_ENDPOINT, FORGEJO_GIT_URL), {
      owner: "acme",
      repo: "product",
    });
    // A port is part of the origin: the same name on another port is another
    // server, and must not receive this Connection's token.
    assert.equal(
      parseForgeRemote(FORGEJO_ENDPOINT, "https://git.acme.com:8443/acme/product.git"),
      null,
    );
    assert.equal(
      parseForgeRemote(FORGEJO_ENDPOINT, "https://git.acme.com.evil.test/acme/product.git"),
      null,
    );
    assert.equal(parseForgeRemote(FORGEJO_ENDPOINT, GITHUB_GIT_URL), null);
  });

  test("a base URL typed with a trailing slash or an /api/v1 suffix means the same server", () => {
    for (const typed of [`${FORGEJO_BASE}/`, `${FORGEJO_BASE}/api/v1`, `${FORGEJO_BASE}/api/v1/`]) {
      const endpoint = forgejoEndpoint(typed);
      assert.equal(endpoint.apiBase, `${FORGEJO_BASE}/api/v1`, typed);
      assert.deepEqual(parseForgeRemote(endpoint, FORGEJO_GIT_URL), {
        owner: "acme",
        repo: "product",
      });
    }
  });
});
