import assert from "node:assert/strict";
import { test } from "node:test";
import { hasCompanyDirection, resolveOnboardingStep } from "./onboardingFlow";

const complete = { mission: "Make knowledge accessible", vision: "Everyone can learn" };

test("company direction requires both nonblank fields", () => {
  assert.equal(hasCompanyDirection(complete), true);
  for (const company of [
    { mission: "", vision: "" },
    { ...complete, mission: " \n\t " },
    { ...complete, vision: " " },
  ])
    assert.equal(hasCompanyDirection(company), false);
});

test("every onboarding deep link requires company direction", () => {
  for (const raw of [
    null,
    "intro",
    "company",
    "employee",
    "recommendations",
    "email",
    "first_request",
    "done",
    "unknown",
  ]) {
    assert.equal(resolveOnboardingStep(raw, { ...complete, vision: " " }), "company", String(raw));
  }
});

test("a company with direction starts hiring without repeating setup", () => {
  assert.equal(resolveOnboardingStep(null, complete), "employee");
  assert.equal(resolveOnboardingStep("unknown", complete), "employee");
});

test("legacy intro links and the Company back button open editable direction", () => {
  assert.equal(resolveOnboardingStep("intro", complete), "company");
  assert.equal(resolveOnboardingStep("company", complete), "company");
});

test("valid employee and later-step bookmarks remain resumable", () => {
  for (const step of ["employee", "recommendations", "email", "first_request", "done"] as const) {
    assert.equal(resolveOnboardingStep(step, complete), step);
  }
});
