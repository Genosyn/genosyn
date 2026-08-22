import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  encryptConnectionConfig,
  invokeConnectionTool,
  listConnections,
  refreshConnectionStatus,
  serializeConnection,
} from "./integrations.js";
import { buildIntegrationToolListing } from "./integrationToolListing.js";

/**
 * Browser login is retired: no provider offers the mode and nothing creates
 * a Connection in it any more. The rows it already created are still in the
 * database, though, and they are the point of this file — a credential we
 * can no longer use has to degrade into an honest dead end rather than a
 * crash, a silent "Connected", or a tool that fails only after promising.
 */

before(initTestDb);
beforeEach(resetTestDb);
after(closeTestDb);

const CO = "co_browser_conn";

async function seed(): Promise<{
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
    // The value a real leftover row carries. Nothing writes it today; the
    // column still accepts it, which is the whole point.
    authMode: "browser",
    encryptedConfig: encryptConnectionConfig({ username: "oneuptimehq", password: "hunter2" }, CO),
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

describe("a Connection left behind by browser login", () => {
  test("still reads back through the list endpoint without decrypting into a crash", async () => {
    const { connection } = await seed();
    const rows = await listConnections(CO);
    assert.equal(rows.length, 1);
    const dto = serializeConnection(rows[0]);
    assert.equal(dto.id, connection.id);
    assert.equal(dto.authMode, "browser");
    assert.equal(dto.accountHint, "@oneuptimehq");
    // Browser configs never held scope groups; the reader skips them rather
    // than decrypting a credential blob to learn nothing.
    assert.deepEqual(dto.scopeGroups, []);
  });

  test("offers the employee no tools at all", async () => {
    const { connection } = await seed();
    assert.deepEqual(buildIntegrationToolListing([connection]), []);
  });

  test("refuses every tool call, without blaming the row for it", async () => {
    const { employee, connection } = await seed();

    for (const toolName of ["post_tweet", "get_me", "send_dm"]) {
      await assert.rejects(
        invokeConnectionTool({
          employee,
          connectionId: connection.id,
          toolName,
          toolArgs: { text: "Shipping today.", userId: "1" },
        }),
        new RegExp(`browser mode, which does not support ${toolName}`),
      );
    }

    // A per-call refusal, not a credential verdict: nothing rewrote the row.
    const row = await reload(connection.id);
    assert.equal(row.status, "connected");
    assert.equal(row.statusMessage, "");
  });

  test("an unknown tool is still an unknown tool", async () => {
    const { employee, connection } = await seed();
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

describe("checkStatus on a Connection left behind by browser login", () => {
  test("stops claiming Connected and says what to do instead", async () => {
    const { connection } = await seed();

    const refreshed = await refreshConnectionStatus(connection);

    assert.equal(refreshed.status, "error");
    assert.match(refreshed.statusMessage, /retired/i);
    assert.match(refreshed.statusMessage, /OAuth/);
    assert.match(refreshed.statusMessage, /Vault/);
  });
});
