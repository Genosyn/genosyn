import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  encryptConnectionConfig,
  decryptConnectionConfig,
  invokeConnectionTool,
  refreshConnectionStatus,
} from "./integrations.js";
import { readSessionHealth, recordBrowserBlock } from "./browserConnectionHealth.js";
import { injectChromiumLauncherForTests } from "./browserProfile.js";

/**
 * The dispatcher's half of the browser-login story: a Connection whose
 * sign-in is walled off has to end up marked on the row, with the remedy
 * attached, and the classification has to survive to the next call so the
 * cooldown means something.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(async () => {
  injectChromiumLauncherForTests(null);
  await closeTestDb();
});

const CO = "co_browser_conn";

async function seed(config: Record<string, unknown>): Promise<{
  employee: AIEmployee;
  connection: IntegrationConnection;
}> {
  const employee = await insert(AIEmployee, {
    companyId: CO,
    name: "Jamie Mallers",
    slug: "jamie-mallers",
    role: "Marketing",
    soulBody: "",
  } as Partial<AIEmployee>);
  const connection = await insert(IntegrationConnection, {
    companyId: CO,
    provider: "x",
    label: "Brand account",
    authMode: "browser",
    encryptedConfig: encryptConnectionConfig(config, CO),
    accountHint: "@oneuptimehq",
    status: "connected",
    statusMessage: "",
    lastCheckedAt: new Date(),
  });
  await insert(EmployeeConnectionGrant, {
    employeeId: employee.id,
    connectionId: connection.id,
  });
  return { employee, connection };
}

async function reload(id: string): Promise<IntegrationConnection> {
  return AppDataSource.getRepository(IntegrationConnection).findOneByOrFail({ id });
}

/** A Chromium that refuses to start, standing in for a walled-off login
 *  without needing a real browser. */
function blockedChromium(message: string): void {
  injectChromiumLauncherForTests({
    launch: async () => {
      throw new Error(message);
    },
  });
}

const CREDENTIALS = { username: "oneuptimehq", password: "hunter2" };

describe("a blocked browser-login Connection", () => {
  test("stops claiming Connected and prints the remedy on the row", async () => {
    blockedChromium("Executable doesn't exist — chromium is not installed");
    const { employee, connection } = await seed({ ...CREDENTIALS });

    await assert.rejects(
      invokeConnectionTool({
        employee,
        connectionId: connection.id,
        toolName: "post_tweet",
        toolArgs: { text: "Shipping today." },
      }),
      /headless browser is not available/,
    );

    const row = await reload(connection.id);
    assert.equal(row.status, "error");
    assert.match(row.statusMessage, /headless browser is not available/);
  });

  test("the classification survives on the connection for the next call", async () => {
    blockedChromium("Executable doesn't exist — chromium is not installed");
    const { employee, connection } = await seed({ ...CREDENTIALS });

    await invokeConnectionTool({
      employee,
      connectionId: connection.id,
      toolName: "post_tweet",
      toolArgs: { text: "one" },
    }).catch(() => undefined);

    // The provider rewrote its config on the way out; the dispatcher has to
    // persist that even though the call failed, or the cooldown is lost.
    const health = readSessionHealth(decryptConnectionConfig(await reload(connection.id)));
    assert.equal(health.state, "blocked");
    assert.equal(health.reason, "unavailable");
    assert.equal(health.failures, 1);
    assert.ok((health.retryAfter ?? 0) > Date.now());
  });

  test("a second call inside the cooldown is refused without touching the browser", async () => {
    let launches = 0;
    injectChromiumLauncherForTests({
      launch: async () => {
        launches += 1;
        throw new Error("Executable doesn't exist — chromium is not installed");
      },
    });
    const { employee, connection } = await seed({ ...CREDENTIALS });

    for (const text of ["one", "two", "three"]) {
      await invokeConnectionTool({
        employee,
        connectionId: connection.id,
        toolName: "post_tweet",
        toolArgs: { text },
      }).catch(() => undefined);
    }

    assert.equal(launches, 1, "only the first attempt should reach the browser");
  });

  test("the human and the AI employee are given the same explanation", async () => {
    blockedChromium("Executable doesn't exist — chromium is not installed");
    const { employee, connection } = await seed({ ...CREDENTIALS });

    const toolError = await invokeConnectionTool({
      employee,
      connectionId: connection.id,
      toolName: "post_tweet",
      toolArgs: { text: "one" },
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    const row = await reload(connection.id);
    assert.ok(toolError);
    assert.equal(row.statusMessage, toolError.message);
  });
});

describe("checkStatus on a browser-login Connection", () => {
  test("reports a stored block rather than the presence of a password", async () => {
    const { connection } = await seed({
      ...CREDENTIALS,
      sessionHealth: recordBrowserBlock({
        previous: undefined,
        error: new Error("X login page did not render the username field."),
        now: Date.now(),
      }),
    });

    const refreshed = await refreshConnectionStatus(connection);

    assert.equal(refreshed.status, "error");
    assert.match(refreshed.statusMessage, /does not solve captchas/i);
  });

  test("an untouched connection still reads as connected", async () => {
    const { connection } = await seed({ ...CREDENTIALS });
    const refreshed = await refreshConnectionStatus(connection);
    assert.equal(refreshed.status, "connected");
    assert.equal(refreshed.statusMessage, "");
  });

  test("a lapsed session is marked Expired, not Error", async () => {
    const { connection } = await seed({
      ...CREDENTIALS,
      sessionHealth: recordBrowserBlock({
        previous: undefined,
        error: new Error("the account was logged out"),
        now: Date.now(),
      }),
    });
    const refreshed = await refreshConnectionStatus(connection);
    assert.equal(refreshed.status, "expired");
  });
});

describe("auth-mode enforcement at invoke time", () => {
  test("a tool the browser mode cannot run is refused before any browser starts", async () => {
    let launches = 0;
    injectChromiumLauncherForTests({
      launch: async () => {
        launches += 1;
        throw new Error("should never get here");
      },
    });
    const { employee, connection } = await seed({ ...CREDENTIALS });

    await assert.rejects(
      invokeConnectionTool({
        employee,
        connectionId: connection.id,
        toolName: "send_dm",
        toolArgs: { text: "hi", userId: "1" },
      }),
      /browser mode, which does not support send_dm/,
    );
    assert.equal(launches, 0);

    // And it stays a per-call refusal — the Connection is not at fault.
    const row = await reload(connection.id);
    assert.equal(row.status, "connected");
  });

  test("an unknown tool is still an unknown tool", async () => {
    const { employee, connection } = await seed({ ...CREDENTIALS });
    await assert.rejects(
      invokeConnectionTool({
        employee,
        connectionId: connection.id,
        toolName: "definitely_not_a_tool",
        toolArgs: {},
      }),
      /Unknown tool/,
    );
  });
});
