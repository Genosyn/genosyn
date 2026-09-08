import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProactiveInstallation, ProactiveOverview } from "../../../shared/proactive.js";
import { PlanLimitError } from "../entitlements.js";
import type { workBlocked } from "../standdowns.js";
import { PROACTIVE_RECIPES } from "./catalogue.js";
import { planProactiveDefaults, reconcileProactiveDefaults } from "./defaults.js";
import { proactiveScope } from "./scopes.js";
import {
  ProactiveSetupError,
  type installProactiveStarter,
  type ProactiveSetupInput,
} from "./setup.js";

type Overview = ProactiveOverview & {
  automaticSetup: boolean;
  defaultAssignments: Record<string, string>;
};
function fixture(): Overview {
  return {
    automaticSetup: true,
    defaultAssignments: {},
    recipes: structuredClone(PROACTIVE_RECIPES),
    installations: [],
    mailboxes: [
      {
        id: "mail-a",
        address: "a@example.com",
        status: "active",
        analysisEnabled: true,
        analysisReady: true,
        analysisEmployeeId: "employee-b",
      },
      {
        id: "mail-b",
        address: "b@example.com",
        status: "active",
        analysisEnabled: true,
        analysisReady: true,
      },
    ],
    employees: ["employee-b", "employee-a"].map((id) => ({
      id,
      name: id,
      slug: id,
      modelReady: true,
      financeAccess: "invoice",
      revenueAccess: "write",
      repositoryWrite: true,
      calendarRead: true,
      mailGrants: ["mail-a", "mail-b"].map((accountId) => ({ accountId, accessLevel: "send" })),
    })),
  };
}
function installation(input: ProactiveSetupInput, enabled = true): ProactiveInstallation {
  return {
    id: `installed-${input.recipeId}-${input.accountId ?? input.employeeId}`,
    recipeId: input.recipeId,
    employeeId: input.employeeId,
    accountId: input.accountId ?? null,
    name: "Reviewed native work",
    enabled,
    kind: PROACTIVE_RECIPES.find((recipe) => recipe.id === input.recipeId)!.kind,
    delivery: "draft",
    href: "/native-work",
  };
}
const unblocked: typeof workBlocked = () => ({ blocked: false });

test("scope ownership prevents worker changes and extra mailboxes duplicating company work", () => {
  assert.equal(
    proactiveScope("quote-requests", "mail", "a"),
    proactiveScope("quote-requests", "mail", "b"),
  );
  assert.notEqual(
    proactiveScope("quote-requests", "mail-a", "a"),
    proactiveScope("quote-requests", "mail-b", "a"),
  );
  assert.equal(
    proactiveScope("overdue-invoices", "mail-a", "a"),
    proactiveScope("overdue-invoices", "mail-b", "b"),
  );
  assert.notEqual(
    proactiveScope("work-followthrough", null, "a"),
    proactiveScope("work-followthrough", null, "b"),
  );
});

test("default-on planning selects one ready worker per scope and prioritizes their follow-through", () => {
  const plan = planProactiveDefaults(fixture());
  assert.equal(plan.filter((input) => input.recipeId === "quote-requests").length, 2);
  assert.equal(
    plan.find((input) => input.recipeId === "quote-requests" && input.accountId === "mail-a")
      ?.employeeId,
    "employee-b",
  );
  assert.equal(
    plan.find((input) => input.recipeId === "quote-requests" && input.accountId === "mail-b")
      ?.employeeId,
    "employee-a",
  );
  for (const recipeId of [
    "overdue-invoices",
    "stalled-deals",
    "meeting-followups",
    "discover-improvements",
  ]) {
    assert.equal(plan.filter((input) => input.recipeId === recipeId).length, 1, recipeId);
  }
  assert.equal(plan.filter((input) => input.recipeId === "customer-commitments").length, 2);
  assert.deepEqual(
    plan.slice(0, 2).map((input) => input.recipeId),
    ["work-followthrough", "work-followthrough"],
  );
  assert.ok(plan.every((input) => input.delivery === "draft"));
});

test("reserved deleted scopes and paused or customized native rows are never recreated", () => {
  const overview = fixture();
  overview.defaultAssignments[proactiveScope("quote-requests", "mail-a", "former-employee")] =
    "deleted-rule";
  overview.installations.push(
    installation(
      {
        recipeId: "spam-cleanup",
        employeeId: "employee-b",
        accountId: "mail-b",
        delivery: "draft",
        instruction: "Custom human instruction",
      },
      false,
    ),
  );
  const plan = planProactiveDefaults(overview);
  assert.ok(
    !plan.some((input) => input.recipeId === "quote-requests" && input.accountId === "mail-a"),
  );
  assert.ok(
    !plan.some((input) => input.recipeId === "spam-cleanup" && input.accountId === "mail-b"),
  );
});

test("unavailable analysis, disabled setup and stood-down employees never become ready by assumption", () => {
  const overview = fixture();
  overview.automaticSetup = false;
  assert.deepEqual(planProactiveDefaults(overview), []);
  overview.automaticSetup = true;
  overview.mailboxes[0].analysisEnabled = false;
  overview.mailboxes[1].analysisReady = false;
  const plan = planProactiveDefaults(overview, new Set(["employee-a"]));
  assert.ok(
    !plan.some(
      (input) => PROACTIVE_RECIPES.find((recipe) => recipe.id === input.recipeId)?.kind === "email",
    ),
  );
  assert.ok(plan.every((input) => input.employeeId === "employee-b"));
  assert.deepEqual(planProactiveDefaults(overview, new Set(["employee-a", "employee-b"])), []);
});

test("the pinned reader preference never overrides missing business Grants", () => {
  const overview = fixture();
  overview.employees[0].financeAccess = "read";
  const plan = planProactiveDefaults(overview);
  assert.equal(
    plan.find((input) => input.recipeId === "quote-requests" && input.accountId === "mail-a")
      ?.employeeId,
    "employee-a",
  );
});

test("concurrent company reconciliation coalesces and always uses automatic system installation", async () => {
  const overview = fixture();
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let initialized = 0;
  const installed: ProactiveSetupInput[] = [];
  const dependencies = {
    initialize: async () => {
      initialized++;
      await barrier;
    },
    overview: async () => overview,
    blocked: unblocked,
    install: (async (companyId, userId, input, options) => {
      assert.equal(companyId, "coalesced");
      assert.equal(userId, null);
      assert.deepEqual(options, { automatic: true });
      installed.push(input);
      return installation(input);
    }) as typeof installProactiveStarter,
  };
  const first = reconcileProactiveDefaults("coalesced", dependencies);
  const second = reconcileProactiveDefaults("coalesced", dependencies);
  assert.equal(first, second);
  release();
  await Promise.all([first, second]);
  assert.equal(initialized, 1);
  assert.equal(installed.length, planProactiveDefaults(overview).length);
});

test("late readiness is retried, expected capacity/setup gaps stay pending, unexpected failures remain visible", async () => {
  const overview = fixture();
  overview.employees.forEach((employee) => {
    employee.modelReady = false;
  });
  let calls = 0;
  let unexpected = false;
  const dependencies = {
    initialize: async () => {},
    overview: async () => overview,
    blocked: unblocked,
    install: (async (_companyId, _userId, input) => {
      calls++;
      if (unexpected) throw new Error("Database unavailable");
      if (input.recipeId === "work-followthrough") throw new PlanLimitError("No capacity");
      if (input.recipeId === "quote-requests") throw new ProactiveSetupError("Grant changed");
      return installation(input);
    }) as typeof installProactiveStarter,
  };
  await reconcileProactiveDefaults("late-ready", dependencies);
  assert.equal(calls, 0);
  overview.employees[0].modelReady = true;
  await reconcileProactiveDefaults("late-ready", dependencies);
  assert.ok(calls > 2);
  unexpected = true;
  await assert.rejects(
    reconcileProactiveDefaults("late-ready", dependencies),
    /Database unavailable/,
  );
});

test("a company Standdown prevents initialization and a newly placed stop fences later installs", async () => {
  const overview = fixture();
  let stopped = true;
  let initialized = 0;
  let installed = 0;
  const blocked: typeof workBlocked = () =>
    stopped
      ? { blocked: true, scope: "company", reason: "Paused", standdownId: "stop" }
      : { blocked: false };
  const dependencies = {
    initialize: async () => {
      initialized++;
    },
    overview: async () => overview,
    blocked,
    install: (async (_companyId, _userId, input) => {
      installed++;
      stopped = true;
      return installation(input);
    }) as typeof installProactiveStarter,
  };
  await reconcileProactiveDefaults("stopped", dependencies);
  assert.equal(initialized, 0);
  stopped = false;
  await reconcileProactiveDefaults("stopped", dependencies);
  assert.equal(installed, 1);
});
