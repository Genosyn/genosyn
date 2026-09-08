import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Pipeline } from "../../db/entities/Pipeline.js";
import { closeTestDb, initTestDb, insert, testCompanyId } from "../../test/dbHarness.js";
import { SchedulerLeaseLostError } from "../schedulerLeases.js";
import { runPipeline } from "./executor.js";
import { HANDLERS } from "./handlers.js";

before(initTestDb);
after(closeTestDb);

test("a cancelled parent worker cannot start the next Pipeline node", async () => {
  const pipeline = await insert(Pipeline, {
    companyId: testCompanyId(),
    name: "Cancellation boundary",
    slug: "cancellation-boundary",
    graphJson: JSON.stringify({
      nodes: [
        { id: "start", type: "trigger.manual" },
        { id: "first", type: "logic.set" },
        { id: "second", type: "logic.set" },
      ],
      edges: [
        { fromNodeId: "start", toNodeId: "first" },
        { fromNodeId: "first", toNodeId: "second" },
      ],
    }),
  });
  const called: string[] = [];
  let held = true;
  const original = HANDLERS["logic.set"];
  HANDLERS["logic.set"] = async ({ node }) => {
    called.push(node.id);
    held = false;
    return { outputs: { completed: true } };
  };
  try {
    const run = await runPipeline({
      pipeline,
      triggerKind: "manual",
      triggerNodeId: "start",
      payload: {},
      beforeEffect: () => {
        if (!held) throw new SchedulerLeaseLostError("mail-automation");
      },
    });
    assert.deepEqual(called, ["first"]);
    assert.equal(run.status, "failed");
    assert.match(run.errorMessage ?? "", /no longer held/);
    assert.match(run.outputJson, /completed/);
  } finally {
    HANDLERS["logic.set"] = original;
  }
});
