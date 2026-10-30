import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, mock, test } from "node:test";
import { IsNull } from "typeorm";
import { AppDataSource } from "../db/datasource.js";
import type { AIModel } from "../db/entities/AIModel.js";
import { AIModelOutage } from "../db/entities/AIModelOutage.js";
import { Company } from "../db/entities/Company.js";
import { Notification } from "../db/entities/Notification.js";
import { encryptSecret } from "../lib/secret.js";
import { addEmployee, addMember } from "../test/accessFixtures.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { insertEmployeeModel } from "../test/modelFixtures.js";
import { modelUnavailability, type ModelUnavailability } from "./agent/modelOutage.js";
import {
  CHECK_JITTER,
  checkModelAvailabilityNow,
  flushModelAvailabilityWrites,
  isModelAvailable,
  keyWorkGate,
  loadModelOutages,
  MAX_HONOURED_RETRY_AFTER_MS,
  modelAvailabilityKey,
  modelAvailabilityState,
  nextCheckDelayMs,
  noteKeyWorkStarted,
  onModelAvailabilityChange,
  recordModelFailure,
  recordModelSuccess,
  resetModelAvailabilityForTests,
  setAvailabilityRandomForTests,
  setModelCheckForTests,
  type ModelAvailabilityChange,
  type ModelCheckOutcome,
} from "./modelAvailability.js";
import { overrideRuntimeSettingsForTests } from "./runtimeSettings.js";

/**
 * Whether each AI Model is available: the breaker every AI Employee on a model
 * shares. The bar: a model is marked unavailable only on real evidence (a run
 * of outage failures, or one that is unavailable on its face), is asked again
 * cheaply on a jittered, doubling backoff — one check at a time — comes back on
 * the first answer, survives a restart, and pages owners and admins once per
 * confirmed outage and once on recovery, never once per Run.
 */

before(initTestDb);
beforeEach(async () => {
  resetModelAvailabilityForTests();
  overrideRuntimeSettingsForTests(null);
  await resetTestDb();
});
afterEach(() => {
  mock.timers.reset();
  resetModelAvailabilityForTests();
  overrideRuntimeSettingsForTests(null);
});
after(closeTestDb);

const overloaded = (): ModelUnavailability =>
  modelUnavailability("overloaded", { status: 529, code: "overloaded_error" });
const refused = (): ModelUnavailability =>
  modelUnavailability("unreachable", { code: "ECONNREFUSED", definite: true });

async function company(name = "Acme") {
  return insert(Company, {
    name,
    slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`,
    ownerId: "owner",
  });
}

async function claude(companyId: string): Promise<AIModel> {
  const employee = await addEmployee(companyId, "Ada");
  return insertEmployeeModel({
    employeeId: employee.id,
    companyId,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    authMode: "apikey",
    isActive: true,
    connectedAt: new Date(),
    configJson: "{}",
  });
}

async function ollama(companyId: string, name: string, baseURL = "http://127.0.0.1:11434/v1") {
  const employee = await addEmployee(companyId, name);
  return insertEmployeeModel({
    employeeId: employee.id,
    companyId,
    provider: "custom",
    model: "qwen3:32b",
    authMode: "customEndpoint",
    isActive: true,
    connectedAt: new Date(),
    configJson: JSON.stringify({ baseURLEncrypted: encryptSecret(baseURL), modelId: "qwen3:32b" }),
  });
}

function checkWith(outcome: ModelCheckOutcome | (() => ModelCheckOutcome)) {
  const calls: string[] = [];
  setModelCheckForTests(async (model) => {
    calls.push(model.id);
    return typeof outcome === "function" ? outcome() : outcome;
  });
  return calls;
}

async function openOutages(): Promise<AIModelOutage[]> {
  await flushModelAvailabilityWrites();
  return AppDataSource.getRepository(AIModelOutage).find({ where: { endedAt: IsNull() } });
}

describe("becoming unavailable", () => {
  test("a run of outage failures marks it; fewer do not, and an answer resets the run", async () => {
    const co = await company();
    const model = await claude(co.id);
    assert.equal(recordModelFailure(model, overloaded()), false);
    assert.equal(recordModelFailure(model, overloaded()), false);
    recordModelSuccess(model);
    assert.equal(recordModelFailure(model, overloaded()), false);
    assert.equal(recordModelFailure(model, overloaded()), false);
    assert.equal(isModelAvailable(model), true, "two in a row are not enough");
    assert.equal(recordModelFailure(model, overloaded()), true);
    assert.equal(isModelAvailable(model), false);
    const state = modelAvailabilityState(model);
    assert.equal(state.available, false);
    if (!state.available) {
      assert.equal(state.cause, "overloaded");
      assert.equal(state.checks, 0);
      assert.match(state.detail, /overloaded/);
    }
  });

  test("the threshold is the runtime setting", async () => {
    overrideRuntimeSettingsForTests({ modelAvailability: { failureThreshold: 1 } });
    const model = await claude((await company()).id);
    assert.equal(recordModelFailure(model, overloaded()), true);
  });

  test("one refused connection is enough, and so is a turn that spent its retries", async () => {
    const co = await company();
    const local = await ollama(co.id, "Bea");
    assert.equal(recordModelFailure(local, refused()), true);
    const hosted = await claude(co.id);
    assert.equal(recordModelFailure(hosted, overloaded(), { terminal: true }), true);
  });

  test("since is when the run of failures began, not the failure that tipped it", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-30T10:00:00Z") });
    const model = await claude((await company()).id);
    recordModelFailure(model, overloaded());
    mock.timers.tick(20_000);
    recordModelFailure(model, overloaded());
    mock.timers.tick(20_000);
    recordModelFailure(model, overloaded());
    const state = modelAvailabilityState(model);
    assert.equal(state.available ? null : state.since.toISOString(), "2026-10-30T10:00:00.000Z");
  });

  test("every AI Employee on the model shares it, and every row on one endpoint; other companies do not", async () => {
    const co = await company();
    const a = await ollama(co.id, "Cal");
    const b = await ollama(co.id, "Dee");
    const elsewhere = await ollama((await company("Other")).id, "Eve");
    assert.equal(modelAvailabilityKey(a), modelAvailabilityKey(b));
    assert.notEqual(modelAvailabilityKey(a), modelAvailabilityKey(elsewhere));
    recordModelFailure(a, refused());
    assert.equal(isModelAvailable(b), false, "the second model on the same server waits too");
    assert.equal(isModelAvailable(elsewhere), true, "another company's work is its own");
    const differentServer = await ollama(co.id, "Fay", "http://127.0.0.1:8000/v1");
    assert.equal(isModelAvailable(differentServer), true);
  });

  test("an outage is one row, saved with no secret in it", async () => {
    const co = await company();
    const model = await claude(co.id);
    recordModelFailure(model, refused());
    // A second failure while unavailable only refreshes the words.
    recordModelFailure(model, overloaded());
    const [row, ...more] = await openOutages();
    assert.equal(more.length, 0);
    assert.equal(row.companyId, co.id);
    assert.equal(row.modelId, model.id);
    assert.equal(row.key, modelAvailabilityKey(model));
    assert.equal(row.checks, 0);
    assert.equal(row.cause, "overloaded");
    assert.equal(row.notifiedAt, null);
  });
});

describe("checks", () => {
  test("the wait doubles from the first check up to the cap, jittered within bounds", () => {
    const settings = { firstCheckSeconds: 30, maxCheckIntervalMinutes: 10 };
    for (let checks = 0; checks < 12; checks++) {
      const base = Math.min(600_000, 30_000 * 2 ** checks);
      const low = nextCheckDelayMs(checks, settings, () => 0);
      const mid = nextCheckDelayMs(checks, settings, () => 0.5);
      const high = nextCheckDelayMs(checks, settings, () => 1);
      assert.equal(mid, base, `check ${checks + 1} waits ${base}ms at the middle`);
      assert.equal(low, Math.round(base * (1 - CHECK_JITTER)));
      assert.equal(high, Math.round(base * (1 + CHECK_JITTER)));
      for (let i = 0; i < 50; i++) {
        const delay = nextCheckDelayMs(checks, settings);
        assert.ok(delay >= low && delay <= high, `${delay} within [${low}, ${high}]`);
      }
    }
    assert.equal(nextCheckDelayMs(40, settings, () => 0.5), 600_000, "never past the cap");
  });

  test("a timer runs the first check on schedule, and a failed one doubles the next wait", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-30T10:00:00Z") });
    setAvailabilityRandomForTests(() => 0.5);
    const model = await claude((await company()).id);
    const calls = checkWith({ kind: "unavailable", unavailability: overloaded() });
    recordModelFailure(model, refused());
    await flushModelAvailabilityWrites();
    mock.timers.tick(29_000);
    await flushModelAvailabilityWrites();
    assert.equal(calls.length, 0, "not before the first check is due");
    mock.timers.tick(1_000);
    await flushModelAvailabilityWrites();
    assert.equal(calls.length, 1);
    const state = modelAvailabilityState(model);
    assert.equal(state.available, false);
    if (!state.available) {
      assert.equal(state.checks, 1);
      assert.equal(state.nextCheckAt.getTime() - Date.now(), 60_000, "the second waits twice as long");
    }
    mock.timers.tick(60_000);
    await flushModelAvailabilityWrites();
    assert.equal(calls.length, 2);
    const [row] = await openOutages();
    assert.equal(row.checks, 2);
  });

  test("a retry-after longer than the backoff is honoured, up to an hour", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-30T10:00:00Z") });
    setAvailabilityRandomForTests(() => 0.5);
    const model = await claude((await company()).id);
    recordModelFailure(
      model,
      modelUnavailability("rate_limited", { status: 429, retryAfterMs: 5 * 60_000 }),
      { terminal: true },
    );
    let state = modelAvailabilityState(model);
    assert.equal(state.available ? 0 : state.nextCheckAt.getTime() - Date.now(), 5 * 60_000);
    const other = await claude((await company("Busy")).id);
    recordModelFailure(
      other,
      modelUnavailability("rate_limited", { status: 429, retryAfterMs: 5 * 3_600_000 }),
      { terminal: true },
    );
    state = modelAvailabilityState(other);
    assert.equal(
      state.available ? 0 : state.nextCheckAt.getTime() - Date.now(),
      MAX_HONOURED_RETRY_AFTER_MS,
    );
  });

  test("one check at a time, however many ask", async () => {
    const model = await claude((await company()).id);
    recordModelFailure(model, refused());
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    setModelCheckForTests(async () => {
      calls += 1;
      await gate;
      return { kind: "unavailable", unavailability: overloaded() };
    });
    const first = checkModelAvailabilityNow(model);
    const second = checkModelAvailabilityNow(model);
    const third = checkModelAvailabilityNow(model);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    const during = modelAvailabilityState(model);
    assert.equal(during.available ? null : during.checking, true, "the card can say it is checking");
    release();
    await Promise.all([first, second, third]);
    assert.equal(calls, 1);
  });

  test("a check that finds it answering ends the outage, and the work hears it", async () => {
    const co = await company();
    const model = await claude(co.id);
    const changes: ModelAvailabilityChange[] = [];
    const stop = onModelAvailabilityChange((change) => changes.push(change));
    try {
      recordModelFailure(model, refused());
      checkWith({ kind: "available" });
      const state = await checkModelAvailabilityNow(model);
      assert.deepEqual(state, { available: true });
      assert.equal(isModelAvailable(model), true);
      assert.deepEqual(
        changes.map((change) => change.available),
        [false, true],
      );
      assert.equal(changes[1].modelId, model.id);
      const rows = await AppDataSource.getRepository(AIModelOutage).find();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].recoveredBy, "check");
      assert.ok(rows[0].endedAt);
    } finally {
      stop();
    }
  });

  test("a check that cannot ask keeps it unavailable without counting a check", async () => {
    const model = await claude((await company()).id);
    recordModelFailure(model, refused());
    checkWith({ kind: "unknown", reason: "a chat is using the sign-in" });
    const state = await checkModelAvailabilityNow(model);
    assert.equal(state.available, false);
    assert.equal(state.available ? -1 : state.checks, 0);
  });

  test("an available model has nothing to check", async () => {
    const model = await claude((await company()).id);
    const calls = checkWith({ kind: "available" });
    assert.deepEqual(await checkModelAvailabilityNow(model), { available: true });
    assert.equal(calls.length, 0);
  });

  test("a model removed while unavailable lets its work go, quietly", async () => {
    const co = await company();
    const model = await claude(co.id);
    recordModelFailure(model, refused());
    await flushModelAvailabilityWrites();
    await AppDataSource.getRepository(AIModelOutage).manager.query(
      'DELETE FROM "ai_models" WHERE "id" = ?',
      [model.id],
    );
    checkWith({ kind: "unavailable", unavailability: overloaded() });
    await checkModelAvailabilityNow(model);
    await flushModelAvailabilityWrites();
    const rows = await AppDataSource.getRepository(AIModelOutage).find();
    assert.equal(rows[0].recoveredBy, "removed");
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
  });
});

describe("telling owners and admins", () => {
  async function team() {
    const co = await company();
    const owner = await addMember(co.id, "owner");
    const admin = await addMember(co.id, "admin");
    const member = await addMember(co.id, "member");
    return { co, owner, admin, member };
  }

  test("once when a check confirms it, once when it is back — never per failure or check", async () => {
    const { co, owner, admin, member } = await team();
    const model = await claude(co.id);
    recordModelFailure(model, refused());
    recordModelFailure(model, overloaded());
    await flushModelAvailabilityWrites();
    const notifications = AppDataSource.getRepository(Notification);
    assert.equal(await notifications.count(), 0, "work failing alone pages nobody");

    checkWith({ kind: "unavailable", unavailability: overloaded() });
    await checkModelAvailabilityNow(model);
    await checkModelAvailabilityNow(model);
    await checkModelAvailabilityNow(model);
    await flushModelAvailabilityWrites();
    const down = await notifications.find({ where: { kind: "model_unavailable" } });
    assert.deepEqual(down.map((n) => n.userId).sort(), [owner.id, admin.id].sort());
    assert.ok(down.every((n) => n.link === `/c/${co.slug}/settings/ai-models`));
    assert.ok(down.every((n) => n.entityKind === "ai_model" && n.entityId === model.id));
    assert.ok(!down.some((n) => n.userId === member.id), "Members are not paged");

    checkWith({ kind: "available" });
    await checkModelAvailabilityNow(model);
    await flushModelAvailabilityWrites();
    const up = await notifications.find({ where: { kind: "model_available" } });
    assert.deepEqual(up.map((n) => n.userId).sort(), [owner.id, admin.id].sort());
    assert.equal(await notifications.count(), 4);
  });

  test("a blip that heals before its first check pages nobody at all", async () => {
    const { co } = await team();
    const model = await claude(co.id);
    recordModelFailure(model, refused());
    await flushModelAvailabilityWrites();
    recordModelSuccess(model);
    await flushModelAvailabilityWrites();
    assert.equal(isModelAvailable(model), true);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
    const [row] = await AppDataSource.getRepository(AIModelOutage).find();
    assert.equal(row.recoveredBy, "traffic");
  });
});

describe("pacing the work that waited", () => {
  test("once back, Runs start one at a time for a while", async () => {
    mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-30T10:00:00Z") });
    overrideRuntimeSettingsForTests({ modelAvailability: { resumeIntervalSeconds: 10 } });
    const model = await claude((await company()).id);
    const key = modelAvailabilityKey(model);
    assert.deepEqual(keyWorkGate(key), { gate: "open" }, "a model that never failed is open");
    recordModelFailure(model, refused());
    assert.equal(keyWorkGate(key).gate, "unavailable");
    checkWith({ kind: "available" });
    await checkModelAvailabilityNow(model);
    assert.deepEqual(keyWorkGate(key), { gate: "open" }, "the first Run starts at once");
    noteKeyWorkStarted(key);
    assert.deepEqual(keyWorkGate(key), { gate: "paced", at: Date.now() + 10_000 });
    mock.timers.tick(10_000);
    assert.deepEqual(keyWorkGate(key), { gate: "open" });
    noteKeyWorkStarted(key);
    mock.timers.tick(11 * 60_000);
    noteKeyWorkStarted(key);
    assert.deepEqual(keyWorkGate(key), { gate: "open" }, "the ramp ends");
  });

  test("0 starts them together", async () => {
    overrideRuntimeSettingsForTests({ modelAvailability: { resumeIntervalSeconds: 0 } });
    const model = await claude((await company()).id);
    const key = modelAvailabilityKey(model);
    recordModelFailure(model, refused());
    checkWith({ kind: "available" });
    await checkModelAvailabilityNow(model);
    noteKeyWorkStarted(key);
    assert.deepEqual(keyWorkGate(key), { gate: "open" });
  });
});

describe("restarts and replicas", () => {
  test("an outage survives a restart: the process that comes back keeps the work waiting", async () => {
    const co = await company();
    const model = await claude(co.id);
    recordModelFailure(model, refused());
    checkWith({ kind: "unavailable", unavailability: overloaded() });
    await checkModelAvailabilityNow(model);
    await flushModelAvailabilityWrites();
    const before = modelAvailabilityState(model);

    // The process stops; a new one starts with nothing in memory.
    resetModelAvailabilityForTests();
    assert.equal(isModelAvailable(model), true, "an empty process knows nothing yet");
    await loadModelOutages();
    const after = modelAvailabilityState(model);
    assert.equal(after.available, false);
    if (!before.available && !after.available) {
      assert.equal(after.since.getTime(), before.since.getTime());
      assert.equal(after.checks, 1);
      assert.equal(after.nextCheckAt.getTime(), before.nextCheckAt.getTime());
    }
    // It goes on to recover, and says so once — it was notified before.
    checkWith({ kind: "available" });
    await checkModelAvailabilityNow(model);
    await flushModelAvailabilityWrites();
    assert.equal(
      await AppDataSource.getRepository(Notification).count({ where: { kind: "model_available" } }),
      await AppDataSource.getRepository(Notification).count({ where: { kind: "model_unavailable" } }),
    );
  });

  test("a recovery another replica saw reaches this one, without a second notice", async () => {
    const co = await company();
    await addMember(co.id, "owner");
    const model = await claude(co.id);
    recordModelFailure(model, refused());
    const [row] = await openOutages();
    // Another replica's check closed it.
    await AppDataSource.getRepository(AIModelOutage).update(
      { id: row.id },
      { endedAt: new Date(), recoveredBy: "check" },
    );
    await loadModelOutages();
    assert.equal(isModelAvailable(model), true);
    assert.equal(await AppDataSource.getRepository(Notification).count(), 0);
  });

  test("an outage another replica opened is adopted here", async () => {
    const co = await company();
    const model = await claude(co.id);
    await insert(AIModelOutage, {
      key: modelAvailabilityKey(model),
      companyId: co.id,
      modelId: model.id,
      startedAt: new Date(Date.now() - 60_000),
      endedAt: null,
      recoveredBy: null,
      cause: "server_error",
      lastError: "The AI Model answered with a server error (HTTP 503).",
      lastStatus: 503,
      checks: 0,
      lastCheckedAt: null,
      nextCheckAt: new Date(Date.now() + 30_000),
      notifiedAt: null,
    });
    await loadModelOutages();
    assert.equal(isModelAvailable(model), false);
    // Its own failure then joins the same outage rather than opening another.
    recordModelFailure(model, refused());
    assert.equal((await openOutages()).length, 1);
  });
});
