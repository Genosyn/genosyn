import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Approval } from "../db/entities/Approval.js";
import { AuditEvent } from "../db/entities/AuditEvent.js";
import { Company } from "../db/entities/Company.js";
import { CompanyPolicy } from "../db/entities/CompanyPolicy.js";
import { Routine } from "../db/entities/Routine.js";
import { User } from "../db/entities/User.js";
import { errorHandler } from "../middleware/error.js";
import {
  isTokenTainted,
  issueMcpToken,
  markTokenTainted,
  revokeMcpToken,
} from "../services/mcpTokens.js";
import { parseTaintedToolPayload } from "../services/taintPolicy.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { mcpInternalRouter } from "./mcpInternal.js";

/**
 * The M53 dispatch middleware end-to-end: a policy-forbidden tool refuses
 * with an audit trail before its handler runs, and a tainted turn's sink
 * call is held as a `tainted_tool` Approval instead of executing.
 */

let server: Server;
let baseUrl = "";
let token = "";
let company: Company;
let employee: AIEmployee;

before(async () => {
  await initTestDb();
  const app = express();
  app.use(express.json());
  app.use("/internal/mcp", mcpInternalRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  if (token) revokeMcpToken(token);
  await resetTestDb();
  const owner = await insert(User, {
    email: "owner@example.test",
    name: "Owner",
    passwordHash: "x",
  });
  company = await insert(Company, {
    name: "Acme",
    slug: `rails-mcp-${randomUUID()}`,
    ownerId: owner.id,
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Rey",
    slug: "rey",
    role: "Support",
    soulBody: "",
  });
  token = issueMcpToken(employee.id, company.id, { authority: "employee" });
});

after(async () => {
  if (token) revokeMcpToken(token);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await closeTestDb();
});

async function post<T = Record<string, unknown>>(
  path: string,
  args: unknown = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/internal/mcp${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

function tool<T = Record<string, unknown>>(name: string, args: unknown = {}) {
  return post<T>(`/tools/${name}`, args);
}

/**
 * A Router is case-insensitive and non-strict, so every one of these reaches
 * the `send_mail` handler — and so every one must meet the gates the
 * registered spelling does.
 */
const LOOSE_SEND_MAIL_PATHS = ["/tools/SEND_MAIL", "/tools/send_mail/", "/TOOLS/Send_Mail/"];

describe("policy-forbidden tools", () => {
  test("a forbidden tool is refused, named, and audited — its handler never runs", async () => {
    await insert(CompanyPolicy, {
      companyId: company.id,
      title: "No routine self-management",
      forbiddenTools: "create_routine\nlist_goals",
      enabled: true,
    });
    const refused = await tool<{ error: string }>("list_goals");
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /No routine self-management/);
    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      action: "policy.violation",
    });
    assert.equal(audits.length, 1);
  });

  test("an unforbidden tool is untouched", async () => {
    const listed = await tool<{ goals: unknown[] }>("list_goals");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.goals, []);
  });

  test("a forbidden tool is refused and audited under every path that reaches it", async () => {
    await insert(CompanyPolicy, {
      companyId: company.id,
      title: "No outbound mail",
      forbiddenTools: "send_mail",
      enabled: true,
    });
    for (const path of LOOSE_SEND_MAIL_PATHS) {
      const refused = await post<{ error: string }>(path, {
        to: "customer@example.test",
        subject: "Hello",
        bodyText: "Hi",
      });
      assert.equal(refused.status, 403, path);
      assert.match(refused.body.error, /No outbound mail/, path);
    }
    const audits = await AppDataSource.getRepository(AuditEvent).findBy({
      action: "policy.violation",
    });
    assert.deepEqual(
      audits.map((audit) => JSON.parse(audit.metadataJson).tool),
      LOOSE_SEND_MAIL_PATHS.map(() => "send_mail"),
    );
  });
});

describe("tainted sinks", () => {
  test("a tainted turn's Routine write is held as an approval, not executed", async () => {
    markTokenTainted(token);
    const held = await tool<{ status: string; approvalId: string }>("create_routine", {
      name: "Injected persistence",
      cronExpr: "0 3 * * *",
    });
    assert.equal(held.status, 200);
    assert.equal(held.body.status, "pending_approval");
    // Nothing was created — the sink never ran.
    assert.equal(await AppDataSource.getRepository(Routine).countBy({ employeeId: employee.id }), 0);
    const approval = await AppDataSource.getRepository(Approval).findOneByOrFail({
      id: held.body.approvalId,
    });
    assert.equal(approval.kind, "tainted_tool");
    assert.equal(approval.status, "pending");
    assert.match(approval.title ?? "", /create_routine/);
  });

  test("an untainted turn's identical call executes normally", async () => {
    const created = await tool<{ id?: string; error?: string }>("create_routine", {
      name: "Nightly digest",
      cronExpr: "0 3 * * *",
    });
    assert.equal(created.status, 200);
    assert.equal(
      await AppDataSource.getRepository(Routine).countBy({ employeeId: employee.id }),
      1,
    );
  });

  test("a tainted turn's reads stay free", async () => {
    markTokenTainted(token);
    assert.equal((await tool("list_goals")).status, 200);
  });

  test("a tainted turn's send is held under every path that reaches it", async () => {
    markTokenTainted(token);
    for (const path of LOOSE_SEND_MAIL_PATHS) {
      const held = await post<{ status: string; approvalId: string }>(path, {
        to: "attacker@example.test",
        subject: "Injected",
        bodyText: "Whatever the page asked for",
      });
      assert.equal(held.status, 200, path);
      assert.equal(held.body.status, "pending_approval", path);
      const approval = await AppDataSource.getRepository(Approval).findOneByOrFail({
        id: held.body.approvalId,
      });
      assert.equal(approval.kind, "tainted_tool");
      // Held under the registered name, so an approved replay passes the
      // payload allowlist and dispatches to the handler it was held from.
      assert.equal(parseTaintedToolPayload(approval.payloadJson).tool, "send_mail");
    }
  });

  test("a web tool taints the turn under every path that reaches it", async () => {
    // Refused by the handler's own validation, after the gate has marked the
    // turn — nothing is fetched.
    assert.equal((await post("/TOOLS/Fetch_Web_Page/", {})).status, 400);
    assert.equal(isTokenTainted(token), true);
  });
});
