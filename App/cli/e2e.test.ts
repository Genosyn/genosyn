import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { createApp } from "../server/app.js";
import { buildOpenApiDocument } from "../server/openapi/spec.js";
import { createMemberOfNewCompany, mintTestApiKey } from "../server/test/apiAccess.js";
import { run, stderrJson, tempDir, type MemoryIoOptions, type RunResult } from "./test/support.js";
import { recordingFetch, startTestServer, type TestServer } from "./test/server.js";

/**
 * `genosyn-api` against the real App: `createApp()` on an in-memory database,
 * real API keys, real handlers. Logs in, explores, and drives a create, read,
 * update and delete round trip, a paged list, a Routine Run, an upload and a
 * download — then checks each refusal lands on its documented exit code.
 */

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

type Account = { token: string; companyId: string; baseUrl: string; env: Record<string, string> };

async function account(t: { after: (fn: () => void) => void }, role: "owner" | "admin" | "member" = "owner"): Promise<Account> {
  const { user, company } = await createMemberOfNewCompany(role);
  const { token } = await mintTestApiKey(user.id, company.id);
  const dir = tempDir(t);
  return {
    token,
    companyId: company.id,
    baseUrl: `${server.baseUrl}/api/companies/${company.id}`,
    env: {
      GENOSYN_CONFIG: path.join(dir, "genosyn-api.json"),
      GENOSYN_CACHE_DIR: path.join(dir, "cache"),
      NO_COLOR: "1",
    },
  };
}

/** Run against the live server with the key in the environment, the way an agent would. */
function cli(who: Account, argv: string[], options: MemoryIoOptions = {}): Promise<RunResult> {
  return run(argv, {
    fetch: globalThis.fetch,
    ...options,
    env: { ...who.env, GENOSYN_URL: who.baseUrl, GENOSYN_API_KEY: who.token, ...(options.env ?? {}) },
  });
}

function ok(result: RunResult): RunResult {
  assert.equal(result.code, 0, `exit ${result.code}: ${result.stderr}`);
  return result;
}

function parsed<T = any>(result: RunResult): T {
  return JSON.parse(ok(result).stdout) as T;
}

function noKey(result: RunResult, token: string) {
  assert.ok(!result.stdout.includes(token), "key on stdout");
  assert.ok(!result.stderr.includes(token), "key on stderr");
}

describe("logging in to a real install", () => {
  test("login checks the key against /me, saves a 0600 profile, and whoami reads it back", async (t) => {
    const who = await account(t);
    const login = await run(["login", "--url", who.baseUrl, "--with-token"], {
      env: who.env,
      fetch: globalThis.fetch,
      stdin: `${who.token}\n`,
    });
    const saved = parsed(login);
    assert.equal(saved.company.id, who.companyId);
    assert.equal(saved.company.name, "Acme");
    assert.equal(saved.role, "owner");
    assert.equal(saved.verified, true);
    assert.equal(saved.apiKey.prefix, who.token.slice(0, 12));
    noKey(login, who.token);
    const file = who.env.GENOSYN_CONFIG;
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).profiles[saved.profile].apiKey, who.token);

    const me = await run(["whoami"], { env: who.env, fetch: globalThis.fetch });
    const body = parsed(me);
    assert.equal(body.authentication, "api_key");
    assert.equal(body.company.id, who.companyId);
    assert.equal(body.profile, saved.profile);
    noKey(me, who.token);
  });

  test("a revoked or made-up key is refused with exit code 3, and nothing is saved", async (t) => {
    const who = await account(t);
    const login = await run(["login", "--url", who.baseUrl, "--with-token"], {
      env: who.env,
      fetch: globalThis.fetch,
      stdin: "gen_madeUpKeyThatTheServerHasNeverSeen0000000",
    });
    assert.equal(login.code, 3);
    assert.equal(stderrJson(login).error.status, 401);
    assert.ok(!fs.existsSync(who.env.GENOSYN_CONFIG));
    const whoami = await cli(who, ["whoami"], { env: { GENOSYN_API_KEY: "gen_madeUpKeyThatTheServerHasNeverSeen0000000" } });
    assert.equal(whoami.code, 3);
  });

  test("a key used for another company's path is refused", async (t) => {
    const who = await account(t);
    const other = await account(t);
    const result = await cli(who, ["whoami"], { env: { GENOSYN_COMPANY: other.companyId } });
    assert.equal(result.code, 3);
  });
});

describe("discovering the API", () => {
  test("areas count exactly the operations the reference opens to keys", async (t) => {
    const who = await account(t);
    const areas = parsed<Array<{ area: string; operations: number }>>(await cli(who, ["areas"]));
    const document = buildOpenApiDocument(createApp()) as unknown as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };
    let keyOperations = 0;
    for (const item of Object.values(document.paths)) {
      for (const operation of Object.values(item)) {
        if ((operation["x-genosyn-access"] as { apiKey?: boolean } | undefined)?.apiKey) keyOperations += 1;
      }
    }
    assert.equal(
      areas.reduce((sum, area) => sum + area.operations, 0),
      keyOperations,
    );
    for (const slug of ["goals", "revenue", "routines", "resources", "employees"]) {
      assert.ok(areas.some((area) => area.area === slug), slug);
    }
  });

  test("the description is cached after the first run", async (t) => {
    const who = await account(t);
    const first = recordingFetch();
    ok(await cli(who, ["ops", "goals"], { fetch: first.fetch }));
    assert.ok(first.seen.includes("GET /api/openapi.json"));
    const second = recordingFetch();
    ok(await cli(who, ["describe", "createGoal"], { fetch: second.fetch, stdoutTTY: true }));
    assert.deepEqual(second.seen, [], "describe answered from the cache");
  });

  test("describe --json documents the parameters the server validates", async (t) => {
    const who = await account(t);
    const described = parsed(await cli(who, ["describe", "createGoal", "--json"]));
    const names = described.parameters.map((param: { name: string }) => param.name);
    assert.ok(names.includes("title") && names.includes("targetValue"));
    assert.equal(described.parameters.find((param: { name: string }) => param.name === "title").required, true);
    assert.equal(described.command, "genosyn-api goals create");
  });
});

describe("a create, read, update and delete round trip", () => {
  test("Goals: create with flags, read, update with name=value, list, delete, then 404", async (t) => {
    const who = await account(t);
    const id = ok(
      await cli(who, ["goals", "create", "--title", "Ship the CLI", "--target-value", "100", "--select", "id"]),
    ).stdout.trim();
    assert.match(id, /^[0-9a-f-]{36}$/);

    const read = parsed(await cli(who, ["goals", "get", id]));
    assert.equal(read.title, "Ship the CLI");
    assert.equal(read.targetValue, 100);

    const updated = parsed(await cli(who, ["call", "updateGoal", id, "title=Ship the CLI, v2", "targetValue:=150"]));
    assert.equal(updated.title, "Ship the CLI, v2");
    assert.equal(updated.targetValue, 150);

    const titles = parsed<string[]>(await cli(who, ["goals", "list", "--select", "*.title"]));
    assert.deepEqual(titles, ["Ship the CLI, v2"]);
    const table = ok(await cli(who, ["goals", "list"], { stdoutTTY: true })).stdout;
    assert.match(table, /Ship the CLI, v2/);

    ok(await cli(who, ["goals", "delete", id]));
    const gone = await cli(who, ["goals", "get", id]);
    assert.equal(gone.code, 5);
    const { error } = stderrJson(gone);
    assert.equal(error.kind, "not_found");
    assert.equal(error.status, 404);
    assert.equal(error.operationId, "getGoal");
  });

  test("a body the server refuses exits 6 and names the flag to fix", async (t) => {
    const who = await account(t);
    const result = await cli(who, ["goals", "create", "--title", "No target"]);
    assert.equal(result.code, 6);
    const { error } = stderrJson(result);
    assert.equal(error.kind, "validation");
    const issues = error.issues as Array<{ path: string; flag?: string }>;
    assert.ok(issues.some((issue) => issue.path === "targetValue" && issue.flag === "--target-value"), JSON.stringify(issues));
  });

  test("--dry-run sends nothing", async (t) => {
    const who = await account(t);
    const recorder = recordingFetch();
    const result = await cli(who, ["goals", "create", "--title", "Never", "--target-value", "1", "--dry-run"], {
      fetch: recorder.fetch,
    });
    assert.equal(JSON.parse(ok(result).stdout).method, "POST");
    assert.ok(!recorder.seen.some((line) => line.startsWith("POST")));
    assert.deepEqual(parsed(await cli(who, ["goals", "list"])), []);
  });
});

describe("lists, Routines and files", () => {
  test("--all walks every page of the Deals list", async (t) => {
    const who = await account(t);
    for (const title of ["Alpha", "Bravo", "Charlie"]) {
      ok(await cli(who, ["revenue", "create-deal", "--title", title, "--amount-cents", "1200"]));
    }
    const onePage = parsed(await cli(who, ["revenue", "list-deals", "--limit", "1"]));
    assert.equal(onePage.rows.length, 1);
    assert.equal(onePage.total, 3);
    const recorder = recordingFetch();
    const all = parsed(await cli(who, ["revenue", "list-deals", "--limit", "1", "--all"], { fetch: recorder.fetch }));
    assert.equal(all.total, 3);
    assert.deepEqual(
      all.rows.map((deal: { title: string }) => deal.title).sort(),
      ["Alpha", "Bravo", "Charlie"],
    );
    assert.equal(recorder.seen.filter((line) => line.endsWith("/revenue/deals")).length, 3);
  });

  test("hire an AI Employee, create a Routine from a file, run it, and see the Run", async (t) => {
    const who = await account(t);
    // A company sets its Goal before it hires.
    ok(await cli(who, ["goals", "create", "--title", "Answer every customer within a day", "--target-value", "1"]));
    const employeeId = ok(
      await cli(who, ["employees", "create", "--name", "Jamie", "--role", "Operations", "--select", "id"]),
    ).stdout.trim();
    const dir = tempDir(t);
    const file = path.join(dir, "routine.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ name: "Morning digest", cronExpr: "0 9 * * 1-5", brief: "Summarize yesterday's work." }),
    );
    const routine = parsed(
      await cli(who, ["routines", "create-employee-routine", employeeId, "--data", `@${file}`]),
    );
    assert.equal(routine.name, "Morning digest");
    assert.equal(routine.cronExpr, "0 9 * * 1-5");

    const runResult = parsed(await cli(who, ["routines", "run", routine.id]));
    assert.equal(runResult.status, "queued");
    const runs = parsed<Array<{ id: string }>>(await cli(who, ["routines", "list-runs", routine.id]));
    assert.ok(runs.some((entry) => entry.id === runResult.id));
  });

  test("upload a file as a Resource and download it again", async (t) => {
    const who = await account(t);
    const dir = tempDir(t);
    const content = "# Handbook\n\nWe answer every customer within a day.\n";
    fs.writeFileSync(path.join(dir, "support-handbook.md"), content);
    const uploaded = parsed(await cli(who, ["resources", "upload", "--file", "support-handbook.md"], { cwd: dir }));
    assert.equal(uploaded.sourceFilename, "support-handbook.md");
    const saved = parsed(
      await cli(who, ["resources", "get-file", uploaded.slug, "--output", "copy.md"], { cwd: dir }),
    );
    assert.equal(saved.bytes, Buffer.byteLength(content));
    assert.equal(fs.readFileSync(path.join(dir, "copy.md"), "utf8"), content);
  });
});

describe("what a key may not do", () => {
  test("a browser-only operation is refused locally with exit code 4", async (t) => {
    const who = await account(t);
    const recorder = recordingFetch();
    const result = await cli(who, ["call", "createApiKey"], { fetch: recorder.fetch });
    assert.equal(result.code, 4);
    assert.ok(!recorder.seen.some((line) => line.includes("/api-keys")));
  });

  test("a Member's key can't do what only an admin can: the server's 403 is exit code 4", async (t) => {
    const member = await account(t, "member");
    const result = await cli(member, ["employees", "create", "--name", "Robin", "--role", "Sales"]);
    assert.equal(result.code, 4);
    assert.equal(stderrJson(result).error.status, 403);
  });

  test("the key never appears in any output, even verbose", async (t) => {
    const who = await account(t);
    const result = await cli(who, ["goals", "list", "--verbose"]);
    ok(result);
    assert.match(result.stderr, /authorization: Bearer gen_/);
    noKey(result, who.token);
  });
});
