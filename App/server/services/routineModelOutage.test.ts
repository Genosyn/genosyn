import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { config } from "../../config.js";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Company } from "../db/entities/Company.js";
import { Routine } from "../db/entities/Routine.js";
import { Run } from "../db/entities/Run.js";
import { encryptSecret } from "../lib/secret.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { agentRuntime } from "./agent/runtime.js";
import {
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  isModelAvailable,
  resetModelAvailabilityForTests,
} from "./modelAvailability.js";
import { modelEndpointAnswers } from "./modelAvailabilityProbe.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { startRoutineRun } from "./runner.js";
import { resumeRoutineQueue, waitForRoutineQueueIdle } from "./routineQueue.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";
import { stopStanddowns } from "./standdowns.js";

/** A model server that answers its model list while up and fails it while restarting. */
let serving = false;
let modelListRequests = 0;
let server: Server;
let baseURL = "";
const privateHosts = [...config.security.outboundPrivateHostAllowlist];

before(async () => {
  await initTestDb();
  server = createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      modelListRequests++;
      if (!serving) {
        res.writeHead(502, { "Content-Type": "text/plain" }).end("Bad Gateway");
        return;
      }
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(
          JSON.stringify({ object: "list", data: [{ id: "Qwen/Qwen3.8-27B", object: "model" }] }),
        );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, "127.0.0.1");
});
beforeEach(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelRunSlotsForTests();
  resetModelAvailabilityForTests();
  // One Run at a time starts the moment the model is back, for these tests.
  overrideRuntimeSettingsForTests({ modelAvailability: { resumeIntervalSeconds: 0 } });
  serving = false;
  modelListRequests = 0;
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
  resetModelAvailabilityForTests();
  overrideRuntimeSettingsForTests(null);
  config.security.outboundPrivateHostAllowlist.splice(0, Infinity, ...privateHosts);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
});

async function jamieOnLocalModel() {
  const company = await insert(Company, { name: "Local", slug: "local", ownerId: "owner" });
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name: "Jamie",
    slug: "jamie",
    role: "Sales",
  });
  const model = await insertEmployeeModel({
    employeeId: employee.id,
    provider: "custom",
    model: "Qwen/Qwen3.8-27B",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    maxConcurrentRuns: 2,
    configJson: JSON.stringify({
      baseURLEncrypted: encryptSecret(baseURL),
      modelId: "Qwen/Qwen3.8-27B",
    }),
  });
  const routine = (name: string) =>
    insert(Routine, {
      employeeId: employee.id,
      name,
      slug: name.toLowerCase().replaceAll(" ", "-"),
      cronExpr: "0 9 * * 1",
      timeoutSec: 600,
      body: `${name}: review the week.`,
    });
  return { routine, model };
}

function routineName(params: Parameters<typeof agentRuntime.run>[0]): string {
  const first = params.messages[0]?.content[0];
  return /^## Routine: (.+)$/m.exec(first && "text" in first ? first.text : "")?.[1] ?? "?";
}

/** What OpenCode throws once its retries are spent on a server that keeps failing. */
function gatewayError(): Error {
  return Object.assign(new Error("The AI Model request failed (HTTP 502)."), {
    status: 502,
    statusCode: 502,
  });
}

// 2026-10-02: the vLLM server behind Jamie's model restarted for six minutes.
// A continuation failed mid-step, then the queue started the next Run, which
// failed a minute later once the runtime's retries ran out. Now neither fails:
// the first pauses as itself, the second waits, and both finish once the
// server is back.
test("a model server that stops answering pauses the Run that met it and holds the queue until it is back", async (t) => {
  const { routine, model } = await jamieOnLocalModel();
  const partnerships = await routine("Weekly Partnership Follow-Up");
  const consolidation = await routine("Enterprise Tool Consolidation Prospecting");
  const started: string[] = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    started.push(routineName(params));
    if (!serving) throw gatewayError();
    return { finalText: "Reviewed the week.", steps: 3, stopReason: "end_turn" };
  });

  const first = await startRoutineRun(partnerships, { triggerKind: "manual" });
  // A paused Run is queued again, so its completion waits for the real end.
  const paused = await waitForPause(first.run.id);
  assert.equal(paused.status, "queued", "the Run pauses instead of failing");
  assert.equal(paused.pauseReason, "outage");
  assert.equal(paused.errorKind, null);
  assert.equal(isModelAvailable(model), false, "one exhausted turn marks the model unavailable");

  const held = await startRoutineRun(consolidation, { triggerKind: "manual" });
  await waitForRoutineQueueIdle();
  const waiting = await AppDataSource.getRepository(Run).findOneByOrFail({ id: held.run.id });
  assert.equal(waiting.status, "queued", "the next Run waits instead of failing against a down server");
  assert.match(waiting.logContent, /Waiting for the AI Model Qwen\/Qwen3\.8-27B: it is unavailable/);
  assert.deepEqual(started, ["Weekly Partnership Follow-Up"]);

  // The server comes back; a check finds it answering and the queue carries on.
  serving = true;
  await checkModelAvailabilityNow(model);
  await flushModelAvailabilityWrites();
  assert.ok(modelListRequests >= 1, "the check asked the server's model list");
  const [resumed, done] = await Promise.all([first.completion, held.completion]);
  assert.equal(done.status, "completed", done.logContent);
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.id, first.run.id, "the same Run carried on");
  assert.equal(resumed.pauseCount, 1);
  assert.deepEqual(
    started,
    [
      "Weekly Partnership Follow-Up",
      "Weekly Partnership Follow-Up",
      "Enterprise Tool Consolidation Prospecting",
    ],
    "the paused Run resumed before the Run that had only waited",
  );
});

/** The Run, once it has paused and gone back to the queue. */
async function waitForPause(runId: string): Promise<Run> {
  for (let i = 0; i < 600; i++) {
    await waitForRoutineQueueIdle();
    const run = await AppDataSource.getRepository(Run).findOneByOrFail({ id: runId });
    if (run.status === "queued" && run.pauseCount > 0) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run ${runId} never paused.`);
}

test("a rejected request fails as before, and holds nothing", async (t) => {
  const { routine, model } = await jamieOnLocalModel();
  const crm = await routine("Daily CRM Sync");
  const github = await routine("Daily GitHub Lead Capture");
  serving = true;
  const failures: Array<Error & { status: number }> = [
    Object.assign(new Error("This model's maximum context length is exceeded."), { status: 400 }),
  ];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    const failure = failures.shift();
    if (failure) throw failure;
    return { finalText: "Synced.", steps: 2, stopReason: "end_turn" };
  });

  const rejected = await (await startRoutineRun(crm, { triggerKind: "manual" })).completion;
  assert.equal(rejected.status, "error");
  assert.equal(rejected.errorKind, "runtime");
  assert.equal(rejected.pauseCount, 0);
  assert.equal(isModelAvailable(model), true, "a rejected request says nothing about the server");
  assert.equal(modelListRequests, 0);

  const next = await (await startRoutineRun(github, { triggerKind: "manual" })).completion;
  assert.equal(next.status, "completed", next.logContent);
});

test("only a server that cannot be reached or fails counts as down", async () => {
  const model = (url: string) =>
    ({
      authMode: "customEndpoint",
      provider: "custom",
      configJson: JSON.stringify({
        baseURLEncrypted: encryptSecret(url),
        modelId: "Qwen/Qwen3.8-27B",
      }),
    }) as AIModel;
  serving = false;
  assert.equal(await modelEndpointAnswers(model(baseURL)), false, "a 502 means down");
  serving = true;
  assert.equal(await modelEndpointAnswers(model(baseURL)), true);
  assert.equal(
    await modelEndpointAnswers(model("http://127.0.0.1:9/v1")),
    false,
    "a refused connection means down",
  );
  assert.equal(
    await modelEndpointAnswers({ authMode: "apikey", provider: "openai" } as AIModel),
    true,
    "a hosted model is never held by this check",
  );
});
