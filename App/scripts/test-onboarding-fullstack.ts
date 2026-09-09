/** Real browser + real Express/services/SQLite account and onboarding regressions.
 * Run with Node 22: node --import tsx scripts/test-onboarding-fullstack.ts
 * Uses an isolated in-memory DB, temporary files, console email and a loopback fake model.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page } from "playwright-core";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(appRoot, "../output/playwright");
const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-onboarding-fullstack-"));
const port = 18487;
const uiPort = 18489;
const origin = `http://127.0.0.1:${uiPort}`;
await fs.mkdir(output, { recursive: true });
const serverLogPath = path.join(output, "onboarding-fullstack-server.log");
const browserLogPath = path.join(output, "onboarding-fullstack-browser.log");
await fs.writeFile(serverLogPath, "");
await fs.writeFile(browserLogPath, "");
const child = spawn(
  process.execPath,
  [
    "--import",
    "tsx",
    "scripts/fullstackOnboardingServer.ts",
    testRoot,
    String(port),
    String(uiPort),
  ],
  {
    cwd: appRoot,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
child.stdout.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
  for (const line of String(chunk).split("\n")) {
    if (line.startsWith("[fullstack-stage]") || line.startsWith("[genosyn] listening"))
      console.log(line);
  }
});
child.stderr.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
});
let browser: Browser | undefined;
let page: Page | undefined;
const checks: string[] = [];
const consoleErrors: string[] = [];
const email = "onboarding-owner@example.test";
const password = "Onboarding-QA-password-42";
const nextPassword = "Onboarding-QA-recovered-84";
const companyName = "Onboarding QA Company";
const mission = "Help independent schools keep reliable learning tools.";
const vision = "Every classroom can trust the software it uses.";
async function until(check: () => boolean, description: string, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (child.exitCode !== null)
      throw new Error(
        `App exited (${child.exitCode}) while ${description}: ${serverLog.slice(-6000)}`,
      );
    if (Date.now() > deadline)
      throw new Error(`Timed out ${description}: ${serverLog.slice(-4000)}`);
    await delay(200);
  }
}
function record(message: string) {
  checks.push(message);
  console.log(`PASS ${message}`);
}
async function go(route: string) {
  await page!.goto(`${origin}${route}`, { waitUntil: "domcontentloaded", timeout: 90_000 });
}
async function read<T>(route: string): Promise<T> {
  const response = await page!.request.get(`${origin}${route}`);
  assert.equal(response.status(), 200, `${route}: ${await response.text()}`);
  return response.json() as Promise<T>;
}
async function logout() {
  await page!
    .locator("header")
    .getByRole("button", { name: /Onboarding Owner/ })
    .click();
  await page!.getByRole("button", { name: "Log out", exact: true }).click();
  await page!.getByRole("heading", { name: "Welcome back" }).waitFor();
}
async function login(secret: string, companyReady = true) {
  await page!.getByLabel("Email", { exact: true }).fill(email);
  await page!.getByLabel("Password", { exact: true }).fill(secret);
  await page!.getByRole("button", { name: "Sign in", exact: true }).click();
  if (companyReady)
    await page!.locator("header").getByRole("button", { name: companyName, exact: true }).waitFor();
  else await page!.getByRole("heading", { name: "Set up your company", exact: true }).waitFor();
}
try {
  await fs.mkdir(output, { recursive: true });
  await until(
    () =>
      serverLog.includes(`[genosyn] listening on :${port}`) &&
      serverLog.includes(`[fullstack-stage] built client listening on :${uiPort}`),
    "starting isolated app",
    600_000,
  );
  browser = await chromium.launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 1000 } });
  context.setDefaultTimeout(45_000);
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return url.hostname === "127.0.0.1" || url.protocol === "data:" || url.protocol === "blob:"
      ? route.continue()
      : route.abort();
  });
  page = await context.newPage();
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("response", (response) => {
    const request = response.request();
    if (
      response.url().startsWith(`${origin}/api/`) &&
      (request.method() !== "GET" || response.status() >= 400)
    ) {
      appendFileSync(
        browserLogPath,
        `${request.method()} ${response.status()} ${response.url()}\n`,
      );
    }
  });
  page.on("requestfailed", (request) => {
    if (request.url().startsWith(origin))
      appendFileSync(browserLogPath, `FAILED ${request.url()} ${request.failure()?.errorText}\n`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") appendFileSync(browserLogPath, `CONSOLE ${message.text()}\n`);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page!.mainFrame()) appendFileSync(browserLogPath, `PAGE ${frame.url()}\n`);
  });
  await go("/signup");
  await page.getByLabel("Name", { exact: true }).fill("Onboarding Owner");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const registered = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/auth/signup") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  assert.equal((await registered).status(), 200);
  // Console email is emitted before the registration response sets the session cookie.
  // Wait for the completed signup and auth navigation before opening its verification link.
  await page.waitForURL((url) => url.pathname !== "/signup");
  assert.equal((await read<{ email: string }>("/api/auth/me")).email, email);
  await until(
    () => /http:\/\/127\.0\.0\.1:\d+\/verify-email\/[a-f0-9]+/.test(serverLog),
    "receiving console verification",
  );
  const verifyLink = serverLog.match(/http:\/\/127\.0\.0\.1:\d+\/verify-email\/[a-f0-9]+/)![0];
  await page.goto(verifyLink, { waitUntil: "domcontentloaded" });
  await page
    .getByText("Your email is verified. You can continue to Genosyn.", { exact: true })
    .waitFor();
  await page.getByRole("link", { name: "Continue", exact: true }).click();
  // Bootstrap verification promotes this account and intentionally invalidates its
  // earlier session. The operator proves their password again before company setup.
  await page.getByRole("heading", { name: "Welcome back", exact: true }).waitFor();
  await login(password, false);
  record("Signup, console email verification and bootstrap operator login");

  await page.getByLabel("Company name", { exact: true }).fill(companyName);
  await page.getByLabel("Mission", { exact: true }).fill(mission);
  await page.getByLabel("Vision", { exact: true }).fill(vision);
  await page.getByRole("button", { name: "Create company and continue", exact: true }).click();
  await page.getByRole("heading", { name: "Hire your first AI Employee", exact: true }).waitFor();
  const companies =
    await read<Array<{ id: string; slug: string; mission: string; vision: string }>>(
      "/api/companies",
    );
  const company = companies[0];
  assert.equal(company.mission, mission);
  assert.equal(company.vision, vision);
  record("Company mission and vision saved before hiring");
  await page.getByLabel("Name", { exact: true }).fill("Avery QA");
  await page.getByLabel("Role", { exact: true }).fill("Software Engineer");
  await page.getByRole("button", { name: "Hire AI Employee", exact: true }).click();
  await page.getByText("Avery QA is hired", { exact: true }).waitFor();
  const employees = await read<Array<{ id: string; slug: string; role: string }>>(
    `/api/companies/${company.id}/employees`,
  );
  const employee = employees[0];
  assert.equal(employee.role, "Software Engineer");
  const employeeBase = `/api/companies/${company.id}/employees/${employee.id}`;
  assert.equal((await read<unknown[]>(`${employeeBase}/routines`)).length, 0);
  record("AI Employee hired with no unreviewed Routines");

  await page.getByRole("combobox", { name: "AI Model service", exact: true }).click();
  await page.getByRole("option", { name: "Custom endpoint", exact: true }).click();
  const modelURL = serverLog.match(/\[fullstack-model-url\] (http:\/\/[^\s]+)/)![1];
  await page.getByLabel("Base URL", { exact: true }).fill(modelURL);
  await page.getByLabel("Model ID", { exact: true }).fill("qa-local-model");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText("Avery QA's models", { exact: true }).waitFor();
  assert(serverLog.includes("[fullstack-model-probe] verified"));
  const models = await read<Array<{ status: string; isActive: boolean }>>(`${employeeBase}/models`);
  assert(models.some((model) => model.status === "connected" && model.isActive));
  record("Assigned mock AI Model after a real streaming tool-use connection test");

  await page.getByRole("button", { name: "Choose Routines", exact: true }).click();
  await page.getByRole("heading", { name: "Suggested Routines", exact: true }).waitFor();
  const plan = await read<{ routines: Array<{ name: string; status: string }> }>(
    `${employeeBase}/onboarding-recommendations`,
  );
  const selectedNames = new Set<string>();
  for (const routine of plan.routines.filter((routine) => routine.status === "suggested")) {
    if (
      await page.getByRole("checkbox", { name: `Select ${routine.name}`, exact: true }).isChecked()
    )
      selectedNames.add(routine.name);
  }
  assert(selectedNames.size > 0);
  await page.getByRole("button", { name: /^Schedule \d+ Routines? and continue$/ }).click();
  await page.getByRole("heading", { name: "Connect email", exact: true }).waitFor();
  const allRoutines = await read<Array<{ name: string; body: string }>>(`${employeeBase}/routines`);
  const routines = allRoutines.filter((routine) => selectedNames.has(routine.name));
  assert.equal(routines.length, selectedNames.size);
  assert(
    routines.every(
      (routine) =>
        routine.body.includes(mission) &&
        routine.body.includes(vision) &&
        routine.body.includes("Software Engineer"),
    ),
  );
  await page.getByRole("button", { name: "Skip email for now", exact: true }).click();
  await page
    .getByRole("heading", { name: `Avery QA has joined ${companyName}`, exact: true })
    .waitFor();
  record("Reviewed Routines created with the role, mission and vision; optional email skipped");
  await page.screenshot({ path: path.join(output, "onboarding-fullstack-summary.png") });

  await go(`/c/${company.slug}/employees/${employee.slug}/settings/soul`);
  const soul =
    "# Avery QA\n\nBuild reliable learning tools for independent schools. Verify every change and report evidence.";
  await page.locator("textarea").first().fill(soul);
  const soulSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`${employeeBase}/soul`) && response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save Soul", exact: true }).click();
  assert.equal((await soulSaved).status(), 200);
  assert.equal((await read<{ content: string }>(`${employeeBase}/soul`)).content, soul);
  record("Soul edited and persisted through its browser editor");

  await go(`/c/${company.slug}/skills/new`);
  await page.getByLabel("Name", { exact: true }).fill("Release checklist");
  await page.getByRole("button", { name: "Create skill", exact: true }).click();
  await page.waitForURL(/\/skills\/avery-qa\/release-checklist/);
  const skills = await read<Array<{ name: string }>>(`${employeeBase}/skills`);
  assert(skills.some((skill) => skill.name === "Release checklist"));
  record("Skill created for the AI Employee");

  await page.locator("header").getByRole("button", { name: companyName, exact: true }).click();
  await page.getByRole("button", { name: "+ New company", exact: true }).click();
  await page.getByRole("dialog").getByRole("textbox").fill("Second QA Company");
  await page.getByRole("dialog").getByRole("button", { name: "Create", exact: true }).click();
  await page
    .getByRole("heading", { name: "What is your company here to do?", exact: true })
    .waitFor();
  await page.getByLabel("Mission", { exact: true }).fill("Help teams plan their work.");
  await page.getByLabel("Vision", { exact: true }).fill("Every team works with clarity.");
  await page.getByRole("button", { name: "Save and continue", exact: true }).click();
  await page.getByRole("heading", { name: "Hire your first AI Employee", exact: true }).waitFor();
  await page
    .locator("header")
    .getByRole("button", { name: "Second QA Company", exact: true })
    .click();
  await page.getByRole("button", { name: companyName, exact: true }).click();
  await page.waitForURL(`${origin}/c/${company.slug}`);
  assert.equal((await read<unknown[]>("/api/companies")).length, 2);
  record("Created a second company and switched back using the company picker");

  await go(`/c/${company.slug}/settings/members`);
  await page.getByLabel("Invite by email", { exact: true }).fill("invited-member@example.test");
  await page.getByRole("button", { name: "Send invite", exact: true }).click();
  await page.getByText("Invite sent", { exact: true }).waitFor();
  assert(serverLog.includes("to=invited-member@example.test"));
  assert(/Accept the invite: http:\/\/127\.0\.0\.1:\d+\/invite\//.test(serverLog));
  record("Invited a Member through the UI using console email only");

  await logout();
  await login(password);
  record("Logout and password login round-trip");
  await logout();
  await go("/forgot");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Send reset link", exact: true }).click();
  await until(
    () => /http:\/\/127\.0\.0\.1:\d+\/reset\/[a-f0-9]+/.test(serverLog),
    "receiving console reset link",
  );
  const resetLink = serverLog.match(/http:\/\/127\.0\.0\.1:\d+\/reset\/[a-f0-9]+/)![0];
  await page.goto(resetLink, { waitUntil: "domcontentloaded" });
  await page.getByLabel("New password", { exact: true }).fill(nextPassword);
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await page.getByRole("heading", { name: "Welcome back", exact: true }).waitFor();
  await login(nextPassword);
  record("Forgot password, console reset link, password reset and login");
  assert.deepEqual(consoleErrors, []);
  await fs.writeFile(
    path.join(output, "onboarding-fullstack-results.json"),
    JSON.stringify({ checks, consoleErrors }, null, 2),
  );
  console.log(`Passed ${checks.length} fullstack onboarding flows.`);
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: path.join(output, "onboarding-fullstack-failure.png") })
      .catch(() => undefined);
    await fs.writeFile(
      path.join(output, "onboarding-fullstack-failure.txt"),
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
  }
  throw error;
} finally {
  await browser?.close();
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(8000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await fs.writeFile(path.join(output, "onboarding-fullstack-server.log"), serverLog);
  await fs.rm(testRoot, { recursive: true, force: true });
}
