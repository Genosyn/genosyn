import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIEmployee } from "../db/entities/AIEmployee.js";
import { AIModel } from "../db/entities/AIModel.js";
import { Routine } from "../db/entities/Routine.js";
import { AppDataSource } from "../db/datasource.js";
import { ResourceChangeSubscriber } from "../db/subscribers/resourceChangeSubscriber.js";
import { closeTestDb, initTestDb, insert, resetTestDb, testCompanyId } from "../test/dbHarness.js";
import { registerResourceChangeSink } from "./resourceEvents.js";
import { clearRoutinePins, resolveChatModel } from "./models.js";

before(async () => {
  await initTestDb();
  // The real subscriber, so the live-sync tests below prove what the production
  // write path does rather than what a stub does.
  AppDataSource.subscribers.push(new ResourceChangeSubscriber());
});
beforeEach(resetTestDb);
after(closeTestDb);

async function model(args: {
  employeeId: string;
  name: string;
  isActive: boolean;
  createdAt: Date;
}) {
  return insert(AIModel, {
    employeeId: args.employeeId,
    provider: "openai",
    model: args.name,
    authMode: "apikey",
    isActive: args.isActive,
    configJson: "{}",
    connectedAt: null,
    contextWindow: null,
    contextWindowSource: null,
    createdAt: args.createdAt,
  });
}

describe("chat model resolution", () => {
  test("defaults to active and honors an employee-owned explicit selection", async () => {
    const employeeId = "employee-model-picker";
    const active = await model({
      employeeId,
      name: "gpt-active",
      isActive: true,
      createdAt: new Date("2026-07-29T10:00:00.000Z"),
    });
    const selected = await model({
      employeeId,
      name: "gpt-selected",
      isActive: false,
      createdAt: new Date("2026-07-30T10:00:00.000Z"),
    });

    assert.equal((await resolveChatModel(employeeId))?.id, active.id);
    assert.equal((await resolveChatModel(employeeId, selected.id))?.id, selected.id);
  });

  test("rejects a model owned by another employee", async () => {
    const other = await model({
      employeeId: "employee-other",
      name: "gpt-other",
      isActive: true,
      createdAt: new Date("2026-07-30T10:00:00.000Z"),
    });

    assert.equal(await resolveChatModel("employee-model-picker", other.id), null);
  });
});

describe("live sync", () => {
  /**
   * A regression guard with a specific past in mind. Deleting a model cleared
   * its routine pins through `Repository.update()` by criteria, which
   * broadcasts only the partial it was handed — `{ modelId: null }`, with no
   * `employeeId` — so the subscriber could not hop to the company and no other
   * open Routines page ever refetched. The pins were gone; the app just didn't
   * say so, and a colleague went on being shown a pin to a deleted model.
   */
  test("clearing a model's pins announces a routine change to the company", async () => {
    const companyId = testCompanyId();
    const employee = await insert(AIEmployee, {
      companyId,
      name: "Operator",
      slug: `operator-${randomUUID()}`,
      role: "Operations",
    });
    const pinned = await model({
      employeeId: employee.id,
      name: "gpt-pinned",
      isActive: false,
      createdAt: new Date("2026-07-30T10:00:00.000Z"),
    });
    const routine = await insert(Routine, {
      employeeId: employee.id,
      name: "Nightly",
      slug: `nightly-${randomUUID()}`,
      cronExpr: "0 3 * * *",
      modelId: pinned.id,
    });
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((id, kind) => events.push({ companyId: id, kind }));

    await clearRoutinePins(pinned.id, companyId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(
      (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: routine.id })).modelId,
      null,
    );
    assert.ok(
      events.some((e) => e.companyId === companyId && e.kind === "routine"),
      `expected a routine change for ${companyId}, saw ${JSON.stringify(events)}`,
    );
  });

  test("a model nothing was pinned to announces nothing", async () => {
    // Every model disconnect would otherwise wake every open Routines page in
    // the company for a routine list that did not move.
    const companyId = testCompanyId();
    const events: Array<{ companyId: string; kind: string }> = [];
    registerResourceChangeSink((id, kind) => events.push({ companyId: id, kind }));

    await clearRoutinePins(randomUUID(), companyId);
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(
      events.filter((e) => e.companyId === companyId),
      [],
    );
  });
});
