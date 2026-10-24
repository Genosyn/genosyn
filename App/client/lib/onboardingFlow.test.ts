import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCompanyDirection, resolveOnboardingStep } from "./onboardingFlow";

const complete = { mission: "Make knowledge accessible", vision: "Everyone can learn" };
const withGoal = { mission: "", vision: "", hasGoal: true };

test("without a Goal, company direction requires both nonblank fields", () => {
  assert.equal(hasCompanyDirection(complete), true);
  for (const company of [
    { mission: "", vision: "" },
    { mission: "", vision: "", hasGoal: false },
    { ...complete, mission: " \n\t " },
    { ...complete, vision: " " },
    { ...complete, vision: " ", hasGoal: false },
  ])
    assert.equal(hasCompanyDirection(company), false);
});

test("a Goal is company direction by itself", () => {
  assert.equal(hasCompanyDirection(withGoal), true);
  assert.equal(hasCompanyDirection({ ...withGoal, mission: "Only a mission" }), true);
  assert.equal(hasCompanyDirection({ ...complete, hasGoal: true }), true);
});

test("every onboarding deep link requires company direction", () => {
  for (const raw of [
    null,
    "intro",
    "company",
    "employee",
    "recommendations",
    "email",
    "access",
    "first_request",
    "done",
    "unknown",
  ]) {
    assert.equal(resolveOnboardingStep(raw, { ...complete, vision: " " }), "company", String(raw));
    assert.equal(
      resolveOnboardingStep(raw, { mission: "", vision: "", hasGoal: false }),
      "company",
      String(raw),
    );
  }
});

test("a company with direction starts hiring without repeating setup", () => {
  assert.equal(resolveOnboardingStep(null, complete), "employee");
  assert.equal(resolveOnboardingStep("unknown", complete), "employee");
  assert.equal(resolveOnboardingStep(null, withGoal), "employee");
  assert.equal(resolveOnboardingStep("unknown", withGoal), "employee");
});

test("legacy intro links and the Company back button open editable direction", () => {
  assert.equal(resolveOnboardingStep("intro", complete), "company");
  assert.equal(resolveOnboardingStep("company", complete), "company");
  assert.equal(resolveOnboardingStep("intro", withGoal), "company");
  assert.equal(resolveOnboardingStep("company", withGoal), "company");
});

test("valid employee and later-step bookmarks remain resumable", () => {
  for (const step of [
    "employee",
    "recommendations",
    "email",
    "access",
    "first_request",
    "done",
  ] as const) {
    assert.equal(resolveOnboardingStep(step, complete), step);
    assert.equal(resolveOnboardingStep(step, withGoal), step);
  }
});

test("granting access is its own step, reachable by a bookmark once there is direction", () => {
  assert.equal(resolveOnboardingStep("access", complete), "access");
  assert.equal(resolveOnboardingStep("access", { mission: "", vision: "" }), "company");
});
