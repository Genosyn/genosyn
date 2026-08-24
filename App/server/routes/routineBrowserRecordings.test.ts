import assert from "node:assert/strict";
import crypto, { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import express from "express";

import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { ApiKey } from "../db/entities/ApiKey.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { Membership } from "../db/entities/Membership.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { User } from "../db/entities/User.js";
import { hashApiToken } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error.js";
import {
  acceptBrowserRecordingFrame,
  beginBrowserRecording,
  finishBrowserRecording,
  resetBrowserRecordingsForTests,
  setBrowserRecordingEncoderFactoryForTests,
} from "../services/browserRecordings.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { routinesRouter } from "./routines.js";

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let tempDir = "";
let server: Server;
let baseUrl = "";
let actingUserId: string | null = null;

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-recording-routes-"));
  mutableConfig.dataDir = tempDir;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    next();
  });
  app.use("/api/companies/:cid", routinesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await resetBrowserRecordingsForTests();
  await resetTestDb();
  await fs.rm(path.join(tempDir, ".private"), { recursive: true, force: true });
  actingUserId = null;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await resetBrowserRecordingsForTests();
  mutableConfig.dataDir = originalDataDir;
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function fixture() {
  const owner = await insert(User, {
    email: `recording-owner-${randomUUID()}@example.com`,
    name: "Owner",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const member = await insert(User, {
    email: `recording-member-${randomUUID()}@example.com`,
    name: "Member",
    passwordHash: "x",
    sessionVersion: 0,
  });
  const company = await insert(Company, {
    name: "Recording Routes Co",
    slug: `recording-routes-${randomUUID()}`,
    ownerId: owner.id,
  });
  await Promise.all([
    insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" }),
    insert(Membership, { companyId: company.id, userId: member.id, role: "member" }),
  ]);
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Browser Employee",
    slug: `browser-${randomUUID()}`,
    role: "Operations",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Browser Routine",
    slug: `browser-routine-${randomUUID()}`,
    cronExpr: "0 * * * *",
  });
  const run = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date(),
    finishedAt: null,
    status: "running",
    exitCode: null,
    logContent: "run log",
    dismissedAt: null,
    triggerKind: "schedule",
    attempt: 1,
    parentRunId: null,
    retryAt: null,
    missedSlots: 0,
  });
  const memberBrowser = await insert(MemberBrowser, {
    companyId: company.id,
    ownerUserId: member.id,
    name: "Member Chrome",
    status: "offline",
    pairingCodeHash: null,
    pairingCodeExpiresAt: null,
    tokenHash: null,
    tokenPrefix: null,
    allowedHosts: "example.com",
    approvalRequired: true,
    allowUnattended: true,
    browserVersion: null,
    platform: null,
    lastSeenAt: null,
    revokedAt: null,
  });
  const sessionValues = {
    companyId: company.id,
    employeeId: employee.id,
    conversationId: null,
    runId: run.id,
    mcpTokenExpiresAt: new Date(Date.now() + 60_000),
    status: "live" as const,
    closeReason: null,
    pageUrl: "https://example.com",
    pageTitle: "Example",
    viewportWidth: 1280,
    viewportHeight: 800,
    startedAt: new Date(),
    closedAt: null,
  };
  const appSession = await insert(BrowserSession, {
    ...sessionValues,
    memberBrowserId: null,
    mcpToken: crypto.randomBytes(32).toString("hex"),
  });
  const memberSession = await insert(BrowserSession, {
    ...sessionValues,
    memberBrowserId: memberBrowser.id,
    mcpToken: crypto.randomBytes(32).toString("hex"),
  });
  setBrowserRecordingEncoderFactoryForTests(async ({ partPath }) => ({
    writeFrame(frame) {
      fsSync.appendFileSync(partPath, frame);
      return true;
    },
    finish: async () => ({ ok: true }),
    abort: async () => undefined,
  }));
  for (const session of [appSession, memberSession]) {
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from(`frame-${session.id}`).toString("base64"));
    await finishBrowserRecording(session);
  }
  return { owner, member, company, employee, run, appSession, memberSession };
}

/** A plain Member of the company — no admin role, no Member browser. */
async function addPlainMember(companyId: string, label: string): Promise<User> {
  const user = await insert(User, {
    email: `recording-${label}-${randomUUID()}@example.com`,
    name: label,
    passwordHash: "x",
    sessionVersion: 0,
  });
  await insert(Membership, { companyId, userId: user.id, role: "member" });
  return user;
}

async function recordingIds(companyId: string, runId: string): Promise<string[]> {
  const response = await fetch(`${runPath(companyId, runId)}/log`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { browserRecordings: Array<{ id: string }> };
  return body.browserRecordings.map(({ id }) => id);
}

function runPath(companyId: string, runId: string): string {
  return `${baseUrl}/api/companies/${companyId}/runs/${runId}`;
}

describe("Routine browser recording authorization", () => {
  test("shows App recordings only to admins and Member recordings only to their exact owner", async () => {
    const { owner, member, company, run, appSession, memberSession } = await fixture();
    const crossCompanySession = await insert(BrowserSession, {
      ...appSession,
      id: undefined,
      companyId: randomUUID(),
      mcpToken: crypto.randomBytes(32).toString("hex"),
    });
    await beginBrowserRecording(crossCompanySession);
    acceptBrowserRecordingFrame(
      crossCompanySession.id,
      Buffer.from("cross-company").toString("base64"),
    );
    await finishBrowserRecording(crossCompanySession);

    actingUserId = owner.id;
    const ownerLog = await fetch(`${runPath(company.id, run.id)}/log`);
    assert.equal(ownerLog.status, 200);
    assert.deepEqual(
      (
        (await ownerLog.json()) as { browserRecordings: Array<{ id: string }> }
      ).browserRecordings.map(({ id }) => id),
      [appSession.id],
    );
    assert.equal(
      (await fetch(`${runPath(company.id, run.id)}/browser-recordings/${crossCompanySession.id}`))
        .status,
      404,
    );

    actingUserId = member.id;
    const memberLog = await fetch(`${runPath(company.id, run.id)}/log`);
    assert.equal(memberLog.status, 200);
    assert.deepEqual(
      (
        (await memberLog.json()) as { browserRecordings: Array<{ id: string }> }
      ).browserRecordings.map(({ id }) => id),
      [memberSession.id],
    );
    assert.equal(
      (await fetch(`${runPath(company.id, run.id)}/browser-recordings/${appSession.id}`)).status,
      404,
    );
  });

  test("gives the AI Employee's human manager the App recording without an admin role", async () => {
    const { company, employee, run, appSession, memberSession } = await fixture();
    const manager = await addPlainMember(company.id, "manager");
    const bystander = await addPlainMember(company.id, "bystander");
    await AppDataSource.getRepository(AIEmployee).update(
      { id: employee.id },
      { reportsToUserId: manager.id },
    );

    actingUserId = manager.id;
    assert.deepEqual(await recordingIds(company.id, run.id), [appSession.id]);
    assert.equal(
      (await fetch(`${runPath(company.id, run.id)}/browser-recordings/${appSession.id}`)).status,
      200,
    );
    // A Member browser is the owner's own computer, so the org chart buys no
    // access to it.
    assert.equal(
      (await fetch(`${runPath(company.id, run.id)}/browser-recordings/${memberSession.id}`)).status,
      404,
    );

    // Being a Member of the company is not itself oversight.
    actingUserId = bystander.id;
    assert.deepEqual(await recordingIds(company.id, run.id), []);
  });

  test("follows the reporting line up through an AI manager to the human above it", async () => {
    const { company, employee, run, appSession } = await fixture();
    const manager = await addPlainMember(company.id, "skip-level");
    const lead = await insert(AIEmployee, {
      companyId: company.id,
      name: "Browser Lead",
      slug: `lead-${randomUUID()}`,
      role: "Lead",
      reportsToUserId: manager.id,
    });
    await AppDataSource.getRepository(AIEmployee).update(
      { id: employee.id },
      { reportsToEmployeeId: lead.id },
    );

    actingUserId = manager.id;
    assert.deepEqual(await recordingIds(company.id, run.id), [appSession.id]);
  });

  test("stops walking a reporting line that loops back on itself", async () => {
    const { company, employee, run } = await fixture();
    const stranger = await addPlainMember(company.id, "stranger");
    const lead = await insert(AIEmployee, {
      companyId: company.id,
      name: "Circular Lead",
      slug: `circular-${randomUUID()}`,
      role: "Lead",
      reportsToEmployeeId: employee.id,
    });
    await AppDataSource.getRepository(AIEmployee).update(
      { id: employee.id },
      { reportsToEmployeeId: lead.id },
    );

    actingUserId = stranger.id;
    assert.deepEqual(await recordingIds(company.id, run.id), []);
  });

  test("serves seekable ranges and attachment downloads from the private file", async () => {
    const { member, company, run, memberSession } = await fixture();
    actingUserId = member.id;
    const url = `${runPath(company.id, run.id)}/browser-recordings/${memberSession.id}`;

    const range = await fetch(url, { headers: { range: "bytes=0-3" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("accept-ranges"), "bytes");
    assert.equal(range.headers.get("content-type"), "video/mp4");
    assert.equal(range.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal((await range.arrayBuffer()).byteLength, 4);

    const download = await fetch(`${url}?disposition=attachment`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /^attachment;/);
    const size = (await download.arrayBuffer()).byteLength;

    const unsatisfiable = await fetch(url, {
      headers: { range: `bytes=${size}-` },
    });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get("accept-ranges"), "bytes");
    assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${size}`);
    assert.match(unsatisfiable.headers.get("content-type") ?? "", /^application\/json\b/);
    assert.equal(unsatisfiable.headers.get("content-disposition"), null);
    assert.equal(typeof ((await unsatisfiable.json()) as { error?: unknown }).error, "string");

    assert.equal((await fetch(`${url}?disposition=other`)).status, 400);
  });

  test("rejects API keys even when the key belongs to a company owner", async () => {
    const { owner, company, run } = await fixture();
    const tokenBody = crypto.randomBytes(32).toString("base64url");
    await insert(ApiKey, {
      companyId: company.id,
      userId: owner.id,
      name: "Recording key",
      prefix: tokenBody.slice(0, 8),
      tokenHash: hashApiToken(tokenBody),
    });
    actingUserId = null;

    const response = await fetch(`${runPath(company.id, run.id)}/browser-recordings`, {
      headers: { authorization: `Bearer gen_${tokenBody}` },
    });
    assert.equal(response.status, 403);
  });
});
