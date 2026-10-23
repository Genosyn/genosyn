import assert from "node:assert/strict";
import path from "node:path";
import { after, before, test } from "node:test";

import { AppDataSource } from "../server/db/datasource.js";
import { AIEmployee } from "../server/db/entities/AIEmployee.js";
import { Routine } from "../server/db/entities/Routine.js";
import { createMemberOfNewCompany, mintTestApiKey } from "../server/test/apiAccess.js";
import { insert } from "../server/test/dbHarness.js";
import { run, stderrJson, tempDir, type RunResult } from "./test/support.js";
import { startTestServer, type TestServer } from "./test/server.js";

/**
 * A Routine's priority from a terminal: `genosyn-api` reads its commands from
 * the API reference, so the new field is a flag with no CLI change — this
 * pins that it is, that its values are checked, and that a Member's key is
 * refused exactly as in the app.
 */

let server: TestServer;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

async function account(t: { after: (fn: () => void) => void }, role: "owner" | "member") {
  const { user, company } = await createMemberOfNewCompany(role);
  const { token } = await mintTestApiKey(user.id, company.id);
  const dir = tempDir(t);
  return {
    token,
    company,
    env: {
      GENOSYN_CONFIG: path.join(dir, "genosyn-api.json"),
      GENOSYN_CACHE_DIR: path.join(dir, "cache"),
      GENOSYN_URL: `${server.baseUrl}/api/companies/${company.id}`,
      GENOSYN_API_KEY: token,
      NO_COLOR: "1",
    },
  };
}

async function routineIn(companyId: string) {
  const employee = await insert(AIEmployee, {
    companyId,
    name: "Jamie Mallers",
    slug: "jamie",
    role: "VP of Go to Market",
  });
  return insert(Routine, {
    employeeId: employee.id,
    name: "Daily CRM Sync",
    slug: "daily-crm-sync",
    cronExpr: "0 9 * * *",
    body: "Sync the CRM.",
  });
}

const cli = (env: Record<string, string>, argv: string[]): Promise<RunResult> =>
  run(argv, { env, fetch: globalThis.fetch });

const stored = async (id: string) =>
  (await AppDataSource.getRepository(Routine).findOneByOrFail({ id })).priority;

test("routines update takes --priority, and help names its values", async (t) => {
  const owner = await account(t, "owner");
  const routine = await routineIn(owner.company.id);
  const help = await cli(owner.env, ["routines", "update", "--help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /--priority/);
  assert.match(help.stdout, /normal/);
  assert.match(help.stdout, /high/);

  const updated = await cli(owner.env, ["routines", "update", routine.id, "--priority", "high"]);
  assert.equal(updated.code, 0, updated.stderr);
  assert.equal((JSON.parse(updated.stdout) as { priority: string }).priority, "high");
  assert.equal(await stored(routine.id), "high");
});

test("an unknown priority is a validation error, and nothing changes", async (t) => {
  const owner = await account(t, "owner");
  const routine = await routineIn(owner.company.id);
  const refused = await cli(owner.env, ["routines", "update", routine.id, "--priority", "urgent"]);
  // The server's zod schema is the one check: a 400 is exit code 6.
  assert.equal(refused.code, 6, refused.stderr);
  assert.equal(stderrJson(refused).error.status, 400);
  assert.equal(await stored(routine.id), "normal");
});

test("a Member's key cannot change it: the server's 403 is exit code 4", async (t) => {
  const member = await account(t, "member");
  const routine = await routineIn(member.company.id);
  const refused = await cli(member.env, ["routines", "update", routine.id, "--priority", "high"]);
  assert.equal(refused.code, 4, refused.stderr);
  assert.equal(stderrJson(refused).error.status, 403);
  assert.equal(await stored(routine.id), "normal");
});
