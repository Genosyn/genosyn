import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { AIEmployee } from "../../db/entities/AIEmployee.js";
import type { Company } from "../../db/entities/Company.js";
import { composeEmployeeSystemPrompt } from "./systemPrompt.js";

/**
 * The charter layer (M51): the company's mission/vision and the Goals block
 * are injected exactly when present, and leave no empty headers behind when
 * they are not — the prompt must not grow a "## Company" with nothing under
 * it for the many companies that skipped those onboarding fields.
 */

const employee = { name: "Ada", role: "Analyst", soulBody: "Be direct." } as AIEmployee;

function compose(args: {
  mission?: string;
  vision?: string;
  goalsContext?: string;
  policiesContext?: string;
}): string {
  return composeEmployeeSystemPrompt({
    co: { name: "Acme", mission: args.mission ?? "", vision: args.vision ?? "" } as Company,
    emp: employee,
    skills: [],
    memoryContext: "",
    goalsContext: args.goalsContext ?? "",
    policiesContext: args.policiesContext ?? "",
    repositoriesContext: "",
    financeContext: "",
    signingContext: "",
    revenueContext: "",
    marketingContext: "",
    opening: "You are Ada.",
    surface: "routine",
    parallelDelegationAvailable: false,
    codingToolsAvailable: false,
    isolatedCodingTools: false,
  });
}

describe("employee system prompt charter layer", () => {
  test("mission and vision ride in a Company section above the Soul", () => {
    const prompt = compose({ mission: "Automate the boring parts.", vision: "Every team ships." });
    assert.match(prompt, /## Company/);
    assert.match(prompt, /Mission: Automate the boring parts\./);
    assert.match(prompt, /Vision: Every team ships\./);
    assert.ok(prompt.indexOf("## Company") < prompt.indexOf("## Soul"));
  });

  test("blank mission and vision leave no Company header behind", () => {
    const prompt = compose({ mission: "   ", vision: "" });
    assert.doesNotMatch(prompt, /## Company/);
  });

  test("mission alone still earns the section, without an empty Vision line", () => {
    const prompt = compose({ mission: "Automate the boring parts." });
    assert.match(prompt, /Mission: Automate the boring parts\./);
    assert.doesNotMatch(prompt, /Vision:/);
  });

  test("the goals context block is included verbatim when present and absent when empty", () => {
    const withGoals = compose({ goalsContext: "\n## Goals\n- **Grow MRR** — 350 of 500 $" });
    assert.match(withGoals, /## Goals/);
    assert.match(withGoals, /Grow MRR/);
    assert.doesNotMatch(compose({}), /## Goals/);
  });

  test("company policies ride above the Soul — they frame it, not the reverse", () => {
    const prompt = compose({
      policiesContext: "\n## Company policies\n### No competitor mail\nNever email rivals.",
    });
    assert.match(prompt, /## Company policies/);
    assert.ok(prompt.indexOf("## Company policies") < prompt.indexOf("## Soul"));
    assert.doesNotMatch(compose({}), /## Company policies/);
  });
});
