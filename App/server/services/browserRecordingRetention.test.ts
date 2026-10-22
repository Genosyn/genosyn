import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { pruneExpiredBrowserRecordings } from "./browserRecordingRetention.js";
import {
  getBrowserRecordingFile,
  listBrowserRecordingsForRun,
  recoverBrowserRecordingsForRun,
  resetBrowserRecordingsForTests,
} from "./browserRecordings.js";
import { browserRecordingFile } from "./paths.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let tempDir = "";

const NOW = new Date("2026-10-22T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-recording-retention-"));
  mutableConfig.dataDir = tempDir;
});

beforeEach(async () => {
  await resetBrowserRecordingsForTests();
  overrideRuntimeSettingsForTests(null);
  await resetTestDb();
  await fs.rm(path.join(tempDir, ".private"), { recursive: true, force: true });
});

after(async () => {
  await resetBrowserRecordingsForTests();
  overrideRuntimeSettingsForTests(null);
  mutableConfig.dataDir = originalDataDir;
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

let sequence = 0;

/** A finished Routine Run with one closed browser session. */
async function finishedRun(): Promise<{ run: Run; session: BrowserSession }> {
  sequence += 1;
  const company = await insert(Company, {
    name: `Retention Co ${sequence}`,
    slug: `retention-${sequence}`,
    ownerId: "owner",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Browser Employee",
    slug: `browser-${sequence}`,
    role: "Researcher",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Browser Routine",
    slug: `routine-${sequence}`,
    cronExpr: "0 * * * *",
  });
  const run = await insert(Run, {
    routineId: routine.id,
    startedAt: daysAgo(30),
    finishedAt: daysAgo(30),
    status: "completed",
    exitCode: 0,
    logContent: "done",
    dismissedAt: null,
    triggerKind: "schedule",
    attempt: 1,
    parentRunId: null,
    retryAt: null,
    missedSlots: 0,
  });
  const session = await insert(BrowserSession, {
    companyId: company.id,
    employeeId: employee.id,
    conversationId: null,
    runId: run.id,
    memberBrowserId: null,
    mcpToken: `token-${sequence}-${Math.random()}`,
    mcpTokenExpiresAt: daysAgo(30),
    status: "closed",
    closeReason: "shutdown",
    pageUrl: "https://example.com",
    pageTitle: "Example",
    viewportWidth: 1280,
    viewportHeight: 800,
    startedAt: daysAgo(30),
    closedAt: daysAgo(30),
  });
  return { run, session };
}

/** Write a recording's video and metadata the way the recorder leaves them. */
async function saveRecording(
  session: BrowserSession,
  status: "recording" | "ready" | "failed" | "expired",
  finishedAt: Date | null,
): Promise<string> {
  const videoPath = browserRecordingFile(session.companyId, session.runId!, session.id);
  const video = Buffer.from("not really an mp4");
  await fs.mkdir(path.dirname(videoPath), { recursive: true });
  await fs.writeFile(videoPath, video);
  await fs.writeFile(
    path.join(path.dirname(videoPath), `${session.id}.json`),
    `${JSON.stringify({
      id: session.id,
      status,
      startedAt: session.startedAt?.toISOString() ?? null,
      finishedAt: finishedAt?.toISOString() ?? null,
      mimeType: "video/mp4",
      sizeBytes: video.length,
      filename: `${session.id}.mp4`,
    })}\n`,
  );
  return videoPath;
}

async function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(
    () => true,
    () => false,
  );
}

async function statuses(runId: string): Promise<string[]> {
  return (await listBrowserRecordingsForRun(runId)).map((recording) => recording.status);
}

describe("browser recording retention", () => {
  test("a recording that finished before the window loses its video and reads as expired", async () => {
    const { run, session } = await finishedRun();
    const videoPath = await saveRecording(session, "ready", daysAgo(8));

    assert.equal(await pruneExpiredBrowserRecordings(NOW), 1);

    assert.equal(await exists(videoPath), false);
    // Listing twice: a missing video must not be "recovered" into a failure.
    assert.deepEqual(await statuses(run.id), ["expired"]);
    assert.deepEqual(await statuses(run.id), ["expired"]);
    assert.equal(await getBrowserRecordingFile(session), null);
    // The Run and its browser session are history, and stay.
    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.id, session.id);
  });

  test("a recording inside the window is kept", async () => {
    const { run, session } = await finishedRun();
    const videoPath = await saveRecording(session, "ready", daysAgo(6));

    assert.equal(await pruneExpiredBrowserRecordings(NOW), 0);

    assert.equal(await exists(videoPath), true);
    assert.deepEqual(await statuses(run.id), ["ready"]);
  });

  test("the window comes from Admin → Runtime, and 0 keeps recordings forever", async () => {
    const { run, session } = await finishedRun();
    const videoPath = await saveRecording(session, "ready", daysAgo(20));

    overrideRuntimeSettingsForTests({ browser: { recordingRetentionDays: 0 } });
    assert.equal(await pruneExpiredBrowserRecordings(NOW), 0);
    overrideRuntimeSettingsForTests({ browser: { recordingRetentionDays: 30 } });
    assert.equal(await pruneExpiredBrowserRecordings(NOW), 0);
    assert.equal(await exists(videoPath), true);

    overrideRuntimeSettingsForTests({ browser: { recordingRetentionDays: 14 } });
    assert.equal(await pruneExpiredBrowserRecordings(NOW), 1);
    assert.equal(await exists(videoPath), false);
    assert.deepEqual(await statuses(run.id), ["expired"]);
  });

  test("every company's recordings are covered", async () => {
    const first = await finishedRun();
    const second = await finishedRun();
    await saveRecording(first.session, "ready", daysAgo(9));
    await saveRecording(second.session, "ready", daysAgo(9));

    assert.equal(await pruneExpiredBrowserRecordings(NOW), 2);
  });

  test("a recording still being captured is never touched", async () => {
    const { session } = await finishedRun();
    const videoPath = await saveRecording(session, "recording", null);
    await fs.utimes(videoPath, daysAgo(40), daysAgo(40));

    assert.equal(await pruneExpiredBrowserRecordings(NOW), 0);
    assert.equal(await exists(videoPath), true);
  });

  test("video left beside a failed record goes once it is past the window", async () => {
    const { run, session } = await finishedRun();
    const videoPath = await saveRecording(session, "failed", daysAgo(10));

    assert.equal(await pruneExpiredBrowserRecordings(NOW), 1);

    assert.equal(await exists(videoPath), false);
    assert.deepEqual(await statuses(run.id), ["failed"]);
  });

  test("recovery finishes an interrupted expiry instead of republishing the video", async () => {
    const { run, session } = await finishedRun();
    // A crash between marking the recording expired and deleting its video.
    const videoPath = await saveRecording(session, "expired", daysAgo(10));

    await recoverBrowserRecordingsForRun(run.id);

    assert.equal(await exists(videoPath), false);
    assert.deepEqual(await statuses(run.id), ["expired"]);
  });
});
