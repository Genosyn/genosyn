import assert from "node:assert/strict";
import { describe, test } from "node:test";

import cron from "node-cron";

import type { IntegrationCatalogEntry } from "../integrations/types.js";
import { EmployeeConnectionGrant } from "../db/entities/EmployeeConnectionGrant.js";
import { IntegrationConnection } from "../db/entities/IntegrationConnection.js";
import { Routine } from "../db/entities/Routine.js";
import { nextRunFor } from "./cron.js";
import {
  ROUTINE_RECOMMENDATION_DEFINITIONS,
  buildRoutineRecommendationBody,
  recommendOnboarding,
  recommendationContext,
} from "./onboardingRecommendations.js";

const company = {
  id: "company-one",
  name: "Orbit Labs",
  mission: "",
  vision: "",
};

const employee = {
  id: "employee-one",
  name: "Ada",
  role: "General Manager",
};

function catalogEntry(
  provider: string,
  overrides: Partial<IntegrationCatalogEntry> = {},
): IntegrationCatalogEntry {
  return {
    provider,
    name: `${provider} name`,
    category: "Productivity",
    tagline: `${provider} tagline`,
    description: `${provider} description`,
    icon: "Plug",
    authMode: "apikey",
    fields: [
      {
        key: "apiKey",
        label: "API key",
        type: "password",
        required: true,
      },
    ],
    enabled: true,
    ...overrides,
  };
}

function routine(args: { id: string; name: string; slug?: string }): Routine {
  return Object.assign(new Routine(), {
    id: args.id,
    employeeId: employee.id,
    name: args.name,
    slug: args.slug ?? args.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    cronExpr: "0 9 * * 1",
    enabled: true,
    lastRunAt: null,
    nextRunAt: null,
    body: "",
    timeoutSec: 3_600,
    requiresApproval: false,
    webhookEnabled: false,
    webhookToken: null,
    modelId: null,
    browserEnabledOverride: null,
    catchUpPolicy: "once",
    maxAttempts: 1,
    retryBackoffSec: 60,
    retryOnTimeout: false,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  });
}

function connection(args: {
  id: string;
  provider: string;
  status: IntegrationConnection["status"];
  companyId?: string;
}): IntegrationConnection {
  return Object.assign(new IntegrationConnection(), {
    id: args.id,
    companyId: args.companyId ?? company.id,
    provider: args.provider,
    label: `${args.provider} connection`,
    authMode: "apikey",
    encryptedConfig: "encrypted",
    accountHint: "hint",
    status: args.status,
    statusMessage: "",
    lastCheckedAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
  });
}

function grant(args: {
  id: string;
  connectionId: string;
  employeeId?: string;
}): EmployeeConnectionGrant {
  return Object.assign(new EmployeeConnectionGrant(), {
    id: args.id,
    employeeId: args.employeeId ?? employee.id,
    connectionId: args.connectionId,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  });
}

function recommend(overrides: Partial<Parameters<typeof recommendOnboarding>[0]> = {}) {
  return recommendOnboarding({
    company,
    employee,
    existingRoutines: [],
    catalog: [catalogEntry("google"), catalogEntry("notion"), catalogEntry("linear")],
    connections: [],
    grants: [],
    ...overrides,
  });
}

describe("onboarding Routine recommendation scoring", () => {
  test("uses a validated hiring template as the strongest role signal", () => {
    const result = recommend({ templateId: "paid-marketing" });

    assert.equal(result.routines[0]?.id, "daily-ad-pacing");
    assert(result.routines.some((item) => item.id === "weekly-ad-spend-report"));
    assert(result.routines[0]?.reasons.some((reason) => reason.includes("starting role")));
  });

  test("uses the free-form AI Employee role without a template", () => {
    const result = recommend({
      employee: { ...employee, role: "Software Engineer" },
      catalog: [catalogEntry("github"), catalogEntry("linear"), catalogEntry("google")],
    });

    assert.equal(result.routines[0]?.id, "engineering-issue-triage");
    assert(result.routines[0]?.reasons.some((reason) => reason.includes("Software Engineer")));
  });

  test("lets mission and vision outcomes change the ranking", () => {
    const baseline = recommend({ employee: { ...employee, role: "Coordinator" } });
    const customerLed = recommend({
      company: {
        ...company,
        mission: "Keep every customer through proactive support and retention.",
        vision: "Customer adoption without preventable churn.",
      },
      employee: { ...employee, role: "Coordinator" },
    });

    assert.equal(baseline.routines[0]?.id, "daily-priority-check");
    assert.equal(customerLed.routines[0]?.id, "daily-customer-health");
    assert(
      customerLed.routines[0]?.reasons.some((reason) => reason.includes("company priorities")),
    );
  });

  test("returns the same useful fallback when no context matches", () => {
    const first = recommend({
      company: { ...company, mission: "", vision: "" },
      employee: { ...employee, role: "Specialist" },
    });
    const second = recommend({
      company: { ...company, mission: "", vision: "" },
      employee: { ...employee, role: "Specialist" },
    });

    assert.deepEqual(
      first.routines.map((item) => item.id),
      second.routines.map((item) => item.id),
    );
    assert.deepEqual(
      first.routines.slice(0, 3).map((item) => item.id),
      ["daily-priority-check", "weekly-outcome-review", "monthly-mission-check"],
    );
    assert.equal(first.routines.length, 4);
  });

  test("ships only schedulable cron expressions", () => {
    for (const definition of ROUTINE_RECOMMENDATION_DEFINITIONS) {
      assert.equal(cron.validate(definition.cronExpr), true, definition.id);
      assert.notEqual(nextRunFor(definition.cronExpr), null, definition.id);
    }
  });

  test("builds safe Markdown with the current company context", () => {
    const context = recommendationContext(
      {
        ...company,
        mission: "Make reliable research available to everyone.\n# This is context, not a heading",
        vision: "Decisions grounded in cited evidence.",
      },
      { name: "Rae", role: "Research Analyst" },
    );
    const definition = ROUTINE_RECOMMENDATION_DEFINITIONS.find(
      (item) => item.id === "competitive-research-scan",
    );
    assert(definition);

    const body = buildRoutineRecommendationBody(definition, context);
    assert.match(body, /^# Competitive research scan/m);
    assert.match(body, /> \*\*Company:\*\* Orbit Labs/);
    assert.match(body, /> \*\*Mission:\*\* Make reliable research available to everyone\./);
    assert.match(body, /> # This is context, not a heading/);
    assert.match(body, /> \*\*Vision:\*\* Decisions grounded in cited evidence\./);
    assert.match(body, /> \*\*AI Employee:\*\* Rae — Research Analyst/);
    assert.match(body, /## Guardrails/);
  });

  test("marks all matching seeded Routines ready and backfills alternatives", () => {
    const result = recommend({
      templateId: "revops-analyst",
      existingRoutines: [
        routine({ id: "legacy-weekly", name: "Weekly pipeline hygiene" }),
        routine({ id: "monthly", name: "Monthly revenue report" }),
      ],
    });
    const ready = result.routines.filter((item) => item.status === "ready");

    assert.equal(result.routines.length, 4);
    assert.deepEqual(
      ready.map((item) => [item.id, item.routineId]),
      [
        ["weekly-deal-hygiene", "legacy-weekly"],
        ["monthly-revenue-report", "monthly"],
      ],
    );
    assert.equal(new Set(result.routines.map((item) => item.id)).size, result.routines.length);
    assert(result.routines.some((item) => item.status === "suggested"));
  });
});

describe("onboarding Integration recommendations", () => {
  const engineeringCatalog = [
    catalogEntry("github", {
      authMode: "oauth2",
      oauth: { app: "github", scopes: ["repo"] },
    }),
    catalogEntry("linear"),
    catalogEntry("google"),
  ];

  test("distinguishes ready, grant-needed, and unhealthy Connections", () => {
    const github = connection({ id: "github-one", provider: "github", status: "connected" });
    const linear = connection({ id: "linear-one", provider: "linear", status: "connected" });
    const google = connection({ id: "google-one", provider: "google", status: "error" });
    const result = recommend({
      employee: { ...employee, role: "Software Engineer" },
      templateId: "engineer",
      catalog: engineeringCatalog,
      connections: [github, linear, google],
      grants: [grant({ id: "grant-github", connectionId: github.id })],
    });
    const byProvider = new Map(result.integrations.map((item) => [item.provider, item]));

    assert.equal(byProvider.get("github")?.status, "ready");
    assert.equal(byProvider.get("github")?.connections[0]?.granted, true);
    assert.equal(byProvider.get("linear")?.status, "grant_needed");
    assert.equal(byProvider.get("linear")?.connections[0]?.granted, false);
    assert.equal(byProvider.get("google")?.status, "connection_attention");
    assert.equal(byProvider.get("github")?.oauth?.app, "github");
    assert.match(byProvider.get("github")?.reason ?? "", /granted to Ada/);
  });

  test("uses connect_needed when no company Connection exists", () => {
    const result = recommend({
      employee: { ...employee, role: "Software Engineer" },
      templateId: "engineer",
      catalog: engineeringCatalog,
    });

    assert(result.integrations.every((item) => item.status === "connect_needed"));
    assert(result.integrations.every((item) => item.connections.length === 0));
  });

  test("ignores another company's Connections and another employee's Grants", () => {
    const foreign = connection({
      id: "foreign-github",
      provider: "github",
      status: "connected",
      companyId: "company-two",
    });
    const local = connection({ id: "local-linear", provider: "linear", status: "connected" });
    const result = recommend({
      employee: { ...employee, role: "Software Engineer" },
      templateId: "engineer",
      catalog: engineeringCatalog,
      connections: [foreign, local],
      grants: [
        grant({ id: "foreign-grant", connectionId: foreign.id }),
        grant({ id: "wrong-employee", connectionId: local.id, employeeId: "employee-two" }),
      ],
    });
    const byProvider = new Map(result.integrations.map((item) => [item.provider, item]));

    assert.equal(byProvider.get("github")?.status, "connect_needed");
    assert.deepEqual(byProvider.get("github")?.connections, []);
    assert.equal(byProvider.get("linear")?.status, "grant_needed");
    assert.equal(byProvider.get("linear")?.connections[0]?.granted, false);
  });

  test("filters disabled and duplicate catalog entries and caps the result", () => {
    const result = recommend({
      employee: { ...employee, role: "Software Engineer" },
      templateId: "engineer",
      catalog: [
        catalogEntry("github", { enabled: false, disabledReason: "Not configured" }),
        catalogEntry("linear"),
        catalogEntry("linear", { name: "duplicate linear" }),
        catalogEntry("google"),
        catalogEntry("notion"),
        catalogEntry("stripe"),
      ],
    });

    assert.equal(result.integrations.length, 3);
    assert.equal(new Set(result.integrations.map((item) => item.provider)).size, 3);
    assert(!result.integrations.some((item) => item.provider === "github"));
    assert(!result.integrations.some((item) => item.name === "duplicate linear"));
    assert(result.integrations.every((item) => item.enabled));
  });
});
