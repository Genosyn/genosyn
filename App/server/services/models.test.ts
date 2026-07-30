import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { AIModel } from "../db/entities/AIModel.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import { resolveChatModel } from "./models.js";

before(initTestDb);
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
