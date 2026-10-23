import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  API_KEY,
  BASE,
  COMPANY_ID,
  envFor,
  fakeInstall,
  json,
  run,
  stderrJson,
  syntheticSpec,
  tempDir,
  type FakeRoute,
  type RunResult,
} from "./test/support.js";

/**
 * The whole CLI, in-process, against a scripted install: every command's
 * output in each mode, every exit code, and the key handling end to end.
 * `e2e.test.ts` repeats the important paths against the real App.
 */

const BASE_URL = `${BASE}/api/companies/${COMPANY_ID}`;
const goalsPath = `/api/companies/${COMPANY_ID}/goals`;

function keyed(dir: string, extra: Record<string, string | undefined> = {}) {
  return envFor(dir, { GENOSYN_URL: BASE_URL, GENOSYN_API_KEY: API_KEY, ...extra });
}

function assertNoKey(result: RunResult) {
  assert.ok(!result.stdout.includes(API_KEY), "the key must never reach stdout");
  assert.ok(!result.stderr.includes(API_KEY), "the key must never reach stderr");
}

describe("help and version", () => {
  test("no arguments prints the global help", async () => {
    const result = await run([]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /genosyn-api — use Genosyn's API/);
    assert.match(result.stdout, /call <operation> \[args\]/);
  });

  test("--version prints the CLI's version, as JSON into a pipe", async (t) => {
    const dir = tempDir(t);
    const result = await run(["--version"], { env: envFor(dir) });
    assert.equal(result.code, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.cli, "development");
    assert.equal(parsed.server, null);
  });

  test("version asks the configured server for its version", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({}, { version: "7.1.0" });
    const result = await run(["version"], { env: keyed(dir), fetch: install.fetch, stdoutTTY: true });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^genosyn-api {2}development \(Node\.js /);
    assert.match(result.stdout, /server {7}7\.1\.0 at https:\/\/genosyn\.example\.test/);
  });

  test("version still answers when the server is down", async (t) => {
    const dir = tempDir(t);
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const result = await run(["version"], { env: keyed(dir), fetch });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout).server, { url: BASE, version: null, reachable: false });
  });

  test("--version goes alone", async () => {
    const result = await run(["--version", "login"]);
    assert.equal(result.code, 2);
  });

  test("help reaches commands, topics, areas and operations", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const env = keyed(dir);
    const cases: Array<[string[], RegExp]> = [
      [["help", "login"], /genosyn-api login — Check an API key/],
      [["login", "--help"], /--with-token/],
      [["help", "exit-codes"], /Exit codes/],
      [["help", "agents"], /Using genosyn-api from an AI agent/],
      [["help", "environment"], /GENOSYN_SPEC_TTL/],
      [["help", "call"], /Call any operation by its operationId/],
      [["call", "--help"], /Call any operation by its operationId/],
      [["help", "revenue"], /list-deals\s+GET \/revenue\/deals/],
      [["revenue"], /list-deals\s+GET \/revenue\/deals/],
      [["--help", "revenue"], /genosyn-api revenue — Contacts and deals/],
      [["help", "createGoal"], /genosyn-api goals create — Create goal/],
      [["help", "goals", "create"], /genosyn-api call createGoal --title/],
      [["help", "call", "createGoal"], /Body \(application\/json, required\)/],
      [["call", "createGoal", "--help"], /--target-value <number>/],
      [["goals", "create", "--help"], /--target-value <number>/],
      [["describe", "createGoal"], /operationId createGoal/],
    ];
    for (const [argv, pattern] of cases) {
      const result = await run(argv, { env, fetch: install.fetch, stdoutTTY: true });
      assert.equal(result.code, 0, `${argv.join(" ")}: ${result.stderr}`);
      assert.match(result.stdout, pattern, argv.join(" "));
    }
  });

  test("the global help lists the areas it has cached, without a request", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    await run(["areas"], { env: keyed(dir), fetch: install.fetch });
    const before = install.requests.length;
    const result = await run(["--help"], { env: keyed(dir), fetch: install.fetch, stdoutTTY: true });
    assert.match(result.stdout, /Areas on https:\/\/genosyn\.example\.test\n {2}goals, revenue, resources/);
    assert.equal(install.requests.length, before);
  });
});

describe("mistakes are usage errors (exit 2), explained", () => {
  test("an unknown command suggests the close ones", async (t) => {
    const dir = tempDir(t);
    const result = await run(["logn"], { env: keyed(dir), fetch: fakeInstall().fetch });
    assert.equal(result.code, 2);
    const { error } = stderrJson(result);
    assert.equal(error.kind, "usage");
    assert.equal(error.exitCode, 2);
    assert.match(error.message as string, /Unknown command "logn"/);
    assert.match(error.hint as string, /login/);
  });

  test("an unknown option before the command says where parameters go", async () => {
    const result = await run(["--title", "x", "call", "createGoal"]);
    assert.equal(result.code, 2);
    assert.match(stderrJson(result).error.hint as string, /after the operation/);
  });

  test("an option a command doesn't take", async () => {
    const result = await run(["whoami", "--jsno"]);
    assert.equal(result.code, 2);
    assert.match(stderrJson(result).error.hint as string, /--json/);
  });

  test("call without an operation, or with one the server doesn't have", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    assert.equal((await run(["call"], { env: keyed(dir), fetch: install.fetch })).code, 2);
    const missing = await run(["call", "createGoals"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(missing.code, 2);
    assert.match(stderrJson(missing).error.hint as string, /createGoal/);
  });

  test("an unknown parameter suggests the right flag and sends nothing", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const result = await run(["goals", "create", "--titel", "x"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(result.code, 2);
    assert.match(stderrJson(result).error.hint as string, /--title/);
    assert.ok(!install.requests.some((request) => request.method === "POST"));
  });

  test("operation parameters before the operation are refused with a pointer", async (t) => {
    const dir = tempDir(t);
    const result = await run(["goals", "--title", "x", "create"], { env: keyed(dir), fetch: fakeInstall().fetch });
    assert.equal(result.code, 2);
    assert.match(stderrJson(result).error.hint as string, /genosyn-api goals <operation> --name value/);
  });

  test("bad numbers for --timeout and --max-pages, caught before anything is sent", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({
      [`GET /api/companies/${COMPANY_ID}/revenue/deals`]: () => json({ rows: [{ id: 1 }], total: 3 }),
    });
    assert.equal((await run(["goals", "list", "--timeout", "soon"], { env: keyed(dir), fetch: install.fetch })).code, 2);
    const pages = await run(["revenue", "list-deals", "--all", "--max-pages", "0"], {
      env: keyed(dir),
      fetch: install.fetch,
    });
    assert.equal(pages.code, 2);
    assert.ok(!install.requests.some((request) => request.url.pathname.endsWith("/revenue/deals")));
  });

  test("a parameter named like a CLI option is refused as a flag in any spelling", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const result = await run(["call", "setRevenueSettings", "mode=advanced", "--dryRun"], {
      env: keyed(dir),
      fetch: install.fetch,
    });
    assert.equal(result.code, 2);
    assert.match(stderrJson(result).error.message as string, /dryRun=<value>/);
    assert.ok(!install.requests.some((request) => request.method === "PUT"));
  });
});

describe("output modes", () => {
  const goals = [
    { id: "g1", title: "Grow MRR", status: "active", owner: { name: "Ada" } },
    { id: "g2", title: "Hire", status: "draft", owner: null },
  ];
  const routes: Record<string, FakeRoute> = { [`GET ${goalsPath}`]: () => json(goals) };

  test("JSON, compact, when stdout is a pipe", async (t) => {
    const dir = tempDir(t);
    const result = await run(["goals", "list"], { env: keyed(dir), fetch: fakeInstall(routes).fetch });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${JSON.stringify(goals)}\n`);
  });

  test("a table at a terminal, and indented JSON with --json there", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall(routes);
    const table = await run(["goals", "list"], { env: keyed(dir), fetch: install.fetch, stdoutTTY: true });
    assert.match(table.stdout, /^ID\s+TITLE\s+STATUS\ng1\s+Grow MRR\s+active\ng2\s+Hire\s+draft\n$/);
    const pretty = await run(["goals", "list", "--json"], { env: keyed(dir), fetch: install.fetch, stdoutTTY: true });
    assert.equal(pretty.stdout, `${JSON.stringify(goals, null, 2)}\n`);
  });

  test("--table prints a table into a pipe, with chosen columns", async (t) => {
    const dir = tempDir(t);
    const result = await run(["goals", "list", "--table", "--columns", "title,id"], {
      env: keyed(dir),
      fetch: fakeInstall(routes).fetch,
    });
    assert.match(result.stdout, /^TITLE\s+ID\nGrow MRR\s+g1\n/);
  });

  test("--select prints a bare value for $(…), and JSON with --json", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall(routes);
    const bare = await run(["goals", "list", "--select", "0.id"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(bare.stdout, "g1\n");
    const quoted = await run(["goals", "list", "--select", "0.id", "--json"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(quoted.stdout, '"g1"\n');
    const many = await run(["goals", "list", "--select", "*.title"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(many.stdout, '["Grow MRR","Hire"]\n');
  });

  test("an empty answer prints nothing", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({ [`DELETE ${goalsPath}/g1`]: () => new Response(null, { status: 204 }) });
    const result = await run(["goals", "delete", "g1"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
  });
});

describe("errors: exit codes and rendering", () => {
  const statusCases: Array<[number, unknown, number, string]> = [
    [400, { error: "ValidationError", issues: [{ path: ["title"], message: "Required" }] }, 6, "validation"],
    [401, { error: "Unauthorized" }, 3, "auth"],
    [403, { error: "Admins only" }, 4, "forbidden"],
    [404, { error: "Not found" }, 5, "not_found"],
    [409, { error: "Already exists" }, 7, "conflict"],
    [429, { error: "Slow down" }, 7, "rate_limited"],
    [500, { error: "Internal error" }, 8, "server"],
  ];
  for (const [status, body, code, kind] of statusCases) {
    test(`a ${status} exits ${code} with a ${kind} error on stderr`, async (t) => {
      const dir = tempDir(t);
      const install = fakeInstall({ [`POST ${goalsPath}`]: () => json(body, status) });
      const result = await run(["goals", "create", "--title", "x", "--target-value", "1"], {
        env: keyed(dir),
        fetch: install.fetch,
      });
      assert.equal(result.code, code);
      assert.equal(result.stdout, "");
      const { error } = stderrJson(result);
      assert.equal(error.kind, kind);
      assert.equal(error.status, status);
      assert.equal(error.operationId, "createGoal");
      assert.equal(error.method, "POST");
      assert.equal(error.url, `${BASE}${goalsPath}`);
      assertNoKey(result);
      if (status === 400) {
        assert.deepEqual(error.issues, [{ path: "title", message: "Required", flag: "--title" }]);
      }
    });
  }

  test("an unreachable server exits 9", async (t) => {
    const dir = tempDir(t);
    const fetch = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "refused" } });
    }) as typeof globalThis.fetch;
    const result = await run(["goals", "list"], { env: keyed(dir), fetch });
    assert.equal(result.code, 9);
    assert.equal(stderrJson(result).error.kind, "network");
  });

  test("a person at a terminal reads the error; --json makes it JSON again", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({
      [`POST ${goalsPath}`]: () => json({ error: "ValidationError", issues: [{ path: ["targetValue"], message: "Expected number" }] }, 400),
    });
    const human = await run(["goals", "create", "--title", "x"], { env: keyed(dir), fetch: install.fetch, stderrTTY: true });
    assert.equal(human.code, 6);
    assert.match(human.stderr, /^✗ Rejected \(400\): The request didn't pass the server's validation\.\n {2}• --target-value: Expected number\n/);
    assert.match(human.stderr, /genosyn-api describe createGoal/);
    const machine = await run(["goals", "create", "--title", "x", "--json"], { env: keyed(dir), fetch: install.fetch, stderrTTY: true });
    assert.equal(stderrJson(machine).error.kind, "validation");
  });

  test("a browser-only operation is refused before anything is sent (exit 4)", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const result = await run(["call", "createApiKey"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(result.code, 4);
    const { error } = stderrJson(result);
    assert.equal(error.kind, "forbidden");
    assert.match(error.message as string, /needs a person signed in/);
    assert.ok(!install.requests.some((request) => request.url.pathname.endsWith("/api-keys")));
  });

  test("not logged in is exit 3 with how to fix it", async (t) => {
    const dir = tempDir(t);
    const result = await run(["whoami"], { env: envFor(dir) });
    assert.equal(result.code, 3);
    assert.match(stderrJson(result).error.hint as string, /genosyn-api login/);
    const noKey = await run(["goals", "list"], { env: envFor(dir, { GENOSYN_URL: BASE_URL }), fetch: fakeInstall().fetch });
    assert.equal(noKey.code, 3);
  });
});

describe("login, profiles, logout and whoami", () => {
  test("login checks the key, then saves a 0600 profile named after the company", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const result = await run(["login", "--url", BASE_URL, "--with-token"], {
      env: envFor(dir),
      fetch: install.fetch,
      stdin: `${API_KEY}\n`,
    });
    assert.equal(result.code, 0, result.stderr);
    assertNoKey(result);
    const output = JSON.parse(result.stdout);
    assert.equal(output.profile, "acme");
    assert.equal(output.company.name, "Acme");
    assert.equal(output.role, "owner");
    assert.equal(output.apiKey.prefix, "gen_TestKeyA");
    assert.equal(output.verified, true);
    const file = path.join(dir, "genosyn-api.json");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(saved.currentProfile, "acme");
    assert.deepEqual(
      { url: saved.profiles.acme.url, companyId: saved.profiles.acme.companyId, apiKey: saved.profiles.acme.apiKey },
      { url: BASE, companyId: COMPANY_ID, apiKey: API_KEY },
    );
    assert.equal(install.requests.at(-1)?.headers.get("authorization"), `Bearer ${API_KEY}`);
  });

  test("login at a terminal asks for the address and the key, hiding the key", async (t) => {
    const dir = tempDir(t);
    const result = await run(["login"], {
      env: envFor(dir),
      fetch: fakeInstall().fetch,
      stdinTTY: true,
      stderrTTY: true,
      stdoutTTY: true,
      answers: [BASE_URL],
      secret: API_KEY,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.io.prompts, ["Base URL from Settings → API keys: ", "API key (input hidden): "]);
    assert.match(result.stdout, /✓ Logged in to Acme as ada@example\.test \(owner\)\./);
    assert.match(result.stdout, /Key\s+laptop \(gen_TestKeyA…\) · never expires/);
    assertNoKey(result);
  });

  test("login refuses what isn't a key, and saves nothing when the server refuses it", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const notKey = await run(["login", "--url", BASE_URL, "--with-token"], { env: envFor(dir), fetch: install.fetch, stdin: "hunter2" });
    assert.equal(notKey.code, 2);
    assert.equal(install.requests.length, 0);
    const refused = await run(["login", "--url", BASE_URL, "--with-token"], {
      env: envFor(dir),
      fetch: install.fetch,
      stdin: "gen_wrongkey",
    });
    assert.equal(refused.code, 3);
    assert.ok(!fs.existsSync(path.join(dir, "genosyn-api.json")));
    const empty = await run(["login", "--url", BASE_URL, "--with-token"], { env: envFor(dir), fetch: install.fetch, stdin: "" });
    assert.equal(empty.code, 2);
  });

  test("login without a terminal needs the Base URL, company and key given", async (t) => {
    const dir = tempDir(t);
    const noUrl = await run(["login", "--with-token"], { env: envFor(dir), stdin: API_KEY });
    assert.equal(noUrl.code, 2);
    assert.match(stderrJson(noUrl).error.hint as string, /Base URL/);
    const noCompany = await run(["login", "--url", BASE, "--with-token"], { env: envFor(dir), stdin: API_KEY });
    assert.equal(noCompany.code, 2);
    const noKey = await run(["login", "--url", BASE_URL], { env: envFor(dir) });
    assert.equal(noKey.code, 2);
    assert.match(stderrJson(noKey).error.hint as string, /--with-token/);
    const withCompany = await run(["login", BASE, "--company", COMPANY_ID, "--with-token"], {
      env: envFor(dir),
      fetch: fakeInstall().fetch,
      stdin: API_KEY,
    });
    assert.equal(withCompany.code, 0, withCompany.stderr);
  });

  test("login --no-verify saves without asking the server", async (t) => {
    const dir = tempDir(t);
    const result = await run(["login", "--url", BASE_URL, "--with-token", "--no-verify", "--profile", "ci"], {
      env: envFor(dir),
      stdin: API_KEY,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).verified, false);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "genosyn-api.json"), "utf8"));
    assert.equal(saved.profiles.ci.apiKey, API_KEY);
  });

  test("login warns before sending a key over plain http to another machine", async (t) => {
    const dir = tempDir(t);
    const result = await run(["login", "--url", `http://192.168.1.5:8471/api/companies/${COMPANY_ID}`, "--with-token", "--no-verify"], {
      env: envFor(dir),
      stdin: API_KEY,
    });
    assert.equal(result.code, 0);
    assert.match(JSON.parse(result.stderr.split("\n")[0]).warning.message, /plain http/);
  });

  test("login won't silently replace another install's profile of the same name", async (t) => {
    const dir = tempDir(t);
    const env = envFor(dir);
    await run(["login", "--url", BASE_URL, "--with-token", "--no-verify", "--profile", "acme"], { env, stdin: API_KEY });
    const other = `https://other.test/api/companies/${COMPANY_ID}`;
    const install = fakeInstall();
    const clash = await run(["login", "--url", BASE_URL, "--with-token"], {
      env: { ...env },
      fetch: install.fetch,
      stdin: API_KEY,
    });
    assert.equal(clash.code, 0, "the same install and company just refreshes the profile");
    const otherFetch = (async (input: string | URL | Request, init?: RequestInit) =>
      install.fetch(String(input).replace("https://other.test", BASE), init)) as typeof globalThis.fetch;
    const conflict = await run(["login", "--url", other, "--with-token"], { env, fetch: otherFetch, stdin: API_KEY });
    assert.equal(conflict.code, 2);
    assert.match(stderrJson(conflict).error.hint as string, /--profile/);
  });

  test("profiles list, show, use and remove; logout", async (t) => {
    const dir = tempDir(t);
    const env = envFor(dir);
    const other = "22222222-2222-4333-8444-555555555555";
    await run(["login", "--url", BASE_URL, "--with-token", "--no-verify", "--profile", "acme"], { env, stdin: API_KEY });
    await run(["login", "--url", `${BASE}/api/companies/${other}`, "--with-token", "--no-verify", "--profile", "beta"], {
      env,
      stdin: "gen_BetaKeyAbcdefghijklmnopqrstuvwxyz0123456789",
    });

    const list = await run(["profiles"], { env });
    const profiles = JSON.parse(list.stdout);
    assert.deepEqual(
      profiles.map((profile: { name: string; current: boolean }) => [profile.name, profile.current]),
      [
        ["acme", false],
        ["beta", true],
      ],
    );
    assert.ok(!list.stdout.includes(API_KEY) && !list.stdout.includes("gen_BetaKeyAbcdefghij"));
    assert.equal(profiles[0].key, "gen_TestKeyA…");

    const table = await run(["profiles", "list"], { env, stdoutTTY: true });
    assert.match(table.stdout, /\*\s+beta/);

    assert.equal((await run(["profiles", "use", "acme"], { env })).code, 0);
    const show = JSON.parse((await run(["profiles", "show"], { env })).stdout);
    assert.equal(show.name, "acme");
    assert.equal(show.current, true);
    assert.equal(show.config, path.join(dir, "genosyn-api.json"));

    assert.equal((await run(["profiles", "use", "gamma"], { env })).code, 2);
    assert.equal((await run(["profiles", "frobnicate"], { env })).code, 2);

    const removed = await run(["profiles", "remove", "beta"], { env });
    assert.deepEqual(JSON.parse(removed.stdout), { removed: "beta", currentProfile: "acme" });
    const loggedOut = await run(["logout"], { env, stdoutTTY: true });
    assert.match(loggedOut.stdout, /Removed profile acme.*revoked at Settings → API keys/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "genosyn-api.json"), "utf8")).profiles, {});
    assert.equal((await run(["logout"], { env })).code, 2);
  });

  test("whoami names the Member, company, role and key, never the key itself", async (t) => {
    const dir = tempDir(t);
    const env = envFor(dir);
    const install = fakeInstall();
    await run(["login", "--url", BASE_URL, "--with-token"], { env, fetch: install.fetch, stdin: API_KEY });
    const machine = await run(["whoami"], { env, fetch: install.fetch });
    assert.equal(machine.code, 0);
    const me = JSON.parse(machine.stdout);
    assert.equal(me.user.email, "ada@example.test");
    assert.equal(me.profile, "acme");
    assert.equal(me.url, BASE);
    const person = await run(["whoami"], { env, fetch: install.fetch, stdoutTTY: true });
    assert.match(person.stdout, /Member\s+Ada Lovelace <ada@example\.test>/);
    assert.match(person.stdout, /Role\s+owner · Finance: full/);
    assert.match(person.stdout, /Profile\s+acme · https:\/\/genosyn\.example\.test/);
    assertNoKey(person);
  });

  test("the environment alone is enough, and nothing is written to disk", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({ [`GET ${goalsPath}`]: () => json([]) });
    const me = await run(["whoami"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(me.code, 0);
    assert.equal(JSON.parse(me.stdout).profile, null);
    assert.equal((await run(["goals", "list"], { env: keyed(dir), fetch: install.fetch })).stdout, "[]\n");
    assert.ok(!fs.existsSync(path.join(dir, "genosyn-api.json")));
  });

  test("the environment beats the profile, and a saved key never follows GENOSYN_URL elsewhere", async (t) => {
    const dir = tempDir(t);
    const env = envFor(dir);
    const install = fakeInstall();
    await run(["login", "--url", BASE_URL, "--with-token"], { env, fetch: install.fetch, stdin: API_KEY });
    const elsewhere = await run(["whoami"], {
      env: { ...env, GENOSYN_URL: `https://elsewhere.test/api/companies/${COMPANY_ID}` },
      fetch: install.fetch,
    });
    assert.equal(elsewhere.code, 3);
    assert.match(stderrJson(elsewhere).error.message as string, /saved key belongs to https:\/\/genosyn\.example\.test/);
    assert.ok(!install.requests.some((request) => request.url.host === "elsewhere.test"));
    const envKey = await run(["whoami"], { env: { ...env, GENOSYN_API_KEY: "gen_wrongkey" }, fetch: install.fetch });
    assert.equal(envKey.code, 3, "GENOSYN_API_KEY replaced the saved key");
    const flagProfile = await run(["whoami", "--profile", "nope"], { env, fetch: install.fetch });
    assert.equal(flagProfile.code, 2);
  });
});

describe("calling operations", () => {
  test("sends flags, items and positionals where they belong", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({
      [`POST ${goalsPath}`]: (request) => json({ id: "g9", ...JSON.parse(request.body as string) }, 201),
      [`PATCH ${goalsPath}/g9`]: (request) => json({ id: "g9", ...JSON.parse(request.body as string) }),
    });
    const created = await run(["goals", "create", "--title", "Q4", "targetValue:=10", "--archived"], {
      env: keyed(dir),
      fetch: install.fetch,
    });
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), { id: "g9", title: "Q4", targetValue: 10, archived: true });
    const updated = await run(["call", "updateGoal", "g9", "--no-archived", "note=done"], { env: keyed(dir), fetch: install.fetch });
    assert.deepEqual(JSON.parse(updated.stdout), { id: "g9", archived: false, note: "done" });
  });

  test("--data takes JSON, a file, or stdin", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({ [`POST ${goalsPath}`]: (request) => json(JSON.parse(request.body as string)) });
    fs.writeFileSync(path.join(dir, "goal.json"), JSON.stringify({ title: "From file", targetValue: 2 }));
    const fromFile = await run(["goals", "create", "--data", "@goal.json"], { env: keyed(dir), fetch: install.fetch, cwd: dir });
    assert.deepEqual(JSON.parse(fromFile.stdout), { title: "From file", targetValue: 2 });
    const fromStdin = await run(["goals", "create", "-d", "-", "--title", "Override"], {
      env: keyed(dir),
      fetch: install.fetch,
      stdin: '{"title":"Stdin","targetValue":3}',
    });
    assert.deepEqual(JSON.parse(fromStdin.stdout), { title: "Override", targetValue: 3 });
    const literal = await run(["goals", "create", "--data", '{"title":"Literal","targetValue":4}'], { env: keyed(dir), fetch: install.fetch });
    assert.deepEqual(JSON.parse(literal.stdout), { title: "Literal", targetValue: 4 });
    const broken = await run(["goals", "create", "--data", "{oops"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(broken.code, 2);
    assert.match(stderrJson(broken).error.message as string, /isn't valid JSON/);
    const missingFile = await run(["goals", "create", "--data", "@nope.json"], { env: keyed(dir), fetch: install.fetch, cwd: dir });
    assert.equal(missingFile.code, 2);
  });

  test("stdin is read only when asked for", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({ [`GET ${goalsPath}`]: () => json([]) });
    const result = await run(["goals", "list"], { env: keyed(dir), fetch: install.fetch, stdin: "ignored" });
    assert.equal(result.code, 0);
    assert.equal(result.io.stdinReads, 0);
  });

  test("--dry-run prints the request, key redacted, and sends nothing", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const result = await run(["goals", "create", "--title", "Q4", "--target-value", "1", "--dry-run"], {
      env: keyed(dir),
      fetch: install.fetch,
    });
    assert.equal(result.code, 0);
    const preview = JSON.parse(result.stdout);
    assert.equal(preview.method, "POST");
    assert.equal(preview.url, `${BASE}${goalsPath}`);
    assert.equal(preview.headers.authorization, "Bearer gen_TestKeyA…");
    assert.deepEqual(preview.body, { title: "Q4", targetValue: 1 });
    assertNoKey(result);
    assert.ok(!install.requests.some((request) => request.method === "POST"));
    const human = await run(["goals", "create", "--title", "Q4", "--dry-run"], { env: keyed(dir), fetch: install.fetch, stdoutTTY: true });
    assert.match(human.stdout, /^POST https:\/\/genosyn\.example\.test\/api\/companies\/.+\/goals\n/);
    assert.match(human.stdout, /\nauthorization: Bearer gen_TestKeyA…\n/);
    assert.match(human.stdout, /\n\{\n {2}"title": "Q4"\n\}\n$/);
  });

  test("uploads a file as multipart form data", async (t) => {
    const dir = tempDir(t);
    fs.writeFileSync(path.join(dir, "notes.md"), "# Notes\n");
    let received: FormData | null = null;
    const install = fakeInstall({
      [`POST /api/companies/${COMPANY_ID}/resources/upload`]: (request) => {
        received = request.body as FormData;
        return json({ id: "r1" }, 201);
      },
    });
    const result = await run(["resources", "upload", "--file", "notes.md"], { env: keyed(dir), fetch: install.fetch, cwd: dir });
    assert.equal(result.code, 0, result.stderr);
    const file = (received as unknown as FormData).get("file") as File;
    assert.equal(file.name, "notes.md");
    assert.equal(file.type, "text/markdown");
    assert.equal(await file.text(), "# Notes\n");
  });

  test("a file answer is saved with --output, refused at a terminal, and streamed into a pipe", async (t) => {
    const dir = tempDir(t);
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const install = fakeInstall({
      [`GET /api/companies/${COMPANY_ID}/resources/handbook/file`]: () =>
        new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
    });
    const saved = await run(["resources", "get-file", "handbook", "--output", "out.bin"], { env: keyed(dir), fetch: install.fetch, cwd: dir });
    assert.equal(saved.code, 0, saved.stderr);
    assert.deepEqual(fs.readFileSync(path.join(dir, "out.bin")), bytes);
    assert.deepEqual(JSON.parse(saved.stdout), {
      saved: path.join(dir, "out.bin"),
      bytes: 6,
      contentType: "application/octet-stream",
      status: 200,
    });
    const before = install.requests.length;
    const refused = await run(["resources", "get-file", "handbook"], { env: keyed(dir), fetch: install.fetch, stdoutTTY: true });
    assert.equal(refused.code, 2);
    assert.match(stderrJson(refused).error.hint as string, /--output/);
    assert.ok(
      install.requests.slice(before).every((request) => !request.url.pathname.endsWith("/file")),
      "refused before it was sent",
    );
    const piped = await run(["resources", "get-file", "handbook"], { env: keyed(dir), fetch: install.fetch });
    assert.deepEqual(piped.io.out.bytes(), bytes);
  });

  test("--raw prints the body exactly; text answers print as text", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({
      [`GET ${goalsPath}`]: () => new Response('{"a":1}', { headers: { "content-type": "application/json" } }),
      [`GET ${goalsPath}/g1`]: () => new Response("plain words", { headers: { "content-type": "text/plain" } }),
    });
    assert.equal((await run(["goals", "list", "--raw"], { env: keyed(dir), fetch: install.fetch, stdoutTTY: true })).stdout, '{"a":1}');
    assert.equal((await run(["goals", "get", "g1"], { env: keyed(dir), fetch: install.fetch, stdoutTTY: true })).stdout, "plain words\n");
  });

  test("--all follows offset pages into one result", async (t) => {
    const dir = tempDir(t);
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: `d${index}` }));
    const install = fakeInstall({
      [`GET /api/companies/${COMPANY_ID}/revenue/deals`]: (request) => {
        const offset = Number(request.url.searchParams.get("offset") ?? 0);
        const limit = Number(request.url.searchParams.get("limit") ?? 2);
        return json({ rows: rows.slice(offset, offset + limit), total: rows.length });
      },
    });
    const result = await run(["revenue", "list-deals", "--limit", "2", "--all"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { rows, total: 5 });
    const pages = install.requests.filter((request) => request.url.pathname.endsWith("/revenue/deals"));
    assert.deepEqual(
      pages.map((request) => request.url.searchParams.get("offset")),
      [null, "2", "4"],
    );
    const capped = await run(["revenue", "list-deals", "--limit", "2", "--all", "--max-pages", "2"], {
      env: keyed(dir),
      fetch: install.fetch,
    });
    assert.equal(JSON.parse(capped.stdout).rows.length, 4);
    assert.match(JSON.parse(capped.stderr.trim()).warning.message, /Stopped after 2 pages/);
  });

  test("an operation the cached description doesn't know triggers one refresh", async (t) => {
    const dir = tempDir(t);
    const spec = syntheticSpec();
    const install = fakeInstall(
      { [`GET /api/companies/${COMPANY_ID}/brand-new`]: () => json({ fresh: true }) },
      { spec },
    );
    assert.equal((await run(["areas"], { env: keyed(dir), fetch: install.fetch })).code, 0);
    spec.paths!["/api/companies/{cid}/brand-new"] = {
      get: { operationId: "getBrandNew", tags: ["Goals"], "x-genosyn-access": { apiKey: true }, parameters: [], responses: {} },
    };
    const result = await run(["call", "getBrandNew"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { fresh: true });
    const specFetches = install.requests.filter((request) => request.url.pathname === "/api/openapi.json");
    assert.equal(specFetches.length, 2);
  });

  test("a parameter the cached description doesn't know triggers one refresh", async (t) => {
    const dir = tempDir(t);
    const spec = syntheticSpec();
    const install = fakeInstall(
      { [`POST ${goalsPath}`]: (request) => json(JSON.parse(request.body as string), 201) },
      { spec },
    );
    assert.equal((await run(["areas"], { env: keyed(dir), fetch: install.fetch })).code, 0);
    const goalInput = spec.components!.schemas!.GoalInput as { properties: Record<string, unknown> };
    goalInput.properties.priority = { type: "string", enum: ["low", "high"] };
    const result = await run(["goals", "create", "--title", "x", "--target-value", "1", "--priority", "high"], {
      env: keyed(dir),
      fetch: install.fetch,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { title: "x", targetValue: 1, priority: "high" });
    assert.equal(install.requests.filter((request) => request.url.pathname === "/api/openapi.json").length, 2);

    const unknown = await run(["goals", "create", "--title", "x", "--colour", "red"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(unknown.code, 2, "still unknown after the refresh");
    assert.equal(install.requests.filter((request) => request.url.pathname === "/api/openapi.json").length, 3);
  });

  test("public operations need no key and send none", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const result = await run(["system", "get-health"], { env: envFor(dir, { GENOSYN_URL: BASE }), fetch: install.fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, version: "9.9.9" });
    const health = install.requests.filter((request) => request.url.pathname === "/api/health").at(-1);
    assert.equal(health?.headers.get("authorization"), null);
  });

  test("--verbose logs the exchange on stderr with the key redacted", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({ [`GET ${goalsPath}`]: () => json([]) });
    const result = await run(["goals", "list", "--verbose"], { env: keyed(dir), fetch: install.fetch });
    assert.equal(result.code, 0);
    assert.match(result.stderr, new RegExp(`→ GET ${BASE.replace(/\./g, "\\.")}${goalsPath}`));
    assert.match(result.stderr, /authorization: Bearer gen_TestKeyA…/);
    assert.match(result.stderr, /← 200/);
    assertNoKey(result);
  });
});

describe("discovery", () => {
  test("areas lists the key areas with counts; --include-all adds the rest", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const areas = JSON.parse((await run(["areas"], { env: envFor(dir, { GENOSYN_URL: BASE }), fetch: install.fetch })).stdout);
    assert.deepEqual(
      areas.map((area: { area: string; operations: number }) => [area.area, area.operations]),
      [
        ["goals", 6],
        ["revenue", 4],
        ["resources", 3],
      ],
    );
    const all = JSON.parse(
      (await run(["areas", "--include-all"], { env: envFor(dir, { GENOSYN_URL: BASE }), fetch: install.fetch })).stdout,
    );
    assert.deepEqual(
      all.map((area: { area: string }) => area.area),
      ["goals", "revenue", "resources", "api-keys", "system"],
    );
  });

  test("ops lists an area's operations; search ranks matches", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall();
    const env = envFor(dir, { GENOSYN_URL: BASE });
    const ops = JSON.parse((await run(["ops", "revenue"], { env, fetch: install.fetch })).stdout);
    assert.deepEqual(
      ops.map((operation: { operationId: string }) => operation.operationId),
      ["listRevenueDeals", "moveRevenueDealStage", "listRevenueFollowUps", "setRevenueSettings"],
    );
    assert.equal(ops[0].command, "revenue list-deals");
    const found = JSON.parse((await run(["search", "deal", "list"], { env, fetch: install.fetch })).stdout);
    assert.equal(found[0].operationId, "listRevenueDeals");
    const searched = JSON.parse((await run(["ops", "--search", "goal"], { env, fetch: install.fetch })).stdout);
    assert.ok(searched.every((operation: { area: string }) => operation.area === "Goals"));
    const table = await run(["ops", "goals"], { env, fetch: install.fetch, stdoutTTY: true });
    assert.match(table.stdout, /^COMMAND\s+METHOD\s+PATH\s+SUMMARY\ngoals list\s+GET\s+\/goals\s+List goals/);
    assert.equal((await run(["ops", "nope"], { env, fetch: install.fetch })).code, 2);
    assert.equal((await run(["search"], { env, fetch: install.fetch })).code, 2);
  });

  test("describe --json gives the full operation", async (t) => {
    const dir = tempDir(t);
    const result = await run(["describe", "goals", "create", "--json"], {
      env: envFor(dir, { GENOSYN_URL: BASE }),
      fetch: fakeInstall().fetch,
    });
    const described = JSON.parse(result.stdout);
    assert.equal(described.operationId, "createGoal");
    assert.equal(described.body.schema.properties.targetValue.type, "number");
    assert.equal((await run(["describe", "nothing"], { env: envFor(dir, { GENOSYN_URL: BASE }), fetch: fakeInstall().fetch })).code, 2);
  });

  test("spec shows, refreshes and prints the cached description", async (t) => {
    const dir = tempDir(t);
    const install = fakeInstall({}, { version: "3.2.1" });
    const env = envFor(dir, { GENOSYN_URL: BASE });
    const info = JSON.parse((await run(["spec"], { env, fetch: install.fetch })).stdout);
    assert.equal(info.serverVersion, "3.2.1");
    assert.equal(info.operations, 15);
    assert.equal(info.apiKeyOperations, 13);
    assert.ok(info.cache.startsWith(path.join(dir, "cache")));
    const refreshed = JSON.parse((await run(["spec", "refresh"], { env, fetch: install.fetch })).stdout);
    assert.equal(refreshed.source, "network");
    const printed = JSON.parse((await run(["spec", "print"], { env, fetch: install.fetch })).stdout);
    assert.equal(printed.openapi, "3.0.0");
    assert.equal((await run(["spec", "explode"], { env, fetch: install.fetch })).code, 2);
  });
});
