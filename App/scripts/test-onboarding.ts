/** Browser regressions for company-first onboarding. Run: npx tsx scripts/test-onboarding.ts.
 * Real React screens, fixture HTTP only. Service/route tests cover persistence and model requests.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";
import type { Company, Employee, EmployeeTemplate } from "../client/lib/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const server = await startBrowserFixture("onboardingHarness.tsx", 18484);
const origin = server.origin;
const browser = await chromium.launch({
  channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
context.setDefaultTimeout(20000);
const errors: string[] = [];
const unexpected: string[] = [];
const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
let company: Company;
let employees: Employee[];
let goals: Array<Record<string, unknown>> = [];
let automaticSetup = true;
let failCompany = false;
let failEmployees = false;
let failTemplates = false;
let failRoutines = false;
let holdRoutines = false;
let releaseRoutines: (() => void) | undefined;
let onRoutinesHeld: (() => void) | undefined;
let scheduled = false;
const hire = {
  id: "employee",
  slug: "avery",
  name: "Avery",
  role: "Operations",
  companyId: "company",
} as Employee;
const template = {
  id: "operations",
  name: "Avery",
  role: "Operations",
  tagline: "Keep company work moving.",
  skills: ["Weekly review"],
  routines: [],
} as unknown as EmployeeTemplate;
const mission = "Help local shops deliver reliable customer service.";
const vision = "Every independent shop can thrive.";
const goalSentence = "Reach 50 paying customers by March";
function reset(missing = false) {
  company = {
    id: "company",
    slug: "company",
    name: "Orbit",
    role: "owner",
    mission: missing ? "" : mission,
    vision: missing ? "" : vision,
    hasGoal: false,
  } as Company;
  employees = [];
  goals = [];
  automaticSetup = true;
  writes.length = 0;
  failCompany = failEmployees = failTemplates = failRoutines = scheduled = false;
}
/** A company that has written its Goal and nothing else. */
function resetWithGoalOnly() {
  reset(true);
  company.hasGoal = true;
  goals = [fixtureGoal({ title: goalSentence, targetValue: 50, unit: "paying customers" })];
}
function fixtureGoal(values: {
  title: string;
  targetValue: number;
  unit?: string;
  direction?: string;
}) {
  return {
    id: "goal",
    slug: "goal",
    description: "",
    parentGoalId: null,
    ownerEmployeeId: null,
    metricKind: "manual",
    chartId: null,
    startValue: null,
    currentValue: null,
    currentValueUpdatedAt: null,
    direction: "increase_to",
    unit: "",
    dueAt: null,
    status: "active",
    settledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    progress: null,
    met: false,
    ...values,
  };
}
await context.routeWebSocket(/\/api\/ws/, () => {});
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  const method = request.method();
  if (method !== "GET") writes.push({ path: pathname, body: request.postDataJSON() ?? {} });
  const error = (message: string) => route.fulfill({ status: 503, json: { error: message } });
  if (pathname === "/api/companies/company" && method === "GET")
    return route.fulfill({ json: company });
  if (pathname === "/api/companies/company" && method === "PATCH") {
    if (failCompany) return error("Could not save company direction. Try again.");
    Object.assign(company, request.postDataJSON());
    return route.fulfill({ json: company });
  }
  if (pathname === "/api/companies" && method === "POST") {
    const { goal, timezone: _timezone, ...profile } = request.postDataJSON();
    Object.assign(company, profile);
    if (goal) {
      goals = [fixtureGoal(goal)];
      company.hasGoal = true;
    }
    return route.fulfill({ status: 201, json: company });
  }
  if (pathname === "/api/companies/company/goals") {
    if (method === "GET") return route.fulfill({ json: goals });
    if (failCompany) return error("Could not save company direction. Try again.");
    goals = [...goals, fixtureGoal(request.postDataJSON())];
    company.hasGoal = true;
    return route.fulfill({ json: goals[goals.length - 1] });
  }
  if (pathname === "/api/companies/company/proactive/preview" && method === "GET") {
    return route.fulfill({
      json: {
        automaticSetup,
        employeeReady: false,
        starters: [
          {
            recipeId: "advance-responsibilities",
            name: "Advance my responsibilities",
            schedule: "Weekdays at 08:00",
            installed: false,
          },
          {
            recipeId: "work-followthrough",
            name: "Follow through on open work",
            schedule: "Every 30 minutes",
            installed: false,
          },
        ],
        briefing: { schedule: "Daily", writerName: "Avery", writerIsEmployee: true },
      },
    });
  }
  if (pathname === "/api/companies/company/proactive/defaults" && method === "PATCH") {
    automaticSetup = (request.postDataJSON() as { enabled: boolean }).enabled;
    return route.fulfill({ json: { ok: true } });
  }
  if (pathname === "/api/companies/company/employees") {
    if (method === "GET")
      return failEmployees
        ? error("Could not load employees.")
        : route.fulfill({ json: employees });
    const created = { ...hire, ...request.postDataJSON() };
    employees = [created];
    return route.fulfill({ status: 201, json: created });
  }
  if (pathname === "/api/employee-templates")
    return failTemplates
      ? error("Starting roles unavailable.")
      : route.fulfill({ json: [template] });
  if (pathname.endsWith("/models")) return route.fulfill({ json: [] });
  if (pathname === "/api/model-providers") return route.fulfill({ json: [] });
  if (
    pathname.endsWith("/onboarding-recommendations") ||
    pathname.endsWith("/onboarding-recommendations/routines")
  ) {
    if (method === "POST") {
      if (holdRoutines)
        await new Promise<void>((resolve) => {
          releaseRoutines = resolve;
          onRoutinesHeld?.();
        });
      if (failRoutines) return error("Could not schedule Routines. Try again.");
      scheduled = true;
      return route.fulfill({
        json: { created: [{ recommendationId: "weekly", id: "routine" }], existing: [] },
      });
    }
    return route.fulfill({
      json: {
        context: {
          companyName: company.name,
          goal: (goals[0]?.title as string | undefined) ?? "",
          mission: company.mission,
          vision: company.vision,
          employeeName: (employees[0] ?? hire).name,
          employeeRole: (employees[0] ?? hire).role,
        },
        routines: [
          {
            id: "weekly",
            name: "Review shop service",
            summary: "Review customer service commitments for independent shops.",
            cronExpr: "0 9 * * 1",
            body: `Support ${company.mission}`,
            reasons: [`Matches ${(employees[0] ?? hire).role}`, "Supports company mission"],
            status: scheduled ? "ready" : "suggested",
            routineId: scheduled ? "routine" : null,
          },
        ],
        integrations: [],
      },
    });
  }
  if (pathname.endsWith("/mail/accounts")) return route.fulfill({ json: { accounts: [] } });
  if (pathname.endsWith("/onboarding-status"))
    return route.fulfill({
      json: {
        hasEmployee: true,
        employee: employees[0] ?? hire,
        modelConnected: false,
        skillCount: 1,
        routineCount: scheduled ? 1 : 0,
        scheduledRoutineCount: scheduled ? 1 : 0,
        standingRoutineCount: 0,
        automaticSetup,
        nextRunAt: null,
        mailGranted: false,
        mailAccessLevel: null,
        nextStep: "employee",
      },
    });
  unexpected.push(`${method} ${pathname}`);
  return route.fulfill({ status: 404, json: { error: `Unexpected fixture request: ${pathname}` } });
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
let checks = 0;
async function open(query = "") {
  await page.goto(`${origin}/__onboarding?${query}`, {
    waitUntil: "domcontentloaded",
    // Initial navigation can be slower on busy local browser runners.
    timeout: 180000,
  });
}
async function visible(text: string) {
  await page.getByText(text, { exact: true }).waitFor();
  checks++;
}
async function screenshot(name: string) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "Horizontal overflow",
  );
  await page.screenshot({ path: path.join(output, name), scale: "css" });
  checks++;
}
try {
  await fs.mkdir(output, { recursive: true });
  reset(true);
  await open("mode=new");
  // Wait for the initial screen to mount before timing interactions.
  await page.getByRole("heading", { name: "Set up your company", exact: true }).waitFor({
    timeout: 180000,
  });
  await page.getByRole("button", { name: "Create company and continue" }).click();
  assert.equal(writes.length, 0);
  checks++;
  // Only the name and the Goal are asked for: the mission and vision sit behind a
  // closed disclosure, and the Goal's details wait for a sentence.
  assert.equal(await page.getByLabel("Mission", { exact: true }).isVisible(), false);
  assert.equal(await page.getByLabel("Target", { exact: true }).count(), 0);
  checks += 2;
  await page.getByLabel("Company name", { exact: true }).fill("Orbit");
  await page.getByLabel("Your Goal", { exact: true }).fill("   ");
  await page.getByRole("button", { name: "Create company and continue" }).click();
  await visible("Write your Goal in a sentence.");
  assert.equal(writes.length, 0);
  // The number, direction and unit are read from the sentence and stay editable.
  await page.getByLabel("Your Goal", { exact: true }).fill(goalSentence);
  assert.equal(await page.getByLabel("Target", { exact: true }).inputValue(), "50");
  assert.equal(await page.getByLabel("Unit", { exact: true }).inputValue(), "paying customers");
  assert.equal(
    await page.getByLabel("Direction", { exact: true }).inputValue(),
    "Increase to target",
  );
  checks += 3;
  await page.getByLabel("Your Goal", { exact: true }).fill("Cut churn to 2%");
  assert.equal(await page.getByLabel("Target", { exact: true }).inputValue(), "2");
  assert.equal(await page.getByLabel("Unit", { exact: true }).inputValue(), "%");
  assert.equal(
    await page.getByLabel("Direction", { exact: true }).inputValue(),
    "Decrease to target",
  );
  checks += 3;
  await page.getByLabel("Your Goal", { exact: true }).fill(goalSentence);
  await page.getByLabel("Target", { exact: true }).fill("");
  await page.getByRole("button", { name: "Create company and continue" }).click();
  await visible("Add a target number for your Goal.");
  assert.equal(writes.length, 0);
  await page.getByLabel("Target", { exact: true }).fill("50");
  await page.getByText("Add a mission and vision (optional)", { exact: true }).click();
  await page.getByLabel("Mission", { exact: true }).fill(mission);
  assert.ok(
    await page
      .getByLabel("Mission", { exact: true })
      .evaluate((field) => field.getBoundingClientRect().height <= 120),
  );
  checks++;
  await page.getByLabel("Vision", { exact: true }).fill(vision);
  await screenshot("onboarding-new-company.png");
  await page.getByRole("button", { name: "Create company and continue" }).click();
  await visible("Hire your first AI Employee");
  assert.deepEqual(writes[0].body.goal, {
    title: goalSentence,
    targetValue: 50,
    direction: "increase_to",
    unit: "paying customers",
  });
  assert.equal(writes[0].body.mission, mission);
  assert.equal(writes[0].body.vision, vision);
  assert.equal(typeof writes[0].body.timezone, "string");
  checks += 4;
  await page.getByRole("button", { name: /Operations Keep company work/ }).click();
  await page.getByLabel("Role", { exact: true }).fill("Customer service lead");
  await page.getByRole("button", { name: "Hire AI Employee", exact: true }).click();
  await visible("Avery is hired");
  const hireWrite = writes.find((entry) => entry.path.endsWith("/employees"))!;
  assert.equal(hireWrite.body.role, "Customer service lead");
  assert.equal(hireWrite.body.templateId, undefined);
  checks++;
  await page.getByRole("button", { name: "Choose Routines" }).click();
  await visible("No AI Model is connected yet");
  await page.getByRole("button", { name: "Continue without a model" }).click();
  await visible("Suggested Routines");
  assert.ok(
    await page
      .getByRole("button", { name: "Step 1 of 4: Company — completed, go back", exact: true })
      .locator("span")
      .first()
      .evaluate((dot) => {
        const style = getComputedStyle(dot);
        return style.color !== style.backgroundColor;
      }),
    "Completed steps retain a visible check mark",
  );
  checks++;
  await page.getByText(/their Customer service lead role/).waitFor();
  checks++;
  assert.equal(
    await page.getByText("No Integration suggestions yet", { exact: true }).isVisible(),
    false,
  );
  checks++;
  // The count never claims a limit: the AI Employee gets more than the picks.
  await visible("1 selected");
  assert.equal(await page.getByText(/up to \d+ ?$/).count(), 0);
  await page.getByText(/graded against a short definition of done/).waitFor();
  checks += 2;
  // What arrives without being picked is listed, with the switch that governs it.
  await visible("Also set up for Avery");
  await visible("Follow through on open work");
  await visible("Every 30 minutes");
  await visible("TLDR briefing");
  await visible("Daily · written by Avery");
  await visible("You can change or pause any of these later in Proactive and TLDRs.");
  const standingSwitch = page.getByRole("switch", { name: "Set up standing work automatically" });
  assert.equal(await standingSwitch.getAttribute("aria-checked"), "true");
  await visible(
    "Genosyn adds this standing work automatically once Avery has a connected AI Model.",
  );
  await standingSwitch.click();
  await visible("Automatic setup is off, so Genosyn will not add standing work for Avery.");
  assert.equal(await standingSwitch.getAttribute("aria-checked"), "false");
  assert.deepEqual(
    writes.filter((entry) => entry.path.endsWith("/proactive/defaults")).map((entry) => entry.body),
    [{ enabled: false }],
  );
  await standingSwitch.click();
  await visible(
    "Genosyn adds this standing work automatically once Avery has a connected AI Model.",
  );
  assert.equal(await standingSwitch.getAttribute("aria-checked"), "true");
  checks += 4;
  await screenshot("onboarding-routines-desktop.png");
  failRoutines = true;
  holdRoutines = true;
  const held = new Promise<void>((resolve) => {
    onRoutinesHeld = resolve;
  });
  await page.getByRole("button", { name: "Schedule 1 Routine and continue" }).click();
  await page.getByRole("button", { name: "Scheduling…" }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Continue without adding them" }).isDisabled(),
    true,
  );
  assert.equal(await page.getByRole("button", { name: "Back", exact: true }).isDisabled(), true);
  assert.equal(
    await page.getByRole("checkbox", { name: "Select Review shop service" }).isDisabled(),
    true,
  );
  checks += 3;
  await held;
  assert.ok(releaseRoutines, "The scheduling request reached the API fixture");
  holdRoutines = false;
  releaseRoutines();
  await visible("Could not schedule Routines. Try again.");
  assert.equal(scheduled, false);
  checks++;
  failRoutines = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await visible("Suggested Routines");
  await page.getByRole("button", { name: "Schedule 1 Routine and continue" }).click();
  await visible("Connect email");
  await page.getByRole("button", { name: "Skip email for now" }).click();
  await visible("Review your setup");
  await page.getByText(/They will start once an AI Model is connected\./).waitFor();
  checks++;
  // The summary counts the Routines that were chosen apart from standing work.
  await page.getByText(/^1 Routine scheduled/).waitFor();
  await page.getByText(/^Standing work/).waitFor();
  await page
    .getByText(/Genosyn adds it for Avery automatically once an AI Model is connected\./)
    .waitFor();
  checks += 3;
  await visible("Not connected. You can add a mailbox later from Email → Integrations.");
  await screenshot("onboarding-summary.png");

  for (const step of ["employee", "recommendations", "email", "done"]) {
    reset(true);
    await open(`step=${step}`);
    await visible("What is your company's Goal?");
    assert.equal(
      await page.getByRole("button", { name: "Hire AI Employee", exact: true }).count(),
      0,
    );
    checks++;
  }
  failCompany = true;
  await page.getByLabel("Your Goal", { exact: true }).fill(goalSentence);
  await page.getByText("Add a mission and vision (optional)", { exact: true }).click();
  await page.getByLabel("Mission", { exact: true }).fill(mission);
  await page.getByRole("button", { name: "Save and continue" }).click();
  await visible("Could not save company direction. Try again.");
  assert.equal(await page.getByLabel("Your Goal", { exact: true }).inputValue(), goalSentence);
  assert.equal(await page.getByLabel("Mission", { exact: true }).inputValue(), mission);
  assert.equal(goals.length, 0);
  checks += 3;
  failCompany = false;
  await page.getByRole("button", { name: "Save and continue" }).click();
  await visible("Hire your first AI Employee");
  assert.equal(goals.length, 1);
  assert.equal(company.mission, mission);
  assert.equal(company.hasGoal, true);
  checks += 3;

  // A Goal is enough to hire; the Company step then shows it instead of asking again.
  resetWithGoalOnly();
  await open("step=employee");
  await visible("Hire your first AI Employee");
  await open("step=company");
  await visible("Orbit's Goal");
  await visible(goalSentence);
  assert.equal(
    await page.getByRole("link", { name: "Edit in Goals", exact: true }).getAttribute("href"),
    "/c/company/goals",
  );
  assert.equal(await page.getByLabel("Your Goal", { exact: true }).count(), 0);
  checks += 4;

  reset(true);
  failEmployees = true;
  await open("step=company");
  await visible("What is your company's Goal?");
  assert.equal(await page.getByRole("button", { name: "Save and continue" }).isEnabled(), true);
  checks++;

  reset(true);
  await open("mode=hire");
  await visible("What is your company's Goal?");
  reset();
  failTemplates = true;
  await open();
  await visible("We could not load the starting roles");
  await page.getByLabel("Name", { exact: true }).fill("Avery");
  await page.getByLabel("Role", { exact: true }).fill("Researcher");
  await page.getByRole("button", { name: "Hire AI Employee", exact: true }).click();
  await visible("Avery is hired");

  reset();
  failEmployees = true;
  await open();
  await visible("We could not load your AI Employees");
  assert.equal(
    await page.getByRole("button", { name: "Hire AI Employee", exact: true }).count(),
    0,
  );
  checks++;
  failEmployees = false;
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await visible("Hire your first AI Employee");
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot("onboarding-hire-mobile.png");
  reset(true);
  await open("step=company");
  await visible("What is your company's Goal?");
  await screenshot("onboarding-company-mobile.png");
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log(`Passed ${checks} onboarding browser checks.`);
} catch (error) {
  await fs.writeFile(path.join(output, "onboarding-failure.html"), await page.content());
  await page.screenshot({ path: path.join(output, "onboarding-failure.png"), scale: "css" });
  console.error("Browser errors:", errors);
  console.error("Onboarding browser failure:", error);
  throw error;
} finally {
  releaseRoutines?.();
  await context.close();
  await browser.close();
  await server.close();
}
