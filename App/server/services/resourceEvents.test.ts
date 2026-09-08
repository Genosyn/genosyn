import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, test } from "node:test";
import { AppDataSource } from "../db/datasource.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { Routine } from "../db/entities/Routine.js";
import { Workstream } from "../db/entities/Workstream.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  emitResourceChange,
  registerResourceChangeSink,
  registerRoutineTriggerSink,
} from "./resourceEvents.js";

type Frame = { companyId: string; kind: string; scopes: string[] };
let ui: Frame[];
let triggers: Frame[];
let companyId: string;
let employee: AIEmployee;
let business: Routine;
let review: Routine;
const subscriber = new ResourceChangeSubscriber();
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 250));
const workstreamFrames = (frames: Frame[]) => frames.filter((frame) => frame.kind === "workstream");
const stream = (routineId: string | null) =>
  insert(Workstream, {
    companyId,
    employeeId: employee.id,
    routineId,
    title: "Track work",
    stateDoc: "Progress.",
  });

before(initTestDb);
after(closeTestDb);
beforeEach(async () => {
  await resetTestDb();
  companyId = randomUUID();
  employee = await insert(AIEmployee, {
    companyId,
    name: "Maya",
    slug: randomUUID(),
    role: "Operations",
  });
  business = await insert(Routine, {
    employeeId: employee.id,
    name: "Business work",
    slug: randomUUID(),
    cronExpr: "0 9 * * 1",
  });
  review = await insert(Routine, {
    employeeId: employee.id,
    name: "Renamed review",
    slug: randomUUID(),
    cronExpr: "0 15 * * 5",
    selfReviewOnly: true,
  });
  ui = [];
  triggers = [];
  registerResourceChangeSink((id, kind, scopes) => ui.push({ companyId: id, kind, scopes }));
  registerRoutineTriggerSink((id, kind, scopes) => triggers.push({ companyId: id, kind, scopes }));
  AppDataSource.subscribers.push(subscriber);
});
afterEach(async () => {
  AppDataSource.subscribers.splice(AppDataSource.subscribers.indexOf(subscriber), 1);
  await drain();
  registerResourceChangeSink(() => {});
  registerRoutineTriggerSink(() => {});
});

test("review-only resource changes refresh the UI without dispatching Routine Triggers", async () => {
  emitResourceChange(companyId, "workstream", "review", { trigger: false });
  emitResourceChange(companyId, "workstream", "review", { trigger: false });
  await drain();
  assert.deepEqual(ui, [{ companyId, kind: "workstream", scopes: ["review"] }]);
  assert.deepEqual(triggers, []);
});

test("ordinary resource changes retain their coalesced UI and Trigger delivery", async () => {
  emitResourceChange(companyId, "workstream", "business");
  emitResourceChange(companyId, "workstream", "business");
  await drain();
  assert.deepEqual(ui, [{ companyId, kind: "workstream", scopes: ["business"] }]);
  assert.deepEqual(triggers, ui);
});

test("mixed batches deliver business scopes only to Triggers without suppressing either UI change", async () => {
  emitResourceChange(companyId, "workstream", "review-before", { trigger: false });
  emitResourceChange(companyId, "workstream", "business");
  emitResourceChange(companyId, "workstream", "review-after", { trigger: false });
  await drain();
  assert.deepEqual(ui, [
    { companyId, kind: "workstream", scopes: ["review-before", "business", "review-after"] },
  ]);
  assert.deepEqual(triggers, [{ companyId, kind: "workstream", scopes: ["business"] }]);
});

test("review suppression does not affect unrelated resource kinds, companies, or later batches", async () => {
  const otherCompanyId = randomUUID();
  emitResourceChange(companyId, "workstream", undefined, { trigger: false });
  emitResourceChange(companyId, "todo", "project");
  emitResourceChange(otherCompanyId, "workstream", "other-work");
  await drain();
  assert.equal(ui.length, 3);
  assert.deepEqual(triggers, [
    { companyId, kind: "todo", scopes: ["project"] },
    { companyId: otherCompanyId, kind: "workstream", scopes: ["other-work"] },
  ]);
  emitResourceChange(companyId, "workstream", "later-business");
  await drain();
  assert.deepEqual(triggers.at(-1), { companyId, kind: "workstream", scopes: ["later-business"] });
});

test("a broken UI sink never prevents business Trigger delivery", async () => {
  registerResourceChangeSink(() => {
    throw new Error("Disconnected viewer");
  });
  emitResourceChange(companyId, "workstream", "review", { trigger: false });
  emitResourceChange(companyId, "workstream", "business");
  await drain();
  assert.deepEqual(triggers, [{ companyId, kind: "workstream", scopes: ["business"] }]);
});

test("subscriber classifies direct review Workstream inserts, updates, and removals by the bound Routine", async () => {
  const work = await stream(review.id);
  await drain();
  assert.equal(workstreamFrames(ui).length, 1);
  assert.deepEqual(workstreamFrames(triggers), []);
  work.stateDoc = "A different review result.";
  await AppDataSource.getRepository(Workstream).save(work);
  await drain();
  assert.equal(workstreamFrames(ui).length, 2);
  assert.deepEqual(workstreamFrames(triggers), []);
  await AppDataSource.getRepository(Workstream).remove(work);
  await drain();
  assert.equal(workstreamFrames(ui).length, 3);
  assert.deepEqual(workstreamFrames(triggers), []);
});

test("subscriber still dispatches business and unbound Workstream changes", async () => {
  await stream(business.id);
  await stream(null);
  await drain();
  assert.equal(workstreamFrames(ui).length, 1);
  assert.deepEqual(workstreamFrames(triggers), workstreamFrames(ui));
});

test("subscriber preserves a business Trigger alongside a review change in one batch", async () => {
  await stream(review.id);
  await stream(business.id);
  await stream(review.id);
  await drain();
  assert.deepEqual(workstreamFrames(ui), [{ companyId, kind: "workstream", scopes: [] }]);
  assert.deepEqual(workstreamFrames(triggers), workstreamFrames(ui));
});

test("partial direct updates resolve a known Workstream identity before allowing Triggers", async () => {
  const work = await stream(review.id);
  await drain();
  ui.length = 0;
  triggers.length = 0;
  await AppDataSource.getRepository(Workstream).update(work.id, {
    id: work.id,
    companyId,
    stateDoc: "Progress through a partial update.",
  });
  await drain();
  assert.equal(workstreamFrames(ui).length, 1);
  assert.deepEqual(workstreamFrames(triggers), []);
});

test("ambiguous partial updates refresh the company but conservatively omit Triggers", async () => {
  const work = await stream(business.id);
  await drain();
  ui.length = 0;
  triggers.length = 0;
  await AppDataSource.getRepository(Workstream).update(work.id, {
    companyId,
    stateDoc: "The event does not include identity or binding.",
  });
  await drain();
  assert.equal(workstreamFrames(ui).length, 1);
  assert.deepEqual(workstreamFrames(triggers), []);
});

test("missing or failed Routine lookups retain UI refresh without starting work", async (t) => {
  await stream(randomUUID());
  await drain();
  assert.equal(workstreamFrames(ui).length, 1);
  assert.deepEqual(workstreamFrames(triggers), []);
  t.mock.method(AppDataSource.getRepository("Routine"), "findOne", async () => {
    throw new Error("Database temporarily unavailable");
  });
  await stream(review.id);
  await drain();
  assert.equal(workstreamFrames(ui).length, 2);
  assert.deepEqual(workstreamFrames(triggers), []);
});
