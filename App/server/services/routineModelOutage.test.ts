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
import { agentRuntime } from "./agent/runtime.js";
import {
  forgetModelProbesForTests,
  modelEndpointAnswers,
  resetModelAvailabilityForTests,
} from "./modelAvailability.js";
import { resetModelRunSlotsForTests } from "./modelRunCapacity.js";
import { startRoutineRun } from "./runner.js";
import {
  dispatchQueuedRoutineRuns,
  resumeRoutineQueue,
  waitForRoutineQueueIdle,
} from "./routineQueue.js";
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
  serving = false;
  modelListRequests = 0;
  await resetTestDb();
  await resumeRoutineQueue();
});
after(async () => {
  await waitForRoutineQueueIdle();
  stopStanddowns();
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
  await insert(AIModel, {
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
  return { routine };
}

// 2026-10-02: the vLLM server behind Jamie's model restarted for six minutes.
// A continuation failed mid-step, then the queue started the next Run, which
// failed a minute later once the runtime's retries ran out.
test("a model server that stops answering holds queued Runs until it is back", async (t) => {
  const { routine } = await jamieOnLocalModel();
  const partnerships = await routine("Weekly Partnership Follow-Up");
  const consolidation = await routine("Enterprise Tool Consolidation Prospecting");
  const started: string[] = [];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    const first = params.messages[0]?.content[0];
    const name = /^## Routine: (.+)$/m.exec(first && "text" in first ? first.text : "")?.[1];
    started.push(name ?? "?");
    if (!serving)
      throw Object.assign(new Error("The AI Model request failed (HTTP 502)."), { status: 502 });
    return { finalText: "Reviewed the week.", steps: 3, stopReason: "end_turn" };
  });

  const failed = await (await startRoutineRun(partnerships, { triggerKind: "manual" })).completion;
  assert.equal(failed.status, "error");
  assert.equal(failed.errorKind, "runtime");

  const held = await startRoutineRun(consolidation, { triggerKind: "manual" });
  await waitForRoutineQueueIdle();
  const waiting = await AppDataSource.getRepository(Run).findOneByOrFail({ id: held.run.id });
  assert.equal(waiting.status, "queued", "the Run waits instead of failing against a down server");
  assert.match(waiting.logContent, /its server is not answering/);
  assert.deepEqual(started, ["Weekly Partnership Follow-Up"]);
  assert.ok(modelListRequests >= 1, "the queue asked the server before starting the Run");

  // The server comes back; the heartbeat dispatches the waiting Run again.
  serving = true;
  forgetModelProbesForTests();
  await dispatchQueuedRoutineRuns();
  const done = await held.completion;
  assert.equal(done.status, "completed", done.logContent);
  assert.deepEqual(started, [
    "Weekly Partnership Follow-Up",
    "Enterprise Tool Consolidation Prospecting",
  ]);
});

test("a rejected request asks nothing, and a server that answers is never held", async (t) => {
  const { routine } = await jamieOnLocalModel();
  const crm = await routine("Daily CRM Sync");
  const partners = await routine("Daily Partner Prospecting");
  const github = await routine("Daily GitHub Lead Capture");
  serving = true;
  const failures: Array<Error & { status: number }> = [
    Object.assign(new Error("This model's maximum context length is exceeded."), { status: 400 }),
    Object.assign(new Error("The AI Model request failed (HTTP 502)."), { status: 502 }),
  ];
  t.mock.method(agentRuntime, "run", async (params: Parameters<typeof agentRuntime.run>[0]) => {
    if (params.maxSteps !== null) return { finalText: "Noted.", steps: 1, stopReason: "end_turn" };
    const failure = failures.shift();
    if (failure) throw failure;
    return { finalText: "Synced.", steps: 2, stopReason: "end_turn" };
  });

  const rejected = await (await startRoutineRun(crm, { triggerKind: "manual" })).completion;
  assert.equal(rejected.status, "error");
  const unavailable = await (await startRoutineRun(partners, { triggerKind: "manual" })).completion;
  assert.equal(unavailable.status, "error");
  assert.equal(modelListRequests, 0, "a rejected request says nothing about the server");

  const next = await (await startRoutineRun(github, { triggerKind: "manual" })).completion;
  assert.equal(next.status, "completed", next.logContent);
  assert.equal(modelListRequests, 1, "one answer from the server cleared the 502");
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
    "a hosted model is never held",
  );
});
