import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIEmployee } from "../db/entities/AIEmployee.js";
import type { AIModel } from "../db/entities/AIModel.js";
import type { Routine } from "../db/entities/Routine.js";
import type { Run } from "../db/entities/Run.js";
import type { AgentTool } from "./agent/types.js";
import type { EmployeeAgentResult } from "./agent/runEmployee.js";
import { assessRunOutcome } from "./runVerdicts.js";

/**
 * The outcome check turns "the loop returned" into "the work met its bar", so
 * what matters here is that a wrong or missing answer degrades to `unclear`
 * rather than to a confident verdict — and that a verdict the checker did
 * submit is never thrown away.
 */

const employee = { id: "emp-1", name: "Rey", role: "Support" } as AIEmployee;
const model = { id: "model-1", contextWindow: 200_000 } as AIModel;
const routine = {
  id: "routine-1",
  name: "Nightly digest",
  acceptanceCriteria: "The digest was posted to #general.",
} as Routine;
const run = { id: "run-1", logContent: "[tool] post_message ok\nPosted the digest." } as Run;

/** Drive the restricted seam by handing the checker's own tool a payload. */
function stubRestricted(behaviour: (submit: AgentTool) => Promise<EmployeeAgentResult>) {
  return async (params: { tools: AgentTool[] }) => behaviour(params.tools[0]);
}

function assess(runRestricted: ReturnType<typeof stubRestricted>) {
  return assessRunOutcome({
    run,
    routine,
    employee,
    model,
    runRestricted: runRestricted as never,
  });
}

describe("run outcome check", () => {
  test("records the verdict the checker submitted, with its note", async () => {
    const assessment = await assess(
      stubRestricted(async (submit) => {
        await submit.run({ verdict: "achieved", note: "The transcript shows the digest posted." });
        return { status: "ok", finalText: "", steps: 2, stopReason: "end_turn" };
      }),
    );
    assert.equal(assessment.verdict, "achieved");
    assert.match(assessment.note, /digest posted/);
  });

  test("an off-goal verdict comes back as off_goal, not as a failure", async () => {
    const assessment = await assess(
      stubRestricted(async (submit) => {
        await submit.run({ verdict: "off_goal", note: "Nothing was posted to #general." });
        return { status: "ok", finalText: "", steps: 2, stopReason: "end_turn" };
      }),
    );
    assert.equal(assessment.verdict, "off_goal");
  });

  test("a checker that submits nothing reads as unclear, never as achieved", async () => {
    const assessment = await assess(
      stubRestricted(async () => ({ status: "ok", finalText: "Looks fine to me", steps: 1 })),
    );
    assert.equal(assessment.verdict, "unclear");
    assert.match(assessment.note, /without submitting/i);
  });

  test("a model outage reads as unclear and names the reason", async () => {
    const assessment = await assess(
      stubRestricted(async () => ({ status: "error", error: "provider unreachable" })),
    );
    assert.equal(assessment.verdict, "unclear");
    assert.match(assessment.note, /provider unreachable/);
  });

  test("a verdict already submitted survives a turn that then throws", async () => {
    const assessment = await assess(
      stubRestricted(async (submit) => {
        await submit.run({ verdict: "achieved", note: "Posted, with the run log to show it." });
        throw new Error("aborted after the submission");
      }),
    );
    assert.equal(assessment.verdict, "achieved");
  });

  test("a malformed submission is refused rather than recorded", async () => {
    const assessment = await assess(
      stubRestricted(async (submit) => {
        const rejected = await submit.run({ verdict: "great", note: "" });
        assert.equal(rejected.isError, true);
        return { status: "ok", finalText: "", steps: 1, stopReason: "end_turn" };
      }),
    );
    assert.equal(assessment.verdict, "unclear");
  });

  test("only the first verdict counts if the checker submits twice", async () => {
    const assessment = await assess(
      stubRestricted(async (submit) => {
        await submit.run({ verdict: "achieved", note: "First answer." });
        await submit.run({ verdict: "off_goal", note: "Second answer." });
        return { status: "ok", finalText: "", steps: 3, stopReason: "end_turn" };
      }),
    );
    assert.equal(assessment.verdict, "achieved");
    assert.match(assessment.note, /First answer/);
  });

  test("a linked Goal rides into the checker as context, framed as context not the bar", async () => {
    let seenSystem = "";
    await assessRunOutcome({
      run,
      routine,
      employee,
      model,
      goal: {
        title: "Reply within a day",
        direction: "decrease_to",
        targetValue: 24,
        currentValue: 31,
        unit: "hours",
      } as never,
      runRestricted: (async (params: { system: string; tools: AgentTool[] }) => {
        seenSystem = params.system;
        await params.tools[0].run({ verdict: "achieved", note: "Fine." });
        return { status: "ok", finalText: "", steps: 2, stopReason: "end_turn" };
      }) as never,
    });
    assert.match(seenSystem, /Reply within a day/);
    assert.match(seenSystem, /drive down to 24 hours/);
    assert.match(seenSystem, /currently 31 hours/);
    assert.match(seenSystem, /context, not the bar/);
  });

  test("no Goal means no objective section — the prompt stays exactly criteria-shaped", async () => {
    let seenSystem = "";
    await assessRunOutcome({
      run,
      routine,
      employee,
      model,
      runRestricted: (async (params: { system: string; tools: AgentTool[] }) => {
        seenSystem = params.system;
        await params.tools[0].run({ verdict: "achieved", note: "Fine." });
        return { status: "ok", finalText: "", steps: 2, stopReason: "end_turn" };
      }) as never,
    });
    assert.doesNotMatch(seenSystem, /objective this Routine serves/);
  });
});
