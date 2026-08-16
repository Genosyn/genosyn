import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { EmployeeMemberBrowserGrant } from "../db/entities/EmployeeMemberBrowserGrant.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AppDataSource } from "../db/datasource.js";
import { browserApprovalRequiredForSession } from "../routes/browserRpc.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { browserAccessEnabledForSession } from "./browserAccess.js";
import { createBrowserSession } from "./browserSessions.js";
import { createMemberBrowser, grantMemberBrowser, revokeMemberBrowser } from "./memberBrowsers.js";

/**
 * The policy re-check that runs on every browser RPC, exercised through the
 * seam the RPC layer actually calls. The point of these tests is the *timing*:
 * a session is bound to a browser once, but authorization is re-derived on
 * each call, so withdrawing it has to stop the Run that is already using it.
 */

let companyId: string;

before(initTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = testCompanyId();
});
after(closeTestDb);

async function employee(overrides: Partial<AIEmployee> = {}): Promise<AIEmployee> {
  return insert(AIEmployee, {
    companyId,
    name: "Operator",
    slug: `operator-${randomUUID()}`,
    role: "Operations",
    browserEnabled: true,
    ...overrides,
  });
}

async function memberBrowser(overrides: { allowUnattended?: boolean } = {}) {
  const { browser } = await createMemberBrowser({
    companyId,
    ownerUserId: "user_1",
    name: "Chrome on my laptop",
    allowedHosts: "example.com",
    allowUnattended: overrides.allowUnattended,
  });
  return browser;
}

async function boundSession(
  emp: AIEmployee,
  browserId: string | null,
  runId: string | null = null,
): Promise<BrowserSession> {
  return insert(BrowserSession, {
    companyId,
    employeeId: emp.id,
    conversationId: null,
    runId,
    memberBrowserId: browserId,
    mcpToken: randomUUID(),
    mcpTokenExpiresAt: new Date(Date.now() + 60_000),
    status: "live",
  });
}

describe("live policy behind a bound session", () => {
  test("revoking the browser denies the session that is already using it", async () => {
    const emp = await employee();
    const browser = await memberBrowser();
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: browser.id });
    const session = await boundSession(emp, browser.id);

    assert.equal(await browserAccessEnabledForSession(session, emp), true);

    await revokeMemberBrowser(browser.id);

    // Not "the next session is denied" — this one, mid-Run, on its next tool
    // call. Anything weaker leaves a model driving a machine whose owner has
    // already said stop.
    assert.equal(await browserAccessEnabledForSession(session, emp), false);
  });

  test("deleting the grant denies the session that is already using it", async () => {
    const emp = await employee();
    const browser = await memberBrowser();
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: browser.id });
    const session = await boundSession(emp, browser.id);

    assert.equal(await browserAccessEnabledForSession(session, emp), true);

    await AppDataSource.getRepository(EmployeeMemberBrowserGrant).delete({
      employeeId: emp.id,
      memberBrowserId: browser.id,
    });

    assert.equal(await browserAccessEnabledForSession(session, emp), false);
  });

  test("a session on the App's own Chromium is unaffected by member browser policy", async () => {
    const emp = await employee();
    const browser = await memberBrowser();
    await revokeMemberBrowser(browser.id);
    const session = await boundSession(emp, null);

    assert.equal(await browserAccessEnabledForSession(session, emp), true);
  });

  test("a Run on a browser that forbids unattended use is denied even mid-flight", async () => {
    const emp = await employee();
    const browser = await memberBrowser({ allowUnattended: true });
    await grantMemberBrowser({ companyId, employeeId: emp.id, memberBrowserId: browser.id });
    const routine = await insert(Routine, {
      employeeId: emp.id,
      name: "Nightly",
      slug: `nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
    });
    const run = await insert(Run, {
      routineId: routine.id,
      startedAt: new Date(),
      status: "running",
    });
    const session = await boundSession(emp, browser.id, run.id);

    assert.equal(await browserAccessEnabledForSession(session, emp), true);

    // The owner turns unattended use off while the Routine is running: a laptop
    // they have stopped consenting to must stop being driven.
    await AppDataSource.getRepository(MemberBrowser).update(
      { id: browser.id },
      { allowUnattended: false },
    );

    assert.equal(await browserAccessEnabledForSession(session, emp), false);
  });
});

describe("reusing a conversation's browser session", () => {
  test("does not reuse a session that drives a different browser", async () => {
    const emp = await employee();
    const browser = await memberBrowser();
    const conversationId = randomUUID();

    const onServerBrowser = await createBrowserSession({
      companyId,
      employeeId: emp.id,
      conversationId,
      runId: null,
      memberBrowserId: null,
    });
    // Switching the thread from Genosyn's browser to the human's own must not
    // keep driving the session that was minted for the other one.
    const onMemberBrowser = await createBrowserSession({
      companyId,
      employeeId: emp.id,
      conversationId,
      runId: null,
      memberBrowserId: browser.id,
    });

    assert.notEqual(onMemberBrowser.id, onServerBrowser.id);
    assert.equal(onMemberBrowser.memberBrowserId, browser.id);

    const back = await createBrowserSession({
      companyId,
      employeeId: emp.id,
      conversationId,
      runId: null,
      memberBrowserId: null,
    });
    assert.notEqual(back.id, onMemberBrowser.id);
    assert.equal(back.memberBrowserId, null);
  });

  test("reuses the session when the same browser is still selected", async () => {
    const emp = await employee();
    const browser = await memberBrowser();
    const conversationId = randomUUID();

    const first = await createBrowserSession({
      companyId,
      employeeId: emp.id,
      conversationId,
      runId: null,
      memberBrowserId: browser.id,
    });
    const second = await createBrowserSession({
      companyId,
      employeeId: emp.id,
      conversationId,
      runId: null,
      memberBrowserId: browser.id,
    });

    assert.equal(second.id, first.id);
  });
});

describe("approval policy for a bound session", () => {
  test("requires approval whenever either the employee or the browser asks for it", () => {
    const strictEmployee = { browserApprovalRequired: true } as AIEmployee;
    const relaxedEmployee = { browserApprovalRequired: false } as AIEmployee;

    assert.equal(browserApprovalRequiredForSession(relaxedEmployee, null), false);
    assert.equal(browserApprovalRequiredForSession(strictEmployee, null), true);
    assert.equal(
      browserApprovalRequiredForSession(relaxedEmployee, { approvalRequired: false }),
      false,
    );
    // An employee configured for the unattended container browser must not
    // silently undo the default a Member's own machine ships with.
    assert.equal(
      browserApprovalRequiredForSession(relaxedEmployee, { approvalRequired: true }),
      true,
    );
    assert.equal(
      browserApprovalRequiredForSession(strictEmployee, { approvalRequired: false }),
      true,
    );
  });

  test("a member browser defaults to requiring approval", async () => {
    const browser = await memberBrowser();
    assert.equal(browser.approvalRequired, true);
  });
});
