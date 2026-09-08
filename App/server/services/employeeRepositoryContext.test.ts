import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { EmployeeRepositoryGrant } from "../db/entities/EmployeeRepositoryGrant.js";
import { Repository } from "../db/entities/Repository.js";
import { Routine } from "../db/entities/Routine.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { chatWithEmployee } from "./chat.js";
import { employeeDir } from "./paths.js";
import {
  composeRepositoriesContext,
  materializeEmployeeRepositoryContext,
  REPOSITORIES_CONTEXT_MAX_CHARS,
  type SyncedRepository,
} from "./repositories.js";
import type { RepoSyncResult, SyncedRepo } from "./repoSync.js";
import { startRoutineRun } from "./runner.js";
import { resetRuntimeSettingsCacheForTests } from "./runtimeSettings.js";
import { stopStanddowns } from "./standdowns.js";

let tmp: string;
let cwd: string;
let company: Company;
let employee: AIEmployee;
let server: Server;
let serverUrl: string;
let modelRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let gitRequests = 0;
// Test fixtures temporarily change these boot settings and restore them below.
const dataConfig = config as { dataDir: string };
const securityConfig = config.security as { multiTenant: boolean };
const codingConfig = config.agent.codingTools as {
  executionMode: "host" | "bubblewrap" | "disabled";
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
});

beforeEach(async () => {
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
  dataConfig.dataDir = originalConfig.dataDir;
  securityConfig.multiTenant = originalConfig.multiTenant;
  Object.assign(config.agent.codingTools, originalConfig.codingTools);
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...originalConfig.allowlist);
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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

  for (const mode of ["host", "bubblewrap"] as const) {
    test(`large guides use ${mode === "host" ? "read_file" : "bash"} and stay within the shared budget`, async () => {
      const { synced } = await grantedCheckout(
        "large",
        "AGENTS.md",
        "Required validation instructions.\n".repeat(3_000),
      );
      codingConfig.executionMode = mode;
      const result = await context([synced]);
      assert.ok(result.length <= REPOSITORIES_CONTEXT_MAX_CHARS);
      assert.match(result, /truncat|excerpt|omitted/i);
      assert.ok(result.includes(mode === "host" ? "read_file" : "bash"));
      assert.match(result, /repositories\/large\/AGENTS.md/);
    });
  }

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
  await insert(AIModel, {
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
  test("an ordinary authorized chat includes the guide after the first real clone", async () => {
    await actualRemote();
    assert.equal(fs.existsSync(path.join(cwd, "repositories", "actual")), false);
    const result = await chatWithEmployee(
      company.id,
      employee.id,
      "Inspect the repository contributor instructions.",
      [],
      { toolAuthority: "employee" },
    );
    assert.equal(result.status, "ok");
    assert.match(systemReceived(), /Run npm run verify-repository before committing/);
    assert.ok(gitRequests > 0);
  });

  test("the next chat sees the guide from the newly fast-forwarded default branch", async () => {
    const { source, remote } = await actualRemote("Old contributor instruction");
    assert.equal(
      (
        await chatWithEmployee(company.id, employee.id, "Inspect the repository.", [], {
          toolAuthority: "employee",
        })
      ).status,
      "ok",
    );
    assert.match(systemReceived(), /Old contributor instruction/);
    fs.writeFileSync(
      path.join(source, "AGENTS.md"),
      "New contributor instruction: run npm run refreshed-check.",
    );
    git(source, "add", "AGENTS.md");
    git(source, "commit", "-m", "Update contributor guide");
    git(source, "push", remote, "main");
    git(remote, "update-server-info");
    modelRequests = [];
    assert.equal(
      (
        await chatWithEmployee(company.id, employee.id, "Inspect it again.", [], {
          toolAuthority: "employee",
        })
      ).status,
      "ok",
    );
    assert.match(systemReceived(), /New contributor instruction: run npm run refreshed-check/);
    assert.doesNotMatch(systemReceived(), /Old contributor instruction/);
  });

  test("a Routine includes its freshly materialized contributor guide", async () => {
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
    assert.match(systemReceived(), /Routine contributor instruction: run npm run routine-check/);
    assert.match(run.logContent, /\[repositories\] synced actual@main/);
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
