import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Repository } from "../db/entities/Repository.js";
import { Routine } from "../db/entities/Routine.js";
import type { IntegrationConfig } from "../integrations/types.js";
import { encryptSecret } from "../lib/secret.js";
import { errorHandler } from "../middleware/error.js";
import { mcpInternalRouter } from "../routes/mcpInternal.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { chatWithEmployee } from "./chat.js";
import {
  BRIEFED_CHECKOUTS_MAX,
  formatRepositoryCheckoutSyncReport,
  formatRepositoryCheckoutsBriefing,
  listEmployeeRepositoryCheckouts,
  resolveEmployeeRepositoryCheckout,
  type EmployeeRepositoryCheckout,
} from "./employeeRepositoryCheckouts.js";
import { GITHUB_ENDPOINT } from "../integrations/providers/forge/client.js";
import { encryptConnectionConfig } from "./integrations.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";
import { employeeDir } from "./paths.js";
import {
  composeRepositoriesContext,
  materializeEmployeeRepositoryContext,
  REPOSITORIES_CONTEXT_MAX_CHARS,
  type SyncedRepository,
} from "./repositories.js";
import type {
  ForgeCheckoutRef,
  ForgeRepoCredential,
  RepoSyncResult,
  SyncedRepo,
} from "./repoSync.js";
import { startRoutineRun } from "./runner.js";
import { waitForRoutineQueueIdle } from "./routineQueue.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import { stopStanddowns } from "./standdowns.js";

let tmp: string;
let cwd: string;
let company: Company;
let employee: AIEmployee;
let server: Server;
let serverUrl: string;
let mcpServer: Server;
let mcpUrl: string;
let modelRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let gitRequests = 0;
// Test fixtures temporarily change these boot settings and restore them below.
const dataConfig = config as { dataDir: string };
const securityConfig = config.security as { multiTenant: boolean };
const codingConfig = config.agent.codingTools as {
  executionMode: "host" | "disabled";
};
const originalConfig = {
  dataDir: config.dataDir,
  multiTenant: config.security.multiTenant,
  codingTools: { ...config.agent.codingTools },
  allowlist: [...config.security.outboundPrivateHostAllowlist],
};

before(async () => {
  await initTestDb();
  server = createServer(async (request, response) => {
    if (request.url?.startsWith("/v1/")) {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      modelRequests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
      response.write(
        `data: ${JSON.stringify({
          id: "guide-turn",
          object: "chat.completion.chunk",
          created: 1,
          model: "guide-test",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: "The repository guide was available for this work.",
              },
              finish_reason: "stop",
            },
          ],
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    gitRequests += 1;
    const relative = decodeURIComponent(
      new URL(request.url ?? "/", "http://fixture").pathname,
    ).replace(/^\/+/, "");
    const root = path.join(tmp, "remotes");
    const file = path.resolve(root, relative);
    if (!file.startsWith(`${root}${path.sep}`)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const body = fs.readFileSync(file);
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The internal tool API, called the way an employee's turn calls it.
  const mcpApp = express();
  mcpApp.use(express.json());
  mcpApp.use("/internal/mcp", mcpInternalRouter);
  mcpApp.use(errorHandler);
  await new Promise<void>((resolve) => {
    mcpServer = mcpApp.listen(0, "127.0.0.1", resolve);
  });
  mcpUrl = `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/internal/mcp`;
});

beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  await resetTestDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "employee-guides-"));
  dataConfig.dataDir = path.join(tmp, "data");
  securityConfig.multiTenant = false;
  Object.assign(config.agent.codingTools, {
    enabled: true,
    executionMode: "host",
    allowUnsafeHostExecution: true,
  });
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
  company = await insert(Company, { name: "Guide Co", slug: "guide-co", ownerId: "guide-owner" });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Guide Reader",
    slug: "guide-reader",
    role: "Engineering",
    browserEnabled: false,
  });
  cwd = employeeDir(company.slug, employee.slug);
  fs.mkdirSync(cwd, { recursive: true });
  modelRequests = [];
  gitRequests = 0;
});

afterEach(() => {
  stopStanddowns();
  resetRuntimeSettingsCacheForTests();
  fs.rmSync(tmp, { recursive: true, force: true });
});

after(async () => {
  await waitForRoutineQueueIdle();
  dataConfig.dataDir = originalConfig.dataDir;
  securityConfig.multiTenant = originalConfig.multiTenant;
  Object.assign(config.agent.codingTools, originalConfig.codingTools);
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...originalConfig.allowlist);
  for (const open of [server, mcpServer]) {
    if (!open) continue;
    open.closeAllConnections();
    await new Promise<void>((resolve) => open.close(() => resolve()));
  }
  await closeTestDb();
});

async function grantedCheckout(
  slug = "website",
  guideName = "AGENTS.md",
  body = "Run npm run lint before committing.",
) {
  const row = await insert(Repository, {
    companyId: company.id,
    name: slug,
    slug,
    gitUrl: `${serverUrl}/${slug}.git`,
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: row.id,
    accessLevel: "write",
  });
  const checkout = path.join(cwd, "repositories", slug);
  fs.mkdirSync(checkout, { recursive: true });
  if (body) fs.writeFileSync(path.join(checkout, guideName), body);
  const synced: SyncedRepository = {
    repositoryId: row.id,
    name: row.name,
    slug,
    defaultBranch: row.defaultBranch,
    accessLevel: "write",
    path: checkout,
  };
  return { row, synced, checkout };
}

async function context(repositories: SyncedRepository[], forgeRepositories: SyncedRepo[] = []) {
  return composeRepositoriesContext(employee.id, { cwd, repositories, forgeRepositories });
}

function emptyForgeSync(): RepoSyncResult {
  return { extraEnv: {}, repos: [], forgeRepoCredentials: [], errors: [] };
}

describe("materialized employee repository contributor context", () => {
  test("injects the real guide with scoped, model-visible paths and command requirements", async () => {
    const { synced } = await grantedCheckout();
    const result = await context([synced]);
    assert.match(result, /Run npm run lint before committing/);
    assert.match(result, /repositories\/website\/AGENTS.md/);
    assert.match(result, /applies only to its named repository/);
    assert.match(result, /cannot override your Soul, company Policies/);
    assert.match(result, /run the applicable validation commands/);
    assert.match(result, /never claim an unrun command passed/);
    assert.doesNotMatch(result, new RegExp(tmp));
  });

  for (const authMode of ["none", "https", "ssh"] as const) {
    test(`directs write-granted ${authMode} Repository changes into a deliverable Work session`, async () => {
      const { row, synced } = await grantedCheckout();
      await AppDataSource.getRepository(Repository).update(row.id, { authMode });
      const result = await context([synced]);
      assert.match(result, /start_repository_work_session before editing/);
      assert.match(result, /start_repository_work_session using repository "website"/);
      assert.match(result, /push_repository_work_session.*server-held SSH or HTTPS credentials/);
      if (authMode === "https") {
        assert.match(
          result,
          /open_repository_work_session_pull_request uses this Repository's stored HTTPS personal access token/,
        );
        assert.match(result, /without a separate forge Connection Grant/);
        assert.doesNotMatch(result, /pull_request requires.*exact granted forge Connection/);
      } else {
        assert.match(
          result,
          /open_repository_work_session_pull_request requires.*exact granted forge Connection/,
        );
        assert.doesNotMatch(result, /without a separate forge Connection Grant/);
      }
      assert.match(result, /get_repository_work_session confirms completed work/);
      assert.match(result, /claim a PR only when the tool returns its URL/);
      assert.match(result, /credentials stay server-side/);
      assert.doesNotMatch(result, /credentialed pushing is disabled|push if the remote accepts/);
    });
  }

  test("recovers existing local changes by supplying their contents to a validated Work session", async () => {
    const { synced } = await grantedCheckout();
    const result = await context([synced]);
    assert.match(result, /preserve its local branch and commit/);
    assert.match(result, /bounded diff or the relevant changed file contents/);
    assert.match(result, /new Work session instruction to reproduce and validate/);
    assert.match(result, /isolated session cannot read this checkout/);
    assert.match(result, /Do not claim those old local commits were pushed/);
  });

  test("does not promise publishing when a write Grant has been reduced to read-only", async () => {
    const { row, synced } = await grantedCheckout();
    await AppDataSource.getRepository(EmployeeRepositoryGrant).update(
      { repositoryId: row.id, employeeId: employee.id },
      { accessLevel: "read" },
    );
    const result = await context([synced]);
    assert.match(result, /Read-only Grant/);
    assert.match(result, /changing or publishing Repository work requires a write Grant/);
    assert.doesNotMatch(result, /push_repository_work_session pushes/);
  });

  for (const name of ["agents.md", "AGENT.md", "agent.md", "AgEnTs.Md", "CLAUDE.md", "claude.md"]) {
    test(`automatically includes the ${name} alias`, async () => {
      const { synced } = await grantedCheckout("aliases", name, `Instruction from ${name}`);
      const result = await context([synced]);
      assert.ok(result.includes(`Instruction from ${name}`));
      assert.ok(result.includes(`repositories/aliases/${name}`));
    });
  }

  test("keeps different repository instructions in their own sections", async () => {
    const first = await grantedCheckout("website", "AGENTS.md", "Website: run npm run lint.");
    const second = await grantedCheckout("api", "agent.md", "API: run npm run typecheck.");
    const result = await context([first.synced, second.synced]);
    assert.ok(
      result.indexOf("Website: run") <
        result.indexOf("End of contributor guide for `repositories/website/`"),
    );
    assert.ok(
      result.indexOf("API: run") > result.indexOf("Contributor guide for `repositories/api/`"),
    );
    assert.match(result, /deeper AGENTS.md, AGENT.md, or CLAUDE.md/);
  });

  test("includes a successfully materialized forge Connection checkout", async () => {
    const forgePath = path.join(cwd, "repos", "git.example", "acme", "web");
    fs.mkdirSync(forgePath, { recursive: true });
    fs.writeFileSync(path.join(forgePath, "agent.md"), "Forge instructions: run npm test.");
    const result = await context(
      [],
      [
        {
          connectionId: "connection",
          owner: "acme",
          name: "web",
          defaultBranch: "main",
          path: forgePath,
        },
      ],
    );
    assert.match(result, /Forge instructions: run npm test/);
    assert.match(result, /repos\/git.example\/acme\/web\/agent.md/);
    assert.match(result, /list_repositories to find a matching granted Repository/);
    assert.match(result, /start_repository_work_session for changes that need delivery/);
    assert.doesNotMatch(result, /credentialed pushing is disabled/);
    assert.doesNotMatch(result, new RegExp(tmp));
  });

  test("does not read stale files for a repository that failed materialization", async () => {
    await grantedCheckout("failed", "AGENTS.md", "Stale failed checkout guide");
    const result = await materializeEmployeeRepositoryContext(
      { employeeId: employee.id, cwd },
      {
        materializeReposForEmployee: async () => emptyForgeSync(),
        materializeRepositoriesForEmployee: async () => ({
          extraEnv: {},
          repos: [],
          errors: [{ scope: "failed", message: "Fetch failed" }],
        }),
      },
    );
    assert.equal(result.context, "");
    assert.equal(result.repositorySync.errors[0]?.message, "Fetch failed");
  });

  test("loads files after both materializers complete and keeps credentials out of the result", async () => {
    const { synced, checkout } = await grantedCheckout("refresh", "AGENTS.md", "Old guide");
    const order: string[] = [];
    const result = await materializeEmployeeRepositoryContext(
      { employeeId: employee.id, cwd },
      {
        materializeReposForEmployee: async () => {
          order.push("forge");
          return emptyForgeSync();
        },
        materializeRepositoriesForEmployee: async () => {
          assert.deepEqual(order, ["forge"]);
          order.push("repository");
          fs.writeFileSync(path.join(checkout, "AGENTS.md"), "Refreshed contributor instructions");
          return { extraEnv: { UNUSED_TOKEN: "must-not-escape" }, repos: [synced], errors: [] };
        },
      },
    );
    assert.match(result.context, /Refreshed contributor instructions/);
    assert.doesNotMatch(result.context, /Old guide/);
    assert.doesNotMatch(JSON.stringify(result), /must-not-escape|forgeRepoCredentials|extraEnv/);
  });

  test("keeps the usable checkouts when another synchronization fails", async () => {
    const { synced } = await grantedCheckout();
    const result = await materializeEmployeeRepositoryContext(
      { employeeId: employee.id, cwd },
      {
        materializeReposForEmployee: async () => ({
          ...emptyForgeSync(),
          errors: [{ scope: "forge", message: "Unavailable" }],
        }),
        materializeRepositoriesForEmployee: async () => ({
          extraEnv: {},
          repos: [synced],
          errors: [{ scope: "other", message: "Unavailable" }],
        }),
      },
    );
    assert.match(result.context, /Run npm run lint/);
    assert.equal(result.forgeSync.errors.length, 1);
    assert.equal(result.repositorySync.errors.length, 1);
  });

  test("a Repository with its own credential syncs alone, without touching Connections", async () => {
    const calls: string[] = [];
    let repositoryIds: readonly string[] | undefined;
    await materializeEmployeeRepositoryContext(
      {
        employeeId: employee.id,
        cwd,
        only: { kind: "repository", repositoryId: "repo-1", borrowsConnectionCredential: false },
      },
      {
        materializeReposForEmployee: async () => {
          calls.push("forge");
          return emptyForgeSync();
        },
        materializeRepositoriesForEmployee: async (args) => {
          calls.push("repository");
          repositoryIds = args.repositoryIds;
          return { extraEnv: {}, repos: [], errors: [] };
        },
      },
    );
    assert.deepEqual(calls, ["repository"]);
    assert.deepEqual(repositoryIds, ["repo-1"]);
  });

  test("a credential-free Repository borrows Connection credentials without syncing their checkouts", async () => {
    const credential: ForgeRepoCredential = {
      connectionId: "connection",
      endpoint: GITHUB_ENDPOINT,
      username: "x-access-token",
      owner: null,
      name: null,
      envKey: "GENOSYN_FORGE_TOKEN_CONNECTION",
      token: "token",
    };
    let include: ((repo: ForgeCheckoutRef) => boolean) | undefined;
    let handed: ForgeRepoCredential[] | undefined;
    await materializeEmployeeRepositoryContext(
      {
        employeeId: employee.id,
        cwd,
        only: { kind: "repository", repositoryId: "repo-1", borrowsConnectionCredential: true },
      },
      {
        materializeReposForEmployee: async (args) => {
          include = args.include;
          return { ...emptyForgeSync(), forgeRepoCredentials: [credential] };
        },
        materializeRepositoriesForEmployee: async (args) => {
          handed = args.forgeRepoCredentials;
          return { extraEnv: {}, repos: [], errors: [] };
        },
      },
    );
    assert.ok(include, "Connection checkouts must be filtered, not all synced");
    assert.equal(include({ connectionId: "connection", owner: "acme", name: "web" }), false);
    assert.deepEqual(handed, [credential]);
  });

  test("a Connection checkout syncs alone, without any Repository", async () => {
    let include: ((repo: ForgeCheckoutRef) => boolean) | undefined;
    let repositoriesSynced = false;
    await materializeEmployeeRepositoryContext(
      {
        employeeId: employee.id,
        cwd,
        only: { kind: "connection", connectionId: "c1", owner: "acme", name: "web" },
      },
      {
        materializeReposForEmployee: async (args) => {
          include = args.include;
          return emptyForgeSync();
        },
        materializeRepositoriesForEmployee: async () => {
          repositoriesSynced = true;
          return { extraEnv: {}, repos: [], errors: [] };
        },
      },
    );
    assert.equal(repositoriesSynced, false);
    assert.ok(include);
    assert.equal(include({ connectionId: "c1", owner: "acme", name: "web" }), true);
    assert.equal(include({ connectionId: "c1", owner: "acme", name: "api" }), false);
    assert.equal(include({ connectionId: "c2", owner: "acme", name: "web" }), false);
  });

  test("omits grants removed since synchronization", async () => {
    const { synced, row } = await grantedCheckout();
    await AppDataSource.getRepository(EmployeeRepositoryGrant).delete({ repositoryId: row.id });
    assert.equal(await context([synced]), "");
  });

  test("does not load a Repository belonging to another company", async () => {
    const { synced, row } = await grantedCheckout();
    await AppDataSource.getRepository(Repository).update(row.id, { companyId: "other-company" });
    assert.equal(await context([synced]), "");
  });

  test("omits all repository context on a multi-tenant installation", async () => {
    const { synced } = await grantedCheckout();
    securityConfig.multiTenant = true;
    assert.equal(await context([synced]), "");
  });

  test("does not promise checkouts for an employee that no longer exists", async () => {
    const { synced } = await grantedCheckout();
    await AppDataSource.getRepository(AIEmployee).delete(employee.id);
    assert.equal(await context([synced]), "");
  });

  test("a repository without a guide stays usable", async () => {
    const { synced } = await grantedCheckout("plain", "AGENTS.md", "");
    const result = await context([synced]);
    assert.match(result, /repositories\/plain\//);
    assert.doesNotMatch(result, /Contributor guide for/);
  });

  test("deduplicates repeated successful paths", async () => {
    const { synced } = await grantedCheckout();
    const result = await context([synced, synced]);
    assert.equal(result.split("Run npm run lint before committing.").length - 1, 1);
  });

  test("rejects checkout paths outside the employee workspace", async () => {
    const { synced } = await grantedCheckout();
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "AGENTS.md"), "Outside workspace");
    assert.equal(await context([{ ...synced, path: outside }]), "");
  });

  test("rejects a symlink in a checkout's parent path", async () => {
    const { synced, checkout } = await grantedCheckout();
    fs.renameSync(path.dirname(checkout), path.join(tmp, "redirected"));
    fs.symlinkSync(path.join(tmp, "redirected"), path.dirname(checkout), "dir");
    assert.equal(await context([synced]), "");
  });

  test("large guides use the available file reader and stay within the shared budget", async () => {
    const { synced } = await grantedCheckout(
      "large",
      "AGENTS.md",
      "Required validation instructions.\n".repeat(3_000),
    );
    codingConfig.executionMode = "host";
    const result = await context([synced]);
    assert.ok(result.length <= REPOSITORIES_CONTEXT_MAX_CHARS);
    assert.match(result, /truncat|excerpt|omitted/i);
    assert.ok(result.includes("the available file-reading tool"));
    assert.doesNotMatch(result, /read_file/);
    assert.match(result, /repositories\/large\/AGENTS.md/);
  });

  test("bounds the whole briefing even with many large guides", async () => {
    const checkouts: SyncedRepository[] = [];
    for (let n = 0; n < 100; n += 1) {
      const { synced } = await grantedCheckout(
        `repository-${n}`,
        "AGENTS.md",
        "Run lint.\n".repeat(3_000),
      );
      checkouts.push(synced);
    }
    const result = await context(checkouts);
    assert.ok(
      result.length <= REPOSITORIES_CONTEXT_MAX_CHARS,
      `${result.length} exceeds aggregate context budget`,
    );
    assert.match(result, /Additional refreshed repositories were omitted/);
  });
});

function git(directory: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

async function actualRemote(guide = "Run npm run verify-repository before committing.") {
  const source = path.join(tmp, "source");
  const remote = path.join(tmp, "remotes", "actual.git");
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  git(source, "init", "--initial-branch=main");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.test");
  fs.writeFileSync(path.join(source, "AGENTS.md"), guide);
  git(source, "add", "AGENTS.md");
  git(source, "commit", "-m", "Add contributor guide");
  git(tmp, "clone", "--bare", source, remote);
  git(remote, "update-server-info");
  const row = await insert(Repository, {
    companyId: company.id,
    name: "Actual Repository",
    slug: "actual",
    gitUrl: `${serverUrl}/actual.git`,
  });
  await insert(EmployeeRepositoryGrant, {
    employeeId: employee.id,
    repositoryId: row.id,
    accessLevel: "write",
  });
  await insertEmployeeModel({
    employeeId: employee.id,
    provider: "custom",
    model: "guide-test",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(`${serverUrl}/v1`),
      modelId: "guide-test",
    }),
  });
  return { source, remote, row };
}

function systemReceived(): string {
  assert.ok(modelRequests.length > 0, "the real model seam must be called");
  return modelRequests[0]!.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
}

describe("chat and Routine repository briefing integration", () => {
  test("an ordinary authorized chat names its checkouts without fetching them", async () => {
    await actualRemote();
    const result = await chatWithEmployee(
      company.id,
      employee.id,
      "Where is the reseller for Canada based?",
      [],
      { toolAuthority: "employee" },
    );
    assert.equal(result.status, "ok");
    const system = systemReceived();
    assert.match(system, /## Repositories/);
    assert.match(
      system,
      /"Actual Repository": slug `actual`, checkout `repositories\/actual\/`, default branch "main", write Grant/,
    );
    assert.match(system, /call `sync_repositories` with its slug/);
    assert.match(system, /start_repository_work_session/);
    // A guide is only ever read from a checkout a sync has just refreshed.
    assert.doesNotMatch(system, /Run npm run verify-repository before committing/);
    assert.equal(gitRequests, 0, "a turn that may never read code must not wait on git");
    assert.equal(fs.existsSync(path.join(cwd, "repositories", "actual")), false);
  });

  test("a stale checkout's guide stays out of the prompt", async () => {
    await actualRemote();
    const checkout = path.join(cwd, "repositories", "actual");
    fs.mkdirSync(checkout, { recursive: true });
    fs.writeFileSync(path.join(checkout, "AGENTS.md"), "Stale instruction from an old checkout");
    const result = await chatWithEmployee(company.id, employee.id, "Inspect the repository.", [], {
      toolAuthority: "employee",
    });
    assert.equal(result.status, "ok");
    assert.match(systemReceived(), /checkout `repositories\/actual\/`/);
    assert.doesNotMatch(systemReceived(), /Stale instruction from an old checkout/);
    assert.equal(gitRequests, 0);
  });

  test("a Routine names its checkouts without fetching them", async () => {
    await actualRemote("Routine contributor instruction: run npm run routine-check.");
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Inspect repository",
      slug: "inspect-repository",
      cronExpr: "0 3 * * *",
      body: "Inspect the repository instructions.",
      timeoutSec: 60,
    });
    const started = await startRoutineRun(routine, { triggerKind: "manual" });
    const run = await started.completion;
    assert.equal(run.status, "completed", run.logContent);
    assert.match(systemReceived(), /checkout `repositories\/actual\/`/);
    assert.match(systemReceived(), /call `sync_repositories` with its slug/);
    assert.doesNotMatch(systemReceived(), /Routine contributor instruction/);
    assert.doesNotMatch(run.logContent, /\[repositories\] synced|checkouts are unavailable/);
    assert.equal(gitRequests, 0);
  });

  test("an unauthenticated chat neither syncs nor receives repository instructions", async () => {
    await actualRemote("Private repository contributor instruction");
    const result = await chatWithEmployee(company.id, employee.id, "Inspect the repository.", [], {
      toolAuthority: "untrusted",
    });
    assert.equal(result.status, "ok");
    assert.doesNotMatch(
      systemReceived(),
      /Private repository contributor instruction|## Repositories|repositories\/actual/,
    );
    assert.equal(gitRequests, 0);
  });

  test("a draft-only chat neither syncs nor receives repository instructions", async () => {
    await actualRemote("Private repository contributor instruction");
    const result = await chatWithEmployee(company.id, employee.id, "Prepare a draft.", [], {
      toolAuthority: "employee",
      mailDeliveryMode: "draft",
    });
    assert.equal(result.status, "ok");
    assert.doesNotMatch(
      systemReceived(),
      /Private repository contributor instruction|## Repositories/,
    );
    assert.equal(gitRequests, 0);
  });

  test("disabled coding tools do not cause repository guide reads", async () => {
    await actualRemote("Private repository contributor instruction");
    codingConfig.executionMode = "disabled";
    const result = await chatWithEmployee(company.id, employee.id, "Inspect the repository.", [], {
      toolAuthority: "employee",
    });
    assert.equal(result.status, "ok");
    assert.doesNotMatch(
      systemReceived(),
      /Private repository contributor instruction|## Repositories/,
    );
    assert.equal(gitRequests, 0);
  });
});

/** Call the tool and read what the model would: its text, or its error. */
async function callSync(
  body: Record<string, unknown> = {},
  origin: Parameters<typeof issueMcpToken>[2] = { authority: "employee" },
): Promise<{ status: number; text: string }> {
  const token = issueMcpToken(employee.id, company.id, origin);
  try {
    const response = await fetch(`${mcpUrl}/tools/sync_repositories`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const answer = (await response.json()) as {
      error?: string;
      content?: Array<{ type: string; text: string }>;
    };
    return {
      status: response.status,
      text: answer.error ?? answer.content?.map((part) => part.text).join("\n") ?? "",
    };
  } finally {
    revokeMcpToken(token);
  }
}

describe("sync_repositories", () => {
  test("clones a checkout that was never cloned and returns its contributor guide", async () => {
    await actualRemote();
    const { status, text } = await callSync({ repository: "actual" });
    assert.equal(status, 200, text);
    assert.match(
      text,
      /^Synced 1 checkout:\n- Actual Repository \(actual\): `repositories\/actual\/`, default branch "main"\n/,
    );
    assert.doesNotMatch(text, /Could not sync/);
    // The guide reads as markdown, with real newlines, not an escaped string.
    assert.match(text, /\n## Repositories\n/);
    assert.match(text, /Run npm run verify-repository before committing/);
    assert.match(text, /start_repository_work_session before editing/);
    assert.match(text, /push_repository_work_session/);
    assert.doesNotMatch(text, new RegExp(tmp));
    assert.ok(fs.existsSync(path.join(cwd, "repositories", "actual", "AGENTS.md")));
    assert.ok(gitRequests > 0);
  });

  test("a later sync fast-forwards the default branch and returns the new guide", async () => {
    const { source, remote } = await actualRemote("Old contributor instruction");
    const first = await callSync();
    assert.equal(first.status, 200, first.text);
    assert.match(first.text, /Old contributor instruction/);
    fs.writeFileSync(
      path.join(source, "AGENTS.md"),
      "New contributor instruction: run npm run refreshed-check.",
    );
    git(source, "add", "AGENTS.md");
    git(source, "commit", "-m", "Update contributor guide");
    git(source, "push", remote, "main");
    git(remote, "update-server-info");
    const second = await callSync({ repository: "Actual Repository" });
    assert.equal(second.status, 200, second.text);
    assert.match(second.text, /New contributor instruction: run npm run refreshed-check/);
    assert.doesNotMatch(second.text, /Old contributor instruction/);
  });

  test("syncs only the repository it is asked for", async () => {
    await actualRemote();
    const other = await insert(Repository, {
      companyId: company.id,
      name: "Other",
      slug: "other",
      gitUrl: `${serverUrl}/missing.git`,
    });
    await insert(EmployeeRepositoryGrant, {
      employeeId: employee.id,
      repositoryId: other.id,
      accessLevel: "read",
    });
    const { status, text } = await callSync({ repository: "repositories/actual/" });
    assert.equal(status, 200, text);
    assert.match(text, /^Synced 1 checkout:\n- Actual Repository \(actual\)/);
    assert.doesNotMatch(text, /Other|Could not sync/);
    assert.equal(fs.existsSync(path.join(cwd, "repositories", "other")), false);
    const untouched = await AppDataSource.getRepository(Repository).findOneByOrFail({
      id: other.id,
    });
    assert.equal(untouched.lastSyncStatus, "unknown");
  });

  test("with no repository it syncs every checkout and reports each failure", async () => {
    await actualRemote();
    const broken = await insert(Repository, {
      companyId: company.id,
      name: "Broken",
      slug: "broken",
      gitUrl: `${serverUrl}/missing.git`,
    });
    await insert(EmployeeRepositoryGrant, {
      employeeId: employee.id,
      repositoryId: broken.id,
      accessLevel: "read",
    });
    const { status, text } = await callSync();
    assert.equal(status, 200, text);
    assert.match(
      text,
      /^Synced 1 checkout:\n- Actual Repository \(actual\): `repositories\/actual\/`/,
    );
    assert.match(
      text,
      /\nCould not sync these, so do not rely on their files — they may be missing or out of date:\n- Broken \(broken\): \S/,
    );
    // Only the checkout that synced is briefed.
    assert.match(text, /Run npm run verify-repository before committing/);
  });

  test("a sync where nothing succeeds is an error that names each failure", async () => {
    const missing = await insert(Repository, {
      companyId: company.id,
      name: "Missing",
      slug: "missing",
      gitUrl: `${serverUrl}/missing.git`,
    });
    await insert(EmployeeRepositoryGrant, {
      employeeId: employee.id,
      repositoryId: missing.id,
      accessLevel: "write",
    });
    const { status, text } = await callSync({ repository: "missing" });
    assert.equal(status, 502, text);
    assert.match(text, /Nothing could be synced/);
    assert.match(text, /- Missing \(missing\): \S/);
    assert.doesNotMatch(text, new RegExp(cwd));
  });

  test("an unknown repository lists the checkouts the employee has", async () => {
    await actualRemote();
    const { status, text } = await callSync({ repository: "website" });
    assert.equal(status, 400);
    assert.match(text, /"website" is not one of your repository checkouts/);
    assert.match(text, /Actual Repository \(actual\)/);
    assert.equal(gitRequests, 0);
  });

  test("an employee with nothing granted is told how access is granted", async () => {
    const { status, text } = await callSync();
    assert.equal(status, 400);
    assert.match(text, /no repository checkouts to sync/);
  });

  test("email work cannot sync", async () => {
    await actualRemote();
    const { status, text } = await callSync(
      {},
      { authority: "employee", mailDeliveryMode: "review" },
    );
    assert.equal(status, 403);
    assert.match(text, /Email work does not use repository checkouts/);
    assert.equal(gitRequests, 0);
  });

  test("disabled coding tools refuse a sync", async () => {
    await actualRemote();
    codingConfig.executionMode = "disabled";
    const { status, text } = await callSync();
    assert.equal(status, 403);
    assert.match(text, /coding tools are disabled/);
    assert.equal(gitRequests, 0);
  });

  test("a multi-tenant installation refuses a sync", async () => {
    await actualRemote();
    securityConfig.multiTenant = true;
    const { status, text } = await callSync();
    assert.equal(status, 403);
    assert.match(text, /multi-tenant/);
    assert.equal(gitRequests, 0);
  });

  test("an unauthenticated chat cannot sync", async () => {
    await actualRemote();
    const { status } = await callSync({}, { authority: "untrusted" });
    assert.equal(status, 403);
    assert.equal(gitRequests, 0);
  });

  test("a local Repository is neither briefed nor synced", async () => {
    const local = await insert(Repository, {
      companyId: company.id,
      name: "Policies",
      slug: "policies",
      gitUrl: "",
      origin: "local",
    });
    await insert(EmployeeRepositoryGrant, {
      employeeId: employee.id,
      repositoryId: local.id,
      accessLevel: "write",
    });
    assert.deepEqual(await listEmployeeRepositoryCheckouts(employee.id), []);
    const { status } = await callSync();
    assert.equal(status, 400);
    const row = await AppDataSource.getRepository(Repository).findOneByOrFail({ id: local.id });
    assert.equal(row.lastSyncStatus, "unknown");
  });
});

describe("repository checkout briefing", () => {
  function repositoryCheckout(
    overrides: Partial<Extract<EmployeeRepositoryCheckout, { kind: "repository" }>> = {},
  ): EmployeeRepositoryCheckout {
    return {
      kind: "repository",
      repositoryId: "website-id",
      name: "Website",
      slug: "website",
      defaultBranch: "main",
      accessLevel: "write",
      credentialFree: true,
      path: "repositories/website",
      ...overrides,
    };
  }
  const connectionCheckout: EmployeeRepositoryCheckout = {
    kind: "connection",
    connectionId: "connection-id",
    owner: "acme",
    name: "web",
    defaultBranch: "trunk",
    path: "repos/acme/web",
  };

  test("names each checkout, its Grant, and how to sync it", () => {
    const text = formatRepositoryCheckoutsBriefing([
      repositoryCheckout(),
      repositoryCheckout({
        repositoryId: "docs-id",
        name: "Docs",
        slug: "docs",
        path: "repositories/docs",
        accessLevel: "read",
      }),
      connectionCheckout,
    ]);
    assert.match(text, /^\n## Repositories\n/);
    assert.match(text, /does not fetch them before each turn/);
    assert.match(text, /call `sync_repositories` with its slug/);
    assert.match(text, /Skip it for work that does not involve them/);
    assert.match(
      text,
      /- "Website": slug `website`, checkout `repositories\/website\/`, default branch "main", write Grant\./,
    );
    assert.match(text, /- "Docs": slug `docs`, .*read-only Grant\./);
    assert.match(
      text,
      /- "acme\/web": Connection checkout `repos\/acme\/web\/`, default branch "trunk"\./,
    );
  });

  test("is empty when there is nothing to check out", () => {
    assert.equal(formatRepositoryCheckoutsBriefing([]), "");
  });

  test("a sync that found nothing to do says why rather than reading as a success", () => {
    assert.equal(
      formatRepositoryCheckoutSyncReport({ synced: [], failed: [], instructions: "" }),
      "Nothing was synced: that checkout is no longer among your Grants.",
    );
    assert.equal(
      formatRepositoryCheckoutSyncReport({
        synced: [{ repository: "acme/web", checkout: "repos/acme/web", defaultBranch: "trunk" }],
        failed: [],
        instructions: "",
      }),
      'Synced 1 checkout:\n- acme/web: `repos/acme/web/`, default branch "trunk"',
    );
  });

  test("stays bounded however many Repositories are granted", () => {
    const many = Array.from({ length: BRIEFED_CHECKOUTS_MAX + 5 }, (_, n) =>
      repositoryCheckout({
        repositoryId: `id-${n}`,
        name: `Repository ${n}`,
        slug: `repository-${n}`,
        path: `repositories/repository-${n}`,
      }),
    );
    const text = formatRepositoryCheckoutsBriefing(many);
    assert.equal(text.split('\n- "').length - 1, BRIEFED_CHECKOUTS_MAX);
    assert.match(text, /…and 5 more\. `list_repositories` lists every granted Repository/);
  });

  test("finds a checkout by slug, name, owner/name or path", () => {
    const website = repositoryCheckout();
    const all = [website, connectionCheckout];
    for (const asked of ["website", "WEBSITE", "Website", " website ", "repositories/website/"]) {
      assert.deepEqual(resolveEmployeeRepositoryCheckout(all, asked), { checkout: website }, asked);
    }
    for (const asked of ["acme/web", "ACME/Web", "repos/acme/web"]) {
      assert.deepEqual(
        resolveEmployeeRepositoryCheckout(all, asked),
        { checkout: connectionCheckout },
        asked,
      );
    }
  });

  test("asks which one when two Repositories share a name", () => {
    const result = resolveEmployeeRepositoryCheckout(
      [
        repositoryCheckout(),
        repositoryCheckout({
          repositoryId: "other",
          slug: "website-2",
          path: "repositories/website-2",
        }),
      ],
      "website ",
    );
    // The slug matches exactly, so there is nothing to ask.
    assert.deepEqual(result, { checkout: repositoryCheckout() });
    const ambiguous = resolveEmployeeRepositoryCheckout(
      [
        repositoryCheckout({ slug: "site-a", path: "repositories/site-a" }),
        repositoryCheckout({ repositoryId: "b", slug: "site-b", path: "repositories/site-b" }),
      ],
      "website",
    );
    assert.ok("error" in ambiguous);
    assert.match(ambiguous.error, /More than one of your repositories is called "website"/);
    assert.match(ambiguous.error, /site-a, site-b/);
  });

  test("lists Connection checkouts from granted Connections, skipping unreadable ones", async () => {
    const connection = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "github",
      label: "GitHub",
      authMode: "apikey",
      encryptedConfig: encryptConnectionConfig(
        {
          apiKey: "ghp_token",
          login: "acme",
          repos: [{ owner: "acme", name: "web", defaultBranch: "trunk" }],
        } as IntegrationConfig,
        company.id,
      ),
      accountHint: "GitHub",
      status: "connected",
      statusMessage: "",
      lastCheckedAt: null,
    });
    const unreadable = await insert(IntegrationConnection, {
      companyId: company.id,
      provider: "forgejo",
      label: "Broken forge",
      authMode: "apikey",
      encryptedConfig: "not-ciphertext-this-install-can-read",
      accountHint: "Broken forge",
      status: "connected",
      statusMessage: "",
      lastCheckedAt: null,
    });
    for (const granted of [connection, unreadable]) {
      await insert(EmployeeConnectionGrant, { employeeId: employee.id, connectionId: granted.id });
    }
    const checkouts = await listEmployeeRepositoryCheckouts(employee.id);
    assert.deepEqual(checkouts, [
      {
        kind: "connection",
        connectionId: connection.id,
        owner: "acme",
        name: "web",
        defaultBranch: "trunk",
        path: "repos/acme/web",
      },
    ]);
    assert.equal(gitRequests, 0);
  });
});
