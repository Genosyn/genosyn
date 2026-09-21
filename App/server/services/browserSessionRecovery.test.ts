import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import express from "express";
import { chromium } from "playwright-core";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { Membership } from "../db/entities/Membership.js";
import { User } from "../db/entities/User.js";
import { browserRpcRouter } from "../routes/browserRpc.js";
import { errorHandler } from "../middleware/error.js";
import { loopbackOnly } from "../middleware/loopbackOnly.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { browserEnvFor, browserServerSpec, loadBrowserConfig } from "./agent/tools/mcpSources.js";
import { connectMcpServer, type BridgedServer } from "./agent/tools/mcpBridge.js";
import { injectChromiumLauncherForTests } from "./browserProfile.js";
import { closeBrowserSession, createBrowserSession } from "./browserSessions.js";
import { releaseAllPages, releasePage, setProfileLingerForTests } from "./browserChromium.js";
import {
  resetBrowserRecordingsForTests,
  setBrowserRecordingEncoderFactoryForTests,
} from "./browserRecordings.js";
import { issueMcpToken, revokeMcpToken } from "./mcpTokens.js";

const originalConfig = { port: config.port, dataDir: config.dataDir };
let server: Server;
let origin = "";
let tempDir = "";
let company: Company;
let employee: AIEmployee;
let routine: Routine;
let run: Run;
let session: BrowserSession;
let token = "";
let bridge: BridgedServer | null = null;
const destinationRequests: string[] = [];
let redirectedRequests = 0;
let recoveryRequests = 0;
let recoveryCredentialSeen = false;

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-browser-rpc-recovery-"));
  Object.assign(config, { dataDir: tempDir });
  const app = express();
  app.use(express.json());
  app.use("/api/internal/browser/sessions/:id", loopbackOnly, browserRpcRouter);
  app.post("/redirect-browser/sessions/:id/recover", (req, res) => {
    recoveryRequests++;
    recoveryCredentialSeen = req.header("x-genosyn-turn-token") === token;
    res.redirect(307, "/redirect-target");
  });
  app.post("/redirect-browser/sessions/:id/:action", (_req, res) => {
    res.status(410).json({ code: "browser_session_closed", recoverable: true });
  });
  app.all("/redirect-target", (_req, res) => {
    redirectedRequests++;
    res.status(500).end();
  });
  app.get("/destination", (req, res) => {
    destinationRequests.push(req.method);
    res
      .type("html")
      .send(
        "<html><title>Read-only destination</title><h1>Routine inspection succeeded</h1><p>No publishing actions exist on this fixture.</p></html>",
      );
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  Object.assign(config, { port });
  origin = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await bridge?.close();
  bridge = null;
  if (token) revokeMcpToken(token);
  await releaseAllPages();
  await resetBrowserRecordingsForTests();
  await resetTestDb();
  destinationRequests.length = 0;
  redirectedRequests = 0;
  recoveryRequests = 0;
  recoveryCredentialSeen = false;
  company = await insert(Company, {
    name: "Browser recovery",
    slug: "browser-recovery",
    ownerId: "owner",
  });
  employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Inspector",
    slug: "inspector",
    role: "Research",
    browserEnabled: true,
    browserAllowedHosts: "127.0.0.1",
  });
  routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Inspect destination",
    slug: "inspect",
    cronExpr: "0 * * * *",
  });
  run = await insert(Run, { routineId: routine.id, status: "running", startedAt: new Date() });
  session = await createBrowserSession({
    companyId: company.id,
    employeeId: employee.id,
    conversationId: null,
    runId: run.id,
  });
  token = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    runId: run.id,
    routineId: routine.id,
  });
});

after(async () => {
  await bridge?.close();
  if (token) revokeMcpToken(token);
  await releaseAllPages();
  await resetBrowserRecordingsForTests();
  injectChromiumLauncherForTests(null);
  setProfileLingerForTests(null);
  Object.assign(config, originalConfig);
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function recover(turnToken = token, sessionToken = session.mcpToken) {
  return fetch(`${origin}/api/internal/browser/sessions/${session.id}/recover`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "x-genosyn-turn-token": turnToken,
      "content-type": "application/json",
    },
    body: "{}",
  });
}

test("idle and browser_close teardown create fresh identities only with a matching live turn", async () => {
  for (const reason of ["idle", "shutdown"] as const) {
    await closeBrowserSession(session.id, reason);
    const response = await recover();
    assert.equal(response.status, 200);
    const renewed = (await response.json()) as { sessionId: string; sessionToken: string };
    assert.notEqual(renewed.sessionId, session.id);
    assert.notEqual(renewed.sessionToken, session.mcpToken);
    assert.equal(
      (await AppDataSource.getRepository(BrowserSession).findOneByOrFail({ id: session.id }))
        .status,
      "closed",
    );
    const fresh = await AppDataSource.getRepository(BrowserSession).findOneByOrFail({
      id: renewed.sessionId,
    });
    assert.equal(fresh.runId, run.id);
    assert.equal(fresh.memberBrowserId, null);
    session = fresh;
  }
});

test("closed sessions report their lifecycle instead of claiming their known credential is invalid", async () => {
  await closeBrowserSession(session.id, "idle");
  const response = await fetch(`${origin}/api/internal/browser/sessions/${session.id}/snapshot`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.mcpToken}` },
  });
  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error:
      "Browser session is closed. Use browser_open to start a fresh page when the session was closed by inactivity or browser_close.",
    code: "browser_session_closed",
    recoverable: true,
  });
});

test("manual close, expired browser bearer, revoked turn and mismatched Run stay denied", async () => {
  await closeBrowserSession(session.id, "manual");
  assert.equal((await recover()).status, 409);
  await AppDataSource.getRepository(BrowserSession).update(session.id, { closeReason: "idle" });
  assert.equal((await recover(token, "unknown")).status, 401);
  const other = issueMcpToken(employee.id, company.id, {
    authority: "employee",
    runId: "different-run",
    routineId: routine.id,
  });
  try {
    assert.equal((await recover(other)).status, 403);
  } finally {
    revokeMcpToken(other);
  }
  await AppDataSource.getRepository(BrowserSession).update(session.id, {
    mcpTokenExpiresAt: new Date(0),
  });
  assert.equal((await recover()).status, 401);
  await AppDataSource.getRepository(BrowserSession).update(session.id, {
    mcpTokenExpiresAt: new Date(Date.now() + 60_000),
  });
  revokeMcpToken(token);
  assert.equal((await recover()).status, 401);
});

test("recovery rechecks Browser access, Run status and current Member authority", async () => {
  await closeBrowserSession(session.id, "idle");
  await AppDataSource.getRepository(AIEmployee).update(employee.id, { browserEnabled: false });
  assert.equal((await recover()).status, 403);
  await AppDataSource.getRepository(AIEmployee).update(employee.id, { browserEnabled: true });
  await AppDataSource.getRepository(Run).update(run.id, { status: "completed" });
  assert.equal((await recover()).status, 403);
  await AppDataSource.getRepository(Run).update(run.id, { status: "running" });
  const user = await insert(User, {
    email: "owner@example.test",
    passwordHash: "hash",
    name: "Owner",
    sessionVersion: 0,
  });
  const membership = await insert(Membership, {
    companyId: company.id,
    userId: user.id,
    role: "admin",
  });
  const memberToken = issueMcpToken(employee.id, company.id, {
    authority: "member",
    requesterUserId: user.id,
    requesterSessionVersion: 0,
    runId: run.id,
    routineId: routine.id,
  });
  await AppDataSource.getRepository(Membership).update(membership.id, { role: "member" });
  try {
    assert.equal((await recover(memberToken)).status, 403);
  } finally {
    revokeMcpToken(memberToken);
  }
});

test("the browser child never follows recovery redirects or retries non-navigation actions", async () => {
  const browserConfig = await loadBrowserConfig(employee.id, {
    routineId: routine.id,
    runId: run.id,
  });
  const spec = browserServerSpec(browserConfig, token);
  assert.equal(spec.transport, "stdio");
  if (spec.transport !== "stdio") throw new Error("Expected the browser stdio child");
  spec.env = {
    ...spec.env,
    GENOSYN_BROWSER_API: `${origin}/redirect-browser/sessions/${session.id}`,
  };
  bridge = await connectMcpServer("browser", spec, "");
  const snapshot = bridge.tools.find((candidate) => candidate.name === "browser_snapshot");
  const open = bridge.tools.find((candidate) => candidate.name === "browser_open");
  assert.ok(snapshot);
  assert.ok(open);
  assert.equal((await snapshot.run({})).isError, true);
  assert.equal(recoveryRequests, 0, "A failed inspection must not create a replacement page");
  assert.equal((await open.run({ url: `${origin}/destination` })).isError, true);
  assert.equal(recoveryRequests, 1);
  assert.equal(recoveryCredentialSeen, true);
  assert.equal(redirectedRequests, 0, "Never forward the turn token through a redirect");
});

test("a Routine browser child can open and inspect a real page after browser_close and idle teardown", async (t) => {
  const executablePath = [
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find(existsSync);
  if (!executablePath) return t.skip("No Chrome executable available");
  injectChromiumLauncherForTests({
    launch: async () => chromium.launch({ executablePath, headless: true }),
  });
  // Exercise the normal idle linger: forcing it to zero adds an unrelated
  // Chrome shutdown/relaunch race to the session-token recovery check.
  setProfileLingerForTests(null);
  // Recording implementation has its own live tests; this fixture inspects
  // browser transport/session behavior without requiring an ffmpeg install.
  setBrowserRecordingEncoderFactoryForTests(async () => {
    throw new Error("Recording is outside this test");
  });
  const browserConfig = await loadBrowserConfig(employee.id, {
    routineId: routine.id,
    runId: run.id,
  });
  assert.equal(
    browserEnvFor(browserConfig, token).GENOSYN_BROWSER_SESSION_TOKEN,
    browserConfig.sessionToken,
  );
  bridge = await connectMcpServer("browser", browserServerSpec(browserConfig, token), "");
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = bridge!.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} is exposed by the real browser child`);
    const result = await tool.run(args);
    assert.equal(result.isError, false, result.content);
    assert.doesNotMatch(result.content, /Browser RPC 401|sessionToken|[a-f0-9]{64}/);
    return result.content;
  };
  assert.match(
    await call("browser_open", { url: `${origin}/destination` }),
    /Read-only destination|Routine inspection succeeded/,
  );
  await call("browser_close");
  assert.match(
    await call("browser_open", { url: `${origin}/destination` }),
    /Read-only destination|Routine inspection succeeded/,
  );
  assert.match(
    await call("browser_snapshot"),
    /Read-only destination|Routine inspection succeeded/,
  );
  const current = await AppDataSource.getRepository(BrowserSession).findOneByOrFail({
    runId: run.id,
    status: "live",
  });
  await releasePage(current.id, "idle");
  assert.match(
    await call("browser_open", { url: `${origin}/destination` }),
    /Read-only destination|Routine inspection succeeded/,
  );
  assert.match(
    await call("browser_snapshot"),
    /Read-only destination|Routine inspection succeeded/,
  );
  assert.equal(destinationRequests.length, 3);
  assert.ok(destinationRequests.every((method) => method === "GET"));
});
