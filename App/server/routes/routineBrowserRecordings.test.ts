import { persistTestSession } from "../test/userSession.js";
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
  deleteBrowserRecordingsForRunIds,
  finishBrowserRecording,
  freezeBrowserRecording,
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
  app.use(async (req, _res, next) => {
    (req as unknown as { session: unknown }).session = actingUserId
      ? { userId: actingUserId, sessionVersion: 0 }
      : null;
    await persistTestSession(req);
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

async function fixture(options: { live?: boolean; frames?: boolean } = {}) {
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
    if (options.frames !== false) {
      acceptBrowserRecordingFrame(
        session.id,
        Buffer.from(`frame-${session.id}`).toString("base64"),
      );
    }
    if (!options.live) await finishBrowserRecording(session);
  }
  return { owner, member, company, employee, run, appSession, memberSession, memberBrowser };
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
  test("serves current live frames privately and waits for the first frame without caching", async () => {
    const { owner, company, run, appSession } = await fixture({ live: true, frames: false });
    actingUserId = owner.id;
    const url = `${runPath(company.id, run.id)}/browser-recordings/${appSession.id}/live`;
    const waiting = await fetch(url);
    assert.equal(waiting.status, 204);
    assert.equal(await waiting.text(), "");
    assert.equal(waiting.headers.get("cache-control"), "private, no-store, max-age=0");

    acceptBrowserRecordingFrame(appSession.id, Buffer.from("first-frame").toString("base64"));
    const first = await fetch(url, { headers: { "if-none-match": "*" } });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "image/jpeg");
    assert.equal(first.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(first.headers.get("pragma"), "no-cache");
    assert.equal(first.headers.get("expires"), "0");
    assert.equal(first.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.equal(first.headers.get("x-content-type-options"), "nosniff");
    assert.equal(first.headers.get("etag"), null);
    assert.equal(first.headers.get("last-modified"), null);
    assert.equal(await first.text(), "first-frame");

    acceptBrowserRecordingFrame(appSession.id, Buffer.from("next-frame").toString("base64"));
    const next = await fetch(url);
    assert.equal(next.status, 200);
    assert.equal(await next.text(), "next-frame");
  });

  test("gives live App recordings to admins and keeps live Member recordings with their owner", async () => {
    const { owner, member, company, run, appSession, memberSession, memberBrowser } = await fixture({
      live: true,
    });
    const appUrl = `${runPath(company.id, run.id)}/browser-recordings/${appSession.id}/live`;
    const memberUrl = `${runPath(company.id, run.id)}/browser-recordings/${memberSession.id}/live`;
    actingUserId = owner.id;
    assert.equal((await fetch(appUrl)).status, 200);
    assert.equal((await fetch(memberUrl)).status, 404);

    actingUserId = member.id;
    assert.equal((await fetch(appUrl)).status, 404);
    assert.equal((await fetch(memberUrl)).status, 200);
    await AppDataSource.getRepository(MemberBrowser).update(
      { id: memberBrowser.id },
      { ownerUserId: owner.id },
    );
    assert.equal((await fetch(memberUrl)).status, 404);
    actingUserId = owner.id;
    assert.equal((await fetch(memberUrl)).status, 200);

    await AppDataSource.getRepository(Membership).update(
      { companyId: company.id, userId: owner.id },
      { role: "member" },
    );
    assert.equal((await fetch(appUrl)).status, 404);
    assert.equal((await fetch(memberUrl)).status, 200);
    await AppDataSource.getRepository(Membership).delete({
      companyId: company.id,
      userId: owner.id,
    });
    assert.equal((await fetch(memberUrl)).status, 403);
  });

  test("rechecks live access when an AI Employee's reporting line changes", async () => {
    const { member, company, employee, run, appSession } = await fixture({ live: true });
    const lead = await insert(AIEmployee, {
      companyId: company.id,
      name: "Browser Lead",
      slug: `lead-${randomUUID()}`,
      role: "Lead",
      reportsToUserId: member.id,
    });
    await AppDataSource.getRepository(AIEmployee).update(
      { id: employee.id },
      { reportsToEmployeeId: lead.id },
    );
    const url = `${runPath(company.id, run.id)}/browser-recordings/${appSession.id}/live`;
    actingUserId = member.id;
    assert.equal((await fetch(url)).status, 200);
    await AppDataSource.getRepository(AIEmployee).update(
      { id: lead.id },
      { reportsToUserId: null },
    );
    assert.equal((await fetch(url)).status, 404);
  });

  test("confines live frames to the requested company and Run and validates the request", async () => {
    const { owner, company, run, appSession } = await fixture({ live: true });
    const otherCompany = await insert(Company, {
      name: "Another company",
      slug: `other-${randomUUID()}`,
      ownerId: owner.id,
    });
    await insert(Membership, { companyId: otherCompany.id, userId: owner.id, role: "owner" });
    const otherRun = await insert(Run, { ...run, id: undefined });
    const crossCompanySession = await insert(BrowserSession, {
      ...appSession,
      id: undefined,
      companyId: otherCompany.id,
      mcpToken: crypto.randomBytes(32).toString("hex"),
    });
    await beginBrowserRecording(crossCompanySession);
    acceptBrowserRecordingFrame(
      crossCompanySession.id,
      Buffer.from("cross-company-frame").toString("base64"),
    );
    actingUserId = owner.id;
    for (const [companyId, runId, sessionId] of [
      [otherCompany.id, run.id, appSession.id],
      [company.id, otherRun.id, appSession.id],
      [company.id, run.id, crossCompanySession.id],
      [company.id, run.id, randomUUID()],
    ]) {
      const response = await fetch(
        `${runPath(companyId, runId)}/browser-recordings/${sessionId}/live`,
      );
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Not found" });
    }
    const url = `${runPath(company.id, run.id)}/browser-recordings/${appSession.id}/live`;
    assert.equal((await fetch(`${url}?disposition=attachment`)).status, 400);
    assert.equal(
      (await fetch(`${runPath(company.id, run.id)}/browser-recordings/not-a-uuid/live`)).status,
      400,
    );
    assert.equal(
      (await fetch(`${runPath(company.id, "not-a-uuid")}/browser-recordings/${appSession.id}/live`))
        .status,
      400,
    );
  });

  test("stops live frames when sessions close, Runs finish, or recordings finalize and delete", async () => {
    const { owner, company, run, appSession } = await fixture({ live: true });
    actingUserId = owner.id;
    const url = `${runPath(company.id, run.id)}/browser-recordings/${appSession.id}/live`;
    assert.equal((await fetch(url)).status, 200);
    await AppDataSource.getRepository(BrowserSession).update(
      { id: appSession.id },
      { status: "closed", closedAt: new Date() },
    );
    assert.equal((await fetch(url)).status, 404);
    await AppDataSource.getRepository(BrowserSession).update(
      { id: appSession.id },
      { status: "live", closedAt: null },
    );
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "completed" });
    assert.equal((await fetch(url)).status, 404);
    await AppDataSource.getRepository(Run).update({ id: run.id }, { status: "running" });
    assert.equal((await fetch(url)).status, 200);
    freezeBrowserRecording(appSession.id);
    assert.equal((await fetch(url)).status, 404);
    await finishBrowserRecording(appSession);
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url.replace(/\/live$/, ""))).status, 200);
    await deleteBrowserRecordingsForRunIds([run.id]);
    assert.equal((await fetch(url)).status, 404);
  });

  test("rejects live playback without a browser session or with an owner's API key", async () => {
    const { owner, company, run, appSession } = await fixture({ live: true });
    const url = `${runPath(company.id, run.id)}/browser-recordings/${appSession.id}/live`;
    assert.equal((await fetch(url)).status, 401);
    const tokenBody = crypto.randomBytes(32).toString("base64url");
    await insert(ApiKey, {
      companyId: company.id,
      userId: owner.id,
      name: "Recording key",
      prefix: tokenBody.slice(0, 8),
      tokenHash: hashApiToken(tokenBody),
    });
    const headers = { authorization: `Bearer gen_${tokenBody}` };
    assert.equal((await fetch(url, { headers })).status, 403);
  });

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
