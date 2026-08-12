import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  Employee,
  OnboardingIntegrationConnection,
  OnboardingRoutineRecommendation,
} from "../../client/lib/api.js";
import {
  defaultOnboardingRoutineIds,
  healthyGrantedConnection,
  healthyUngrantedConnection,
  MAX_ONBOARDING_ROUTINE_SELECTION,
  refreshedContextDraft,
  selectOnboardingEmployee,
} from "../../client/lib/onboardingRecommendations.js";

function routine(
  id: string,
  status: OnboardingRoutineRecommendation["status"],
): OnboardingRoutineRecommendation {
  return {
    id,
    name: id,
    summary: "Summary",
    cronExpr: "0 9 * * 1",
    body: "Brief",
    reasons: [],
    status,
    routineId: status === "ready" ? `routine-${id}` : null,
  };
}

function connection(
  id: string,
  status: OnboardingIntegrationConnection["status"],
  granted: boolean,
): OnboardingIntegrationConnection {
  return { id, label: id, status, granted };
}

describe("onboarding recommendation helpers", () => {
  test("preselects only suggested Routines, in service order, up to the API limit", () => {
    const routines = [
      routine("ready", "ready"),
      ...Array.from({ length: 7 }, (_, index) => routine(`suggested-${index + 1}`, "suggested")),
    ];

    assert.deepEqual(defaultOnboardingRoutineIds(routines), [
      "suggested-1",
      "suggested-2",
      "suggested-3",
      "suggested-4",
      "suggested-5",
    ]);
    assert.equal(defaultOnboardingRoutineIds(routines).length, MAX_ONBOARDING_ROUTINE_SELECTION);
  });

  test("selects a healthy granted Connection for the ready label", () => {
    const connections = [
      connection("expired-grant", "expired", true),
      connection("healthy-grant", "connected", true),
    ];

    assert.equal(healthyGrantedConnection(connections)?.id, "healthy-grant");
  });

  test("selects a healthy ungranted Connection for the Grant action", () => {
    const connections = [
      connection("errored", "error", false),
      connection("already-granted", "connected", true),
      connection("grant-me", "connected", false),
    ];

    assert.equal(healthyUngrantedConnection(connections)?.id, "grant-me");
  });

  test("does not offer an unhealthy Connection for a Grant", () => {
    const connections = [
      connection("expired", "expired", false),
      connection("errored", "error", false),
    ];

    assert.equal(healthyUngrantedConnection(connections), undefined);
  });

  test("never falls back to another AI Employee for an explicit stale resume id", () => {
    const employees = [
      { id: "first", name: "First", role: "Researcher" },
      { id: "second", name: "Second", role: "Engineer" },
    ] as Employee[];

    assert.equal(selectOnboardingEmployee(employees, "second")?.id, "second");
    assert.equal(selectOnboardingEmployee(employees, "deleted"), null);
    assert.equal(selectOnboardingEmployee(employees, null)?.id, "first");
  });

  test("preserves a dirty company-context draft across unrelated refreshes", () => {
    assert.equal(
      refreshedContextDraft({
        serverValue: "Stored mission",
        currentDraft: "Unsaved mission",
        dirty: true,
        reset: false,
      }),
      "Unsaved mission",
    );
    assert.equal(
      refreshedContextDraft({
        serverValue: "Saved mission",
        currentDraft: "Old draft",
        dirty: true,
        reset: true,
      }),
      "Saved mission",
    );
  });
});
