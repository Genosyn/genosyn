import assert from "node:assert/strict";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import vm from "node:vm";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { MemberBrowser } from "../db/entities/MemberBrowser.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { AppDataSource } from "../db/datasource.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  BROWSER_RECORDING_FPS,
  BROWSER_RECORDING_MAX_BITRATE_BITS_PER_SECOND,
  BROWSER_RECORDING_MAX_FILE_BYTES,
  BROWSER_RECORDING_MAX_HEIGHT,
  BROWSER_RECORDING_MAX_RUN_SECONDS,
  BROWSER_RECORDING_MAX_WIDTH,
  acceptBrowserRecordingFrame,
  beginBrowserRecording,
  browserRecordingDemand,
  browserRecordingProcessStateForTests,
  deleteBrowserRecordingsForCompany,
  deleteBrowserRecordingsForRunIds,
  finishBrowserRecording,
  freezeBrowserRecording,
  listBrowserRecordingsForRun,
  markBrowserRecordingRoutineDeleting,
  recoverBrowserRecordingsForRun,
  resetBrowserRecordingsForTests,
  restrictBrowserRecording,
  setBrowserRecordingEncoderFactoryForTests,
  setBrowserRecordingFfmpegExecutableForTests,
  setBrowserRecordingPartialValidatorForTests,
  type BrowserRecordingEncoderFactory,
} from "./browserRecordings.js";
import {
  beginBrowserRpcActivity,
  browserRpcActivityStateForTests,
  closeBrowserSession,
  createBrowserSession,
  finalizeBrowserRecordingsForRun,
  flushBrowserRecordingFrameScans,
  invalidateBrowserRecordingFramesForNavigationForTests,
  markSessionLive,
  observeRuntimePasswordValues,
  queueBrowserRecordingFrameForTests,
  registerBrowserSensitiveValueListener,
  resetBrowserRpcActivityForTests,
  passwordTaintScriptForTests,
  setPasswordObservationRuntimeForTests,
  setBeforeMarkLiveCasForTests,
  setBeforeBrowserSessionSaveForTests,
} from "./browserSessions.js";
import { browserRecordingFile, browserRecordingRunDir } from "./paths.js";
import { updateMemberBrowser } from "./memberBrowsers.js";
import { reconcileOrphanedRuns } from "./runRecovery.js";
import { startRoutineRun } from "./runner.js";

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let tempDir = "";

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-browser-recordings-"));
  mutableConfig.dataDir = tempDir;
});

beforeEach(async () => {
  await resetBrowserRecordingsForTests();
  resetBrowserRpcActivityForTests();
  setPasswordObservationRuntimeForTests(null);
  setBeforeMarkLiveCasForTests(null);
  setBeforeBrowserSessionSaveForTests(null);
  await resetTestDb();
  await fs.rm(path.join(tempDir, ".private"), { recursive: true, force: true });
});

after(async () => {
  await resetBrowserRecordingsForTests();
  mutableConfig.dataDir = originalDataDir;
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function fixture(): Promise<{
  company: Company;
  routine: Routine;
  run: Run;
  session: BrowserSession;
}> {
  const company = await insert(Company, {
    name: "Recording Co",
    slug: `recording-${Date.now()}`,
    ownerId: "owner",
  });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Browser Employee",
    slug: `browser-${Date.now()}`,
    role: "Researcher",
  });
  const routine = await insert(Routine, {
    employeeId: employee.id,
    name: "Browser Routine",
    slug: `routine-${Date.now()}`,
    cronExpr: "0 * * * *",
  });
  const run = await insert(Run, {
    routineId: routine.id,
    startedAt: new Date("2026-08-20T10:00:00.000Z"),
    finishedAt: null,
    status: "running",
    exitCode: null,
    logContent: "",
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
    mcpToken: `token-${Date.now()}-${Math.random()}`,
    mcpTokenExpiresAt: new Date(Date.now() + 60_000),
    status: "live",
    closeReason: null,
    pageUrl: "https://example.com",
    pageTitle: "Example",
    viewportWidth: 1280,
    viewportHeight: 800,
    startedAt: new Date("2026-08-20T10:00:01.000Z"),
    closedAt: null,
  });
  return { company, routine, run, session };
}

function fileEncoderFactory(
  calls: Array<{ fps: number; partPath: string; width: number; height: number }>,
): BrowserRecordingEncoderFactory {
  return async ({ partPath, framesPerSecond, width, height }) => {
    calls.push({ fps: framesPerSecond, partPath, width, height });
    return {
      writeFrame(frame) {
        fsSync.appendFileSync(partPath, frame);
        return true;
      },
      async finish() {
        return { ok: true };
      },
      async abort() {
        // The service owns deletion of partial bytes.
      },
    };
  };
}

async function writeRecordingMetadata(
  session: BrowserSession,
  finalPath: string,
  status: "recording" | "finalizing" | "ready" | "failed",
): Promise<void> {
  await fs.writeFile(
    path.join(path.dirname(finalPath), `${session.id}.json`),
    `${JSON.stringify({
      id: session.id,
      status,
      startedAt: session.startedAt?.toISOString() ?? null,
      finishedAt: null,
      mimeType: "video/mp4",
      sizeBytes: 0,
      filename: `${session.id}.mp4`,
    })}\n`,
    { mode: 0o600 },
  );
}

type TestPasswordObservation = {
  passwordPresent: boolean;
  passwordValues: string[];
  activeInputValue: string | null;
};

function installPasswordRuntime(
  observe: () => TestPasswordObservation | Promise<TestPasswordObservation>,
  options: {
    documentRoot?: unknown;
    failDomEnableOnce?: boolean;
    failInstallEvaluateOnce?: boolean;
    searchResultCount?: number;
  } = {},
): {
  domEnableCalls: () => number;
  installEvaluationCalls: () => number;
  reportPassword: () => Promise<void>;
} {
  let consoleListener: ((message: unknown) => void) | null = null;
  let taintSignal = "";
  let domEnableCalls = 0;
  let installEvaluationCalls = 0;
  let searchCounter = 0;
  const cdp = {
    on() {
      // Unit fixtures are stable; browser-level tests cover real DOM events.
    },
    async send(method: string) {
      if (method === "DOM.enable") {
        domEnableCalls += 1;
        if (options.failDomEnableOnce && domEnableCalls === 1) {
          throw new Error("temporary DOM enable failure");
        }
        return {};
      }
      if (method === "DOM.getDocument") {
        return {
          root: options.documentRoot ?? { nodeName: "#document", children: [] },
        };
      }
      if (method === "DOM.performSearch") {
        return {
          searchId: `search-${(searchCounter += 1)}`,
          resultCount: options.searchResultCount ?? 0,
        };
      }
      return {};
    },
  };
  const frame = {
    async evaluate(fn: unknown, arg?: unknown) {
      if (typeof fn === "string") {
        const signal = fn.match(/"signal":"([^"]+)"/)?.[1];
        const challenge = fn.match(/"challenge":"([^"]+)"/)?.[1];
        if (signal) taintSignal = signal;
        if (signal && challenge) {
          installEvaluationCalls += 1;
          if (options.failInstallEvaluateOnce && installEvaluationCalls === 1) {
            throw new Error("execution context was destroyed by navigation");
          }
          consoleListener?.({
            text: () => `${signal}:probe:${challenge}`,
            type: () => "debug",
          });
        }
        return false;
      }
      if (typeof arg === "string") return observe();
      if (
        arg &&
        typeof arg === "object" &&
        "challenge" in arg &&
        typeof arg.challenge === "string" &&
        "signal" in arg &&
        typeof arg.signal === "string"
      ) {
        taintSignal = arg.signal;
        consoleListener?.({
          text: () => `${arg.signal}:probe:${arg.challenge}`,
          type: () => "debug",
        });
        return false;
      }
      return false;
    },
  };
  const page = {
    url: () => "about:blank",
    on(event: string, callback: (message: unknown) => void) {
      if (event === "console") consoleListener = callback;
    },
    async addInitScript() {
      // The real browser runs this before document scripts. Frame evaluation
      // below models installing it into the already-loaded document.
    },
    frames: () => [frame],
  };
  setPasswordObservationRuntimeForTests(() => ({ cdp, page }));
  return {
    domEnableCalls: () => domEnableCalls,
    installEvaluationCalls: () => installEvaluationCalls,
    async reportPassword() {
      assert.ok(consoleListener, "sticky password console listener was installed");
      assert.ok(taintSignal, "sticky password signal was installed");
      consoleListener({ text: () => taintSignal, type: () => "debug" });
    },
  };
}

function installCleanPasswordRuntime(): {
  reportPassword: () => Promise<void>;
} {
  return installPasswordRuntime(() => ({
    passwordPresent: false,
    passwordValues: [],
    activeInputValue: null,
  }));
}

describe("Routine browser recordings", () => {
  test("reports a transient password through the captured native console", async () => {
    const observers: Array<(records: Array<Record<string, unknown>>) => void> = [];
    const consoleMessages: string[] = [];
    class FakeNode {}
    class FakeElement extends FakeNode {
      shadowRoot: FakeShadowRoot | null = null;
      querySelectorAll(): FakeElement[] {
        return [];
      }
      attachShadow(): FakeShadowRoot {
        const root = new FakeShadowRoot();
        this.shadowRoot = root;
        return root;
      }
    }
    class FakeInput extends FakeElement {
      type = "password";
    }
    class FakeDocument extends FakeNode {
      querySelectorAll(): FakeElement[] {
        return [];
      }
    }
    class FakeShadowRoot extends FakeNode {
      querySelectorAll(): FakeElement[] {
        return [];
      }
    }
    class FakeMutationObserver {
      constructor(callback: (records: Array<Record<string, unknown>>) => void) {
        observers.push(callback);
      }
      observe(): void {}
    }
    const realm = {
      Node: FakeNode,
      Element: FakeElement,
      HTMLInputElement: FakeInput,
      Document: FakeDocument,
      ShadowRoot: FakeShadowRoot,
      MutationObserver: FakeMutationObserver,
      console: {
        debug(value: string) {
          consoleMessages.push(value);
        },
      },
      document: new FakeDocument(),
      setTimeout,
    } as Record<string, unknown>;
    const source = passwordTaintScriptForTests({
      key: "taint",
      probeKey: "probe",
      signal: "tainted",
      challenge: "challenge",
    });

    assert.equal(vm.runInNewContext(source, realm), false);
    assert.deepEqual(consoleMessages, ["tainted:probe:challenge"]);

    let fakeReports = 0;
    realm.console = {
      debug() {
        fakeReports += 1;
      },
    };
    const password = new FakeInput();
    for (const observer of observers) {
      observer([{ type: "childList", addedNodes: [password] }]);
    }

    assert.deepEqual(consoleMessages, ["tainted:probe:challenge", "tainted"]);
    assert.equal(fakeReports, 0);
    assert.equal((realm.taint as () => boolean)(), true);
    assert.equal(Object.getOwnPropertyDescriptor(realm, "probe")?.configurable, false);
  });

  test("rejects a hostile late observer that tries to steal the probe secret", () => {
    const consoleMessages: string[] = [];
    const realm = {
      console: {
        debug(value: string) {
          consoleMessages.push(value);
        },
      },
    };
    // Create the attack as classic non-strict page code. It replaces
    // globalThis and walks Function.caller to try to read the installer's
    // randomized signal from its argument object.
    vm.runInNewContext(
      `
        const realGlobal = globalThis;
        const fake = { eval: realGlobal.eval };
        fake.taint = function () { return false; };
        fake.probe = function (challenge) {
          try {
            const installerArgs = fake.probe.caller.arguments[0];
            realGlobal.console.debug(installerArgs.signal + ":probe:" + challenge);
          } catch (error) {
            realGlobal.console.debug("blocked:" + error.name);
          }
        };
        Object.defineProperty(realGlobal, "globalThis", {
          value: fake,
          writable: true,
          configurable: true,
        });
      `,
      realm,
    );

    const result = vm.runInNewContext(
      passwordTaintScriptForTests({
        key: "taint",
        probeKey: "probe",
        requireExisting: true,
        signal: "SECRET",
        challenge: "CHAL",
      }),
      realm,
    );

    assert.equal(result, false);
    assert.deepEqual(consoleMessages, ["blocked:TypeError"]);
    assert.equal(consoleMessages.includes("SECRET:probe:CHAL"), false);
  });

  test("withholds a password rendered inside declarative closed shadow DOM", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    installPasswordRuntime(
      () => ({ passwordPresent: false, passwordValues: [], activeInputValue: null }),
      {
        documentRoot: {
          nodeId: 1,
          nodeName: "#document",
          children: [
            {
              nodeId: 2,
              nodeName: "DIV",
              shadowRoots: [
                {
                  nodeId: 3,
                  nodeName: "#document-fragment",
                  shadowRootType: "closed",
                  children: [
                    {
                      nodeId: 4,
                      nodeName: "INPUT",
                      attributes: ["type", "password"],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    );

    await observeRuntimePasswordValues(session.id, { failClosedIfUnavailable: true });
    await finishBrowserRecording(session);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "restricted");
    await assert.rejects(fs.stat(browserRecordingFile(company.id, run.id, session.id)), /ENOENT/);
  });

  test("ignores an inert password input stored in template content", async () => {
    const { session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    installPasswordRuntime(
      () => ({ passwordPresent: false, passwordValues: [], activeInputValue: null }),
      {
        documentRoot: {
          nodeId: 1,
          nodeName: "#document",
          children: [
            {
              nodeId: 2,
              nodeName: "TEMPLATE",
              templateContent: {
                nodeId: 3,
                nodeName: "#document-fragment",
                children: [
                  {
                    nodeId: 4,
                    nodeName: "INPUT",
                    attributes: ["type", "password"],
                  },
                ],
              },
            },
          ],
        },
      },
    );

    assert.equal(
      await observeRuntimePasswordValues(session.id, { failClosedIfUnavailable: true }),
      true,
    );
    assert.equal(browserRecordingDemand(session.id), true);
    await finishBrowserRecording(session);
  });

  test("re-enables the DOM guard after a transient protocol failure", async () => {
    const { session } = await fixture();
    const runtime = installPasswordRuntime(
      () => ({ passwordPresent: false, passwordValues: [], activeInputValue: null }),
      { failDomEnableOnce: true },
    );

    assert.equal(
      await observeRuntimePasswordValues(session.id, { discardIfUnavailable: true }),
      false,
    );
    assert.equal(
      await observeRuntimePasswordValues(session.id, { discardIfUnavailable: true }),
      true,
    );
    assert.equal(runtime.domEnableCalls(), 2);
  });

  test("retries the observer handshake when a popup navigates during adoption", async () => {
    const { session } = await fixture();
    const runtime = installPasswordRuntime(
      () => ({ passwordPresent: false, passwordValues: [], activeInputValue: null }),
      { failInstallEvaluateOnce: true },
    );

    assert.equal(
      await observeRuntimePasswordValues(session.id, { failClosedIfUnavailable: true }),
      true,
    );
    assert.equal(runtime.installEvaluationCalls(), 2);
  });

  test("budgets enough bytes for a maximum-length Routine recording", () => {
    const maximumVideoPayloadBytes =
      (BROWSER_RECORDING_MAX_BITRATE_BITS_PER_SECOND * BROWSER_RECORDING_MAX_RUN_SECONDS) / 8;

    // The extra 900 MiB is intentionally much larger than fragmented MP4's mux
    // overhead, so the byte guard cannot truncate a valid six-hour capture.
    assert.ok(BROWSER_RECORDING_MAX_FILE_BYTES - maximumVideoPayloadBytes > 900 * 1024 ** 2);
  });

  test("does not publish a clean encoder exit that happens before finalization", async () => {
    const { company, run, session } = await fixture();
    const fakeFfmpeg = path.join(tempDir, "ffmpeg-early-exit");
    await fs.writeFile(
      fakeFfmpeg,
      [
        "#!/bin/sh",
        "for output_path do :; done",
        "dd bs=1 count=1 >/dev/null 2>&1",
        'printf "truncated-mp4" > "$output_path"',
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );
    setBrowserRecordingFfmpegExecutableForTests(fakeFfmpeg);

    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("jpeg-frame").toString("base64"));
    let exitedEarly = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const partial = await fs
        .readFile(`${browserRecordingFile(company.id, run.id, session.id)}.part`, "utf8")
        .catch(() => "");
      if (partial === "truncated-mp4") {
        exitedEarly = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(exitedEarly, true);
    // Let the child `close` event settle before asking the encoder to finish.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const finished = await finishBrowserRecording(session);

    assert.equal(finished.recording?.status, "failed");
    assert.match(finished.warning ?? "", /before browser recording finalization/);
    await assert.rejects(fs.stat(browserRecordingFile(company.id, run.id, session.id)), /ENOENT/);
  });

  test("captures at the fixed cadence and atomically publishes a private MP4", async () => {
    const { company, run, session } = await fixture();
    session.viewportWidth = 3840;
    session.viewportHeight = 2160;
    await AppDataSource.getRepository(BrowserSession).save(session);
    const calls: Array<{ fps: number; partPath: string; width: number; height: number }> = [];
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory(calls));

    const started = await beginBrowserRecording(session);
    assert.equal(started?.status, "recording");
    assert.equal(browserRecordingDemand(session.id), true);
    acceptBrowserRecordingFrame(session.id, Buffer.from("jpeg-frame").toString("base64"));
    const finished = await finishBrowserRecording(session);

    assert.equal(BROWSER_RECORDING_FPS, 4);
    assert.equal(calls[0]?.fps, BROWSER_RECORDING_FPS);
    assert.equal(calls[0]?.width, BROWSER_RECORDING_MAX_WIDTH);
    assert.equal(calls[0]?.height, BROWSER_RECORDING_MAX_HEIGHT);
    assert.equal(finished.recording?.status, "ready");
    assert.equal(finished.warning, null);
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    assert.equal((await fs.stat(finalPath)).mode & 0o777, 0o600);
    await assert.rejects(fs.stat(`${finalPath}.part`), /ENOENT/);
    assert.equal((await fs.stat(path.dirname(finalPath))).mode & 0o777, 0o700);
    assert.deepEqual(
      (await listBrowserRecordingsForRun(run.id)).map(({ id, status, mimeType }) => ({
        id,
        status,
        mimeType,
      })),
      [{ id: session.id, status: "ready", mimeType: "video/mp4" }],
    );
  });

  test("withholds the entire recording and deletes final and partial bytes", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("sensitive-frame").toString("base64"));

    await restrictBrowserRecording(session.id);
    const finished = await finishBrowserRecording(session);

    assert.equal(finished.recording?.status, "restricted");
    assert.equal(browserRecordingDemand(session.id), false);
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await assert.rejects(fs.stat(finalPath), /ENOENT/);
    await assert.rejects(fs.stat(`${finalPath}.part`), /ENOENT/);
  });

  test("ignores frames that arrive after the terminal scan freeze", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("before-freeze").toString("base64"));
    freezeBrowserRecording(session.id);
    acceptBrowserRecordingFrame(session.id, Buffer.from("late-sensitive-frame").toString("base64"));

    const finished = await finishBrowserRecording(session);

    assert.equal(finished.recording?.status, "ready");
    assert.equal(
      await fs.readFile(browserRecordingFile(company.id, run.id, session.id), "utf8"),
      "before-freeze",
    );
  });

  test("blocks a future begin after freeze and clears the tombstone at finish", async () => {
    const { session } = await fixture();
    freezeBrowserRecording(session.id);

    assert.equal(await beginBrowserRecording(session), null);
    assert.deepEqual(browserRecordingProcessStateForTests(), { frozen: 1, active: 0 });

    await finishBrowserRecording(session);
    assert.deepEqual(browserRecordingProcessStateForTests(), { frozen: 0, active: 0 });
  });

  test("persists an encoder failure instead of respawning it on every action", async () => {
    const { run, session } = await fixture();
    let starts = 0;
    setBrowserRecordingEncoderFactoryForTests(async () => {
      starts += 1;
      throw new Error("ffmpeg missing");
    });

    assert.equal((await beginBrowserRecording(session))?.status, "failed");
    assert.equal((await beginBrowserRecording(session))?.status, "failed");
    assert.equal(starts, 1);
    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "failed");
  });

  test("promotes a fragmented partial during orphaned Run recovery", async () => {
    const { company, run, session } = await fixture();
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${finalPath}.part`, "valid-fragmented-mp4", { mode: 0o600 });
    await writeRecordingMetadata(session, finalPath, "finalizing");
    setBrowserRecordingPartialValidatorForTests(async (candidate) =>
      (await fs.readFile(candidate, "utf8")).startsWith("valid-"),
    );

    await recoverBrowserRecordingsForRun(run.id);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "ready");
    assert.equal(await fs.readFile(finalPath, "utf8"), "valid-fragmented-mp4");
    await assert.rejects(fs.stat(`${finalPath}.part`), /ENOENT/);
  });

  test("removes a torn partial that has no recoverable video packet", async () => {
    const { company, run, session } = await fixture();
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${finalPath}.part`, "torn", { mode: 0o600 });
    setBrowserRecordingPartialValidatorForTests(async () => false);

    await recoverBrowserRecordingsForRun(run.id);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "failed");
    await assert.rejects(fs.stat(finalPath), /ENOENT/);
    await assert.rejects(fs.stat(`${finalPath}.part`), /ENOENT/);
  });

  test("never promotes an unverified partial from an abruptly stopped active recording", async () => {
    const { company, run, session } = await fixture();
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${finalPath}.part`, "otherwise-valid-video", { mode: 0o600 });
    await writeRecordingMetadata(session, finalPath, "recording");
    setBrowserRecordingPartialValidatorForTests(async () => true);

    await recoverBrowserRecordingsForRun(run.id);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "failed");
    await assert.rejects(fs.stat(finalPath), /ENOENT/);
    await assert.rejects(fs.stat(`${finalPath}.part`), /ENOENT/);
  });

  test("never publishes final bytes whose durable metadata is failed", async () => {
    const { company, run, session } = await fixture();
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(finalPath, "unattested-final", { mode: 0o600 });
    await writeRecordingMetadata(session, finalPath, "failed");

    await recoverBrowserRecordingsForRun(run.id);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "failed");
    await assert.rejects(fs.stat(finalPath), /ENOENT/);
  });

  test("never synthesizes ready metadata for an unattested final file", async () => {
    const { company, run, session } = await fixture();
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(finalPath, "metadata-less-final", { mode: 0o600 });

    await recoverBrowserRecordingsForRun(run.id);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "failed");
    await assert.rejects(fs.stat(finalPath), /ENOENT/);
  });

  test("never promotes a partial once fail-closed restriction has begun", async () => {
    const { company, run, session } = await fixture();
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${finalPath}.part`, "sensitive-fragment", { mode: 0o600 });
    await fs.writeFile(`${finalPath}.restricted`, "restricted\n", { mode: 0o600 });

    await recoverBrowserRecordingsForRun(run.id);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "restricted");
    await assert.rejects(fs.stat(finalPath), /ENOENT/);
    await assert.rejects(fs.stat(`${finalPath}.part`), /ENOENT/);
  });

  test("Run deletion closes and removes recording sessions and artifacts", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("frame").toString("base64"));

    await deleteBrowserRecordingsForRunIds([run.id]);

    assert.equal(await AppDataSource.getRepository(BrowserSession).countBy({ id: session.id }), 0);
    await assert.rejects(fs.stat(browserRecordingRunDir(company.id, run.id)), /ENOENT/);
  });

  test("does not retain a frozen tombstone when a Chat browser closes", async () => {
    const { session } = await fixture();
    const chatSession = await insert(BrowserSession, {
      ...session,
      id: undefined,
      runId: null,
      mcpToken: `chat-${Date.now()}-${Math.random()}`,
      status: "live",
    });

    await closeBrowserSession(chatSession.id, "manual");

    assert.deepEqual(browserRecordingProcessStateForTests(), { frozen: 0, active: 0 });
  });

  test("finalizes an active recorder when its browser closes before the Run", async () => {
    const { run, session } = await fixture();
    installCleanPasswordRuntime();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("frame").toString("base64"));

    await closeBrowserSession(session.id, "manual");

    assert.equal(browserRecordingDemand(session.id), false);
    assert.deepEqual(browserRecordingProcessStateForTests(), { frozen: 0, active: 0 });
    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "ready");
  });

  test("a delayed pending-to-live transition cannot reopen a closed session", async () => {
    const { session } = await fixture();
    await AppDataSource.getRepository(BrowserSession).update(
      { id: session.id },
      { status: "pending", startedAt: null },
    );
    let enteredCas!: () => void;
    let releaseCas!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredCas = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCas = resolve;
    });
    setBeforeMarkLiveCasForTests(async () => {
      enteredCas();
      await release;
    });

    const markingLive = markSessionLive(session.id);
    await entered;
    await closeBrowserSession(session.id, "manual");
    releaseCas();
    await markingLive;

    const stored = await AppDataSource.getRepository(BrowserSession).findOneByOrFail({
      id: session.id,
    });
    assert.equal(stored.status, "closed");
    assert.equal(browserRecordingDemand(session.id), false);
  });

  test("withdrawing unattended consent closes only Run recorders before returning", async () => {
    const { run, session } = await fixture();
    installCleanPasswordRuntime();
    const memberBrowser = await insert(MemberBrowser, {
      companyId: session.companyId,
      ownerUserId: "owner",
      name: "Routine laptop",
      status: "offline",
      allowUnattended: true,
      routineRecordingConsentAt: new Date(),
    });
    session.memberBrowserId = memberBrowser.id;
    await AppDataSource.getRepository(BrowserSession).save(session);
    const chatSession = await insert(BrowserSession, {
      ...session,
      id: undefined,
      runId: null,
      mcpToken: `chat-consent-${Date.now()}-${Math.random()}`,
    });
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("frame").toString("base64"));

    await updateMemberBrowser(memberBrowser.id, { allowUnattended: false });

    assert.equal(browserRecordingDemand(session.id), false);
    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "ready");
    assert.equal(
      (await AppDataSource.getRepository(BrowserSession).findOneByOrFail({ id: session.id }))
        .status,
      "closed",
    );
    assert.equal(
      (await AppDataSource.getRepository(BrowserSession).findOneByOrFail({ id: chatSession.id }))
        .status,
      "live",
    );
  });

  test("keeps encoder paths and stderr out of ordinary Run warning lines", async () => {
    const { run, session } = await fixture();
    installCleanPasswordRuntime();
    setBrowserRecordingEncoderFactoryForTests(async ({ partPath }) => ({
      writeFrame(frame) {
        fsSync.appendFileSync(partPath, frame);
        return true;
      },
      finish: async () => ({ ok: false, warning: `encoder failed at ${partPath}` }),
      abort: async () => undefined,
    }));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("frame").toString("base64"));

    const warnings = await finalizeBrowserRecordingsForRun(run.id);

    assert.deepEqual(warnings, []);
    assert.equal(warnings.join("\n").includes(tempDir), false);
  });

  test("withholds bytes and settles the encoder when the final page scan fails", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("unverified-frame").toString("base64"));
    setPasswordObservationRuntimeForTests(() => ({
      page: {
        frames: () => {
          throw new Error("target closed during final scan");
        },
      },
    }));
    const unregister = registerBrowserSensitiveValueListener(
      async (observedSessionId, _value, kind) => {
        if (kind === "password-present") await restrictBrowserRecording(observedSessionId);
      },
    );
    try {
      await finalizeBrowserRecordingsForRun(run.id);
    } finally {
      unregister();
      setPasswordObservationRuntimeForTests(null);
    }

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "restricted");
    assert.deepEqual(browserRecordingProcessStateForTests(), { frozen: 0, active: 0 });
    await assert.rejects(fs.stat(browserRecordingFile(company.id, run.id, session.id)), /ENOENT/);
  });

  test("scans each queued recorder frame and withholds transient password UI", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    installPasswordRuntime(() => ({
      passwordPresent: true,
      passwordValues: [],
      activeInputValue: null,
    }));

    queueBrowserRecordingFrameForTests(
      session.id,
      Buffer.from("password-page-frame").toString("base64"),
    );
    await flushBrowserRecordingFrameScans(session.id);
    setPasswordObservationRuntimeForTests(null);
    await finishBrowserRecording(session);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "restricted");
    await assert.rejects(fs.stat(browserRecordingFile(company.id, run.id, session.id)), /ENOENT/);
  });

  test("persists a sticky password taint before the old document is destroyed", async () => {
    const { company, run, session } = await fixture();
    const oldDocument = installCleanPasswordRuntime();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));

    // Install the init script and Node binding before recording begins. The
    // callback models the old document observing a transient password field.
    await observeRuntimePasswordValues(session.id, { failClosedIfUnavailable: true });
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("old-document-frame").toString("base64"));
    await oldDocument.reportPassword();

    // A later scan sees a different, clean document. The process-level taint
    // must still win and prevent publication of bytes from the old one.
    installCleanPasswordRuntime();
    await finalizeBrowserRecordingsForRun(run.id);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "restricted");
    await assert.rejects(fs.stat(browserRecordingFile(company.id, run.id, session.id)), /ENOENT/);
  });

  test("drops an old-document frame when navigation wins its privacy scan", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    let enteredScan!: () => void;
    let releaseScan!: () => void;
    const scanEntered = new Promise<void>((resolve) => {
      enteredScan = resolve;
    });
    const scanRelease = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    installPasswordRuntime(async () => {
      enteredScan();
      await scanRelease;
      throw new Error("execution context was destroyed by navigation");
    });

    queueBrowserRecordingFrameForTests(
      session.id,
      Buffer.from("old-document-frame").toString("base64"),
    );
    await scanEntered;
    invalidateBrowserRecordingFramesForNavigationForTests(session.id);
    releaseScan();
    await flushBrowserRecordingFrameScans(session.id);
    const finished = await finishBrowserRecording(session);

    assert.equal(finished.recording?.status, "failed");
    await assert.rejects(fs.stat(browserRecordingFile(company.id, run.id, session.id)), /ENOENT/);
  });

  test("drops a current-generation frame when navigation destroys its scan", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    installPasswordRuntime(async () => {
      throw new Error("current execution context cannot be inspected");
    });

    queueBrowserRecordingFrameForTests(
      session.id,
      Buffer.from("unsafe-current-frame").toString("base64"),
    );
    await flushBrowserRecordingFrameScans(session.id);
    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "recording");

    // The next stable frame is scanned and saved normally. The unverified JPEG
    // must not be present in the published bytes, and a terminal scan remains
    // mandatory before the recording becomes Ready.
    installCleanPasswordRuntime();
    queueBrowserRecordingFrameForTests(
      session.id,
      Buffer.from("verified-current-frame").toString("base64"),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flushBrowserRecordingFrameScans(session.id);
    await finalizeBrowserRecordingsForRun(run.id);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "ready");
    const contents = (
      await fs.readFile(browserRecordingFile(company.id, run.id, session.id))
    ).toString();
    assert.ok(contents.length >= "verified-current-frame".length);
    assert.equal(contents.replaceAll("verified-current-frame", ""), "");
    assert.equal(contents.includes("unsafe-current-frame"), false);
  });

  test("fails an active recording closed when direct browser teardown cannot scan", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("unverified-frame").toString("base64"));
    setPasswordObservationRuntimeForTests(() => null);

    await closeBrowserSession(session.id, "manual");

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "restricted");
    await assert.rejects(fs.stat(browserRecordingFile(company.id, run.id, session.id)), /ENOENT/);
  });

  test("orphan recovery drains authorized browser activity before terminalizing", async () => {
    const { run, session } = await fixture();
    installCleanPasswordRuntime();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(
      session.id,
      Buffer.from("last-authorized-frame").toString("base64"),
    );
    const releaseActivity = beginBrowserRpcActivity(session);
    assert.ok(releaseActivity);

    const recovering = reconcileOrphanedRuns({
      boot: true,
      now: new Date("2026-08-20T12:00:00.000Z"),
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (browserRpcActivityStateForTests(session.id).waiters > 0) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(browserRpcActivityStateForTests(session.id), { active: 1, waiters: 1 });
    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).status,
      "running",
    );

    releaseActivity();
    await recovering;

    assert.equal(
      (await AppDataSource.getRepository(Run).findOneByOrFail({ id: run.id })).status,
      "interrupted",
    );
    assert.equal(
      (await AppDataSource.getRepository(BrowserSession).findOneByOrFail({ id: session.id }))
        .status,
      "closed",
    );
    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "ready");
  });

  test("retries transitional recording recovery for an already-interrupted Run on boot", async () => {
    const { company, run, session } = await fixture();
    await AppDataSource.getRepository(Run).update(
      { id: run.id },
      { status: "interrupted", finishedAt: new Date() },
    );
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${finalPath}.part`, "valid-after-second-crash", { mode: 0o600 });
    await reconcileOrphanedRuns({ boot: true });
    await reconcileOrphanedRuns({ boot: true });

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "failed");
    await assert.rejects(fs.stat(finalPath), /ENOENT/);
    await assert.rejects(fs.stat(`${finalPath}.part`), /ENOENT/);
  });

  test("terminal listing converges stale transitional and missing ready artifacts", async () => {
    const { company, run, session } = await fixture();
    await AppDataSource.getRepository(Run).update(
      { id: run.id },
      { status: "failed", finishedAt: new Date() },
    );
    const finalPath = browserRecordingFile(company.id, run.id, session.id);
    await fs.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(`${finalPath}.part`, "valid-terminal-part", { mode: 0o600 });
    await writeRecordingMetadata(session, finalPath, "finalizing");
    setBrowserRecordingPartialValidatorForTests(async () => true);

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "ready");
    await fs.rm(finalPath, { force: true });
    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "failed");
  });

  test("terminal listing fails a leftover process-local encoder closed", async () => {
    const { company, run, session } = await fixture();
    setBrowserRecordingEncoderFactoryForTests(fileEncoderFactory([]));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("unattested-frame").toString("base64"));
    await AppDataSource.getRepository(Run).update(
      { id: run.id },
      { status: "failed", finishedAt: new Date() },
    );

    assert.equal((await listBrowserRecordingsForRun(run.id))[0]?.status, "restricted");
    assert.equal(browserRecordingDemand(session.id), false);
    await assert.rejects(fs.stat(browserRecordingFile(company.id, run.id, session.id)), /ENOENT/);
  });

  test("company deletion waits for an encoder still starting before removing its tree", async () => {
    const { company, session } = await fixture();
    let releaseFactory!: () => void;
    let enteredFactory!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFactory = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFactory = resolve;
    });
    let aborted = false;
    setBrowserRecordingEncoderFactoryForTests(async () => {
      enteredFactory();
      await release;
      return {
        writeFrame: () => true,
        finish: async () => ({ ok: true }),
        abort: async () => {
          aborted = true;
        },
      };
    });
    const beginning = beginBrowserRecording(session);
    await entered;
    const deleting = deleteBrowserRecordingsForCompany(company.id);
    releaseFactory();
    await Promise.all([beginning, deleting]);

    assert.equal(aborted, true);
    assert.equal(browserRecordingDemand(session.id), false);
    await assert.rejects(
      fs.stat(path.join(tempDir, ".private", "browser-recordings", company.id)),
      /ENOENT/,
    );
  });

  test("Run deletion waits for a concurrent finalizer and cannot recreate the tree", async () => {
    const { company, run, session } = await fixture();
    let enteredFinish!: () => void;
    let releaseFinish!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredFinish = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFinish = resolve;
    });
    setBrowserRecordingEncoderFactoryForTests(async ({ partPath }) => ({
      writeFrame(frame) {
        fsSync.appendFileSync(partPath, frame);
        return true;
      },
      async finish() {
        enteredFinish();
        await release;
        return { ok: true };
      },
      async abort() {
        releaseFinish();
      },
    }));
    await beginBrowserRecording(session);
    acceptBrowserRecordingFrame(session.id, Buffer.from("frame").toString("base64"));
    const finishing = finishBrowserRecording(session);
    await entered;
    const deleting = deleteBrowserRecordingsForRunIds([run.id]);
    releaseFinish();
    await Promise.all([finishing, deleting]);

    await assert.rejects(fs.stat(browserRecordingRunDir(company.id, run.id)), /ENOENT/);
  });

  test("deletion tombstones reject a late BrowserSession and recording begin", async () => {
    const { company, run, session } = await fixture();
    await deleteBrowserRecordingsForRunIds([run.id]);

    await assert.rejects(
      createBrowserSession({
        companyId: company.id,
        employeeId: session.employeeId,
        conversationId: null,
        runId: run.id,
      }),
      /resource that is being removed/,
    );
    assert.equal(await beginBrowserRecording(session), null);
    await assert.rejects(fs.stat(browserRecordingRunDir(company.id, run.id)), /ENOENT/);
  });

  test("a Routine deletion tombstone wins against a Run waiting to persist", async () => {
    const { routine } = await fixture();
    let enteredPersist!: () => void;
    let releasePersist!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredPersist = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const starting = startRoutineRun(routine, {
      beforeRunPersist: async () => {
        enteredPersist();
        await release;
      },
    });
    await entered;
    markBrowserRecordingRoutineDeleting(routine.id);
    releasePersist();

    await assert.rejects(starting, /Routine is being removed/);
    assert.equal(await AppDataSource.getRepository(Run).countBy({ routineId: routine.id }), 1);
  });

  test("Run finalization rejects a BrowserSession whose save was already in flight", async () => {
    const { run, session } = await fixture();
    let enteredSave!: () => void;
    let releaseSave!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredSave = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    setBeforeBrowserSessionSaveForTests(async () => {
      enteredSave();
      await release;
    });
    const creating = createBrowserSession({
      companyId: session.companyId,
      employeeId: session.employeeId,
      conversationId: null,
      runId: run.id,
    });
    await entered;
    const finalizing = finalizeBrowserRecordingsForRun(run.id);
    releaseSave();

    await assert.rejects(creating, /resource that is being removed/);
    await finalizing;
    const rows = await AppDataSource.getRepository(BrowserSession).findBy({ runId: run.id });
    assert.deepEqual(
      rows.map((row) => row.id),
      [session.id],
    );
    assert.equal(rows[0]?.status, "closed");
  });
});
