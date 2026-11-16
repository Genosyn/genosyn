import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { OnboardingStatus } from "./api.js";
import {
  getStartedHiddenKey,
  getStartedSteps,
  nextGetStartedStep,
  showsGetStarted,
} from "./getStarted.js";

const BLANK: OnboardingStatus = {
  complete: false,
  employee: null,
  modelConnected: false,
  routineCount: 0,
  scheduledRoutineCount: 0,
  nextRunAt: null,
  skillCount: 0,
  mailGranted: false,
  mailAccessLevel: null,
  nextStep: "company",
};

const AVERY = { id: "emp-1", name: "Avery", slug: "avery", role: "Executive Assistant" };

function steps(status: Partial<OnboardingStatus>, memberCount = 1) {
  return getStartedSteps({
    companySlug: "acme",
    status: { ...BLANK, ...status },
    memberCount,
  });
}

describe("Get started", () => {
  test("starts a new company at its Goal, with nothing done", () => {
    const list = steps({});
    assert.deepEqual(
      list.map((step) => step.id),
      ["goal", "hire", "model", "routine", "team"],
    );
    assert.equal(
      list.some((step) => step.done),
      false,
    );
    assert.equal(nextGetStartedStep(list)?.id, "goal");
    assert.equal(list[0].href, "/c/acme/onboarding?step=company");
  });

  test("moves on to hiring once the Goal is written", () => {
    const list = steps({ nextStep: "employee" });
    assert.equal(list[0].done, true);
    assert.equal(nextGetStartedStep(list)?.id, "hire");
    assert.equal(list[1].href, "/c/acme/onboarding?step=employee");
  });

  test("names the hire, and sends the model step to their part of the guide", () => {
    const list = steps({ nextStep: "employee", employee: AVERY });
    const model = list.find((step) => step.id === "model")!;
    assert.equal(nextGetStartedStep(list)?.id, "model");
    assert.equal(model.title, "Connect Avery's AI Model");
    assert.equal(model.href, "/c/acme/onboarding?step=employee&employee=emp-1");
    assert.equal(
      list.find((step) => step.id === "hire")?.description,
      "Avery, Executive Assistant.",
    );
  });

  test("counts a Routine only once it is scheduled", () => {
    const unscheduled = steps({
      nextStep: "done",
      complete: true,
      employee: AVERY,
      modelConnected: true,
      routineCount: 2,
    });
    assert.equal(nextGetStartedStep(unscheduled)?.id, "routine");
    assert.equal(
      unscheduled.find((step) => step.id === "routine")?.href,
      "/c/acme/onboarding?step=recommendations&employee=emp-1",
    );

    const scheduled = steps({
      nextStep: "done",
      complete: true,
      employee: AVERY,
      modelConnected: true,
      routineCount: 2,
      scheduledRoutineCount: 1,
    });
    assert.equal(nextGetStartedStep(scheduled)?.id, "team");
  });

  test("is finished when the team has a second person", () => {
    const list = steps(
      {
        nextStep: "done",
        complete: true,
        employee: AVERY,
        modelConnected: true,
        scheduledRoutineCount: 3,
      },
      2,
    );
    assert.equal(nextGetStartedStep(list), null);
    assert.equal(list.find((step) => step.id === "team")?.description, "2 people work here.");
  });

  test("points the Routine step at the Routines page before anyone is hired", () => {
    assert.equal(steps({ nextStep: "employee" })[3].href, "/c/acme/routines");
  });

  test("remembers hiding per company", () => {
    assert.notEqual(getStartedHiddenKey("a"), getStartedHiddenKey("b"));
  });
});

describe("when Home shows the checklist", () => {
  const next = steps({})[0];

  test("while the company can't work yet", () => {
    assert.equal(showsGetStarted({ complete: false, next, hidden: false, started: false }), true);
  });

  test("not on a company that was set up before it appeared, so an upgrade adds no to-do list", () => {
    assert.equal(showsGetStarted({ complete: true, next, hidden: false, started: false }), false);
  });

  test("through the optional steps once it has appeared", () => {
    assert.equal(showsGetStarted({ complete: true, next, hidden: false, started: true }), true);
  });

  test("never once hidden or finished", () => {
    assert.equal(showsGetStarted({ complete: false, next, hidden: true, started: true }), false);
    assert.equal(
      showsGetStarted({ complete: true, next: null, hidden: false, started: true }),
      false,
    );
  });
});
