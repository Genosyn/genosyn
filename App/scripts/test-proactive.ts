/** Real Chrome regressions for Proactive setup, grants and delivery choices.
 * Run with `npx tsx scripts/test-proactive.ts`; API fixtures are deterministic.
 * The server's complementary tests verify authorization and installed behavior.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import { browserTestVite } from "./browserTestVite";
import { PROACTIVE_RECIPES } from "../server/services/proactive/catalogue";
import { buildInitiativeRequestPrompt } from "../client/lib/initiativePrompt";
import type { ProactiveOverview } from "../shared/proactive";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(root, "../output/playwright");
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 18479, strictPort: false, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-proactive"),
  plugins: [
    {
      name: "proactive-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__proactive", async (_request, response) => {
          const html = await dev.transformIndexHtml(
            "/__proactive",
            `<html><div id="root"></div><script type="module" src="/@fs${root}/scripts/proactiveHarness.tsx"></script></html>`,
          );
          response.setHeader("Content-Type", "text/html");
          response.end(html);
        });
      },
    },
  ],
});
await server.listen().catch(async (error) => {
  await server.close();
  throw error;
});
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const browserErrors: string[] = [];
const sockets: WebSocketRoute[] = [];
const installs: Array<{
  recipeId: string;
  employeeId: string;
  accountId: string | null;
  delivery: "draft" | "soul";
  instruction: string;
}> = [];
const toggles: Array<{ id: string; enabled: boolean }> = [];
const defaultToggles: boolean[] = [];
const postRequests: string[] = [];
let overview: ProactiveOverview;
let failLoad = false;
let failInstall = false;
let failToggle = false;
let failDefaults = false;
let holdDefaults = false;
let releaseDefaults: (() => void) | undefined;
let holdInstall = false;
let releaseInstall: (() => void) | undefined;
let loads = 0;
let checks = 0;
await context.routeWebSocket(/\/api\/ws\?/, (socket) => sockets.push(socket));
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (pathname.endsWith("/ws-token")) return route.fulfill({ json: { token: "fixture" } });
  if (request.method() === "POST") postRequests.push(pathname);
  if (pathname === "/api/companies/company/proactive" && request.method() === "GET") {
    loads++;
    return route.fulfill(
      failLoad
        ? { status: 503, json: { error: "Standing work is temporarily unavailable." } }
        : { json: overview },
    );
  }
  if (pathname === "/api/companies/company/proactive" && request.method() === "POST") {
    const body = request.postDataJSON() as (typeof installs)[number];
    installs.push(body);
    if (holdInstall)
      await new Promise<void>((resolve) => {
        releaseInstall = resolve;
      });
    if (failInstall)
      return route.fulfill({
        status: 400,
        json: {
          error: "The selected employee's Draft Grant was revoked. Refresh and check AI access.",
        },
      });
    const recipe = PROACTIVE_RECIPES.find((entry) => entry.id === body.recipeId)!;
    const row = {
      id: `installation-${installs.length}`,
      recipeId: body.recipeId,
      employeeId: body.employeeId,
      accountId: body.accountId,
      delivery: body.delivery,
      name: recipe.name,
      kind: recipe.kind,
      enabled: true,
      href:
        recipe.kind === "email"
          ? "/c/company/mail/settings/rules"
          : "/c/company/routines/followthrough",
    };
    overview.installations.push(row);
    return route.fulfill({ status: 201, json: row });
  }
  if (pathname === "/api/companies/company/proactive/defaults" && request.method() === "PATCH") {
    const { enabled } = request.postDataJSON() as { enabled: boolean };
    defaultToggles.push(enabled);
    if (holdDefaults)
      await new Promise<void>((resolve) => {
        releaseDefaults = resolve;
      });
    if (failDefaults)
      return route.fulfill({
        status: 503,
        json: { error: "Automatic setup could not be saved. Try again." },
      });
    overview.automaticSetup = enabled;
    return route.fulfill({ json: { automaticSetup: enabled } });
  }
  if (pathname.startsWith("/api/companies/company/proactive/") && request.method() === "PATCH") {
    const id = pathname.split("/").at(-1)!;
    const { enabled } = request.postDataJSON() as { enabled: boolean };
    toggles.push({ id, enabled });
    if (failToggle)
      return route.fulfill({
        status: 400,
        json: { error: "This standing work changed. Reload before changing it." },
      });
    overview.installations = overview.installations.map((row) =>
      row.id === id ? { ...row, enabled } : row,
    );
    return route.fulfill({ json: overview.installations.find((row) => row.id === id) });
  }
  return route.fulfill({ json: [] });
});

function reset() {
  installs.length = 0;
  toggles.length = 0;
  defaultToggles.length = 0;
  postRequests.length = 0;
  sockets.length = 0;
  failLoad = false;
  failInstall = false;
  failToggle = false;
  failDefaults = false;
  holdDefaults = false;
  releaseDefaults = undefined;
  holdInstall = false;
  releaseInstall = undefined;
  overview = {
    automaticSetup: true,
    defaultAssignments: {},
    recipes: structuredClone(PROACTIVE_RECIPES),
    installations: [],
    mailboxes: [
      {
        id: "mailbox",
        address: "support@example.com",
        status: "active",
        analysisEnabled: true,
        analysisReady: true,
        analysisEmployeeId: "ada",
      },
      {
        id: "paused",
        address: "paused@example.com",
        status: "paused",
        analysisEnabled: true,
        analysisReady: true,
      },
      {
        id: "analysis-off",
        address: "manual@example.com",
        status: "active",
        analysisEnabled: false,
        analysisReady: false,
      },
      {
        id: "reader-unready",
        address: "unready@example.com",
        status: "active",
        analysisEnabled: true,
        analysisReady: false,
      },
    ],
    employees: [
      {
        id: "ada",
        name: "Ada",
        slug: "ada",
        modelReady: true,
        chatReady: true,
        financeAccess: "invoice",
        revenueAccess: "write",
        repositoryWrite: true,
        calendarRead: true,
        mailGrants: [
          { accountId: "mailbox", accessLevel: "draft" },
          { accountId: "paused", accessLevel: "draft" },
          { accountId: "analysis-off", accessLevel: "draft" },
          { accountId: "reader-unready", accessLevel: "draft" },
        ],
      },
      {
        id: "grace",
        name: "Grace",
        slug: "grace",
        modelReady: true,
        chatReady: true,
        financeAccess: "invoice",
        revenueAccess: "write",
        repositoryWrite: true,
        calendarRead: true,
        mailGrants: [{ accountId: "mailbox", accessLevel: "send" }],
      },
      {
        id: "lin",
        name: "Lin",
        slug: "lin",
        modelReady: false,
        chatReady: true,
        financeAccess: null,
        revenueAccess: null,
        repositoryWrite: false,
        calendarRead: false,
        mailGrants: [],
      },
      {
        id: "new",
        name: "New employee",
        slug: "new",
        modelReady: false,
        chatReady: false,
        financeAccess: null,
        revenueAccess: null,
        repositoryWrite: false,
        calendarRead: false,
        mailGrants: [],
      },
    ],
  };
}
async function open(role = "owner", draft = "") {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  const params = new URLSearchParams({ role });
  if (draft) params.set("draft", draft);
  await page.goto(`${server.resolvedUrls!.local[0]}__proactive?${params}`, {
    waitUntil: "commit",
    timeout: 60000,
  });
  await page
    .getByRole("heading", { name: "Proactive", exact: true })
    .waitFor({ timeout: Number(process.env.GENOSYN_TEST_LOAD_TIMEOUT ?? 300000) });
  return page;
}
async function setup(page: Page, id = "quote-requests") {
  const recipe = PROACTIVE_RECIPES.find((entry) => entry.id === id)!;
  await openLibrary(page);
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: recipe.name, exact: true }) })
    .getByRole("button", { name: /^(Set up|Add another)$/ })
    .click();
  await page.getByRole("dialog", { name: recipe.name, exact: true }).waitFor();
}
async function openLibrary(page: Page) {
  const browse = page.getByRole("button", {
    name: `Browse ${PROACTIVE_RECIPES.length} starters`,
    exact: true,
  });
  const hide = page.getByRole("button", { name: "Hide starters", exact: true });
  if (!(await hide.isVisible())) {
    await browse.waitFor();
    await browse.click();
  }
  await hide.waitFor();
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function ready(page: Page, employee = "Ada") {
  await choose(page, "AI Employee", employee);
  await choose(page, "Mailbox", "support@example.com");
}
function enable(page: Page) {
  return page.getByRole("button", { name: "Assign work", exact: true });
}
async function submit(page: Page) {
  await enable(page).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
}
async function starterNames(page: Page, expectedCount: number) {
  const cards = page
    .getByRole("region", { name: "Starter library", exact: true })
    .locator("article");
  if (expectedCount > 0) await cards.nth(expectedCount - 1).waitFor();
  await cards.nth(expectedCount).waitFor({ state: "hidden" });
  return cards.locator("h3").allTextContents();
}
async function check(name: string, run: () => Promise<void>) {
  if (process.env.GENOSYN_TEST_FILTER && !name.includes(process.env.GENOSYN_TEST_FILTER)) return;
  reset();
  console.log(`RUN ${name}`);
  try {
    await run();
    checks++;
    console.log(`PASS ${name}`);
  } catch (error) {
    await fs.mkdir(artifacts, { recursive: true });
    for (const [index, page] of context.pages().entries()) {
      await page.screenshot({
        path: path.join(artifacts, `proactive-failed-${index}.png`),
        fullPage: true,
      });
      console.error(await page.locator("body").innerText());
    }
    throw error;
  } finally {
    releaseInstall?.();
    releaseDefaults?.();
    for (const page of context.pages()) await page.close();
  }
}
try {
  await check(
    "automatic setup is on by default and existing assignments need no first visit setup",
    async () => {
      overview.installations.push(
        {
          id: "existing-quote",
          recipeId: "quote-requests",
          employeeId: "ada",
          accountId: "mailbox",
          name: "Customer quote responsibility",
          enabled: true,
          kind: "email",
          delivery: "draft",
          href: "/c/company/mail/settings/rules",
        },
        {
          id: "existing-followthrough",
          recipeId: "work-followthrough",
          employeeId: "grace",
          accountId: null,
          name: "Customized follow-through",
          enabled: false,
          kind: "routine",
          delivery: "draft",
          href: "/c/company/routines/followthrough",
        },
      );
      overview.defaultAssignments = { "opaque-mailbox-scope": "existing-quote" };
      const page = await open();
      const automatic = page.getByRole("switch", { name: "Automatic setup", exact: true });
      await automatic.waitFor();
      assert.equal(await automatic.getAttribute("aria-checked"), "true");
      assert.equal(await automatic.isEnabled(), true);
      await page.getByText(/New ready responsibilities are assigned automatically/).waitFor();
      await page
        .getByRole("link", { name: "Customer quote responsibility", exact: true })
        .waitFor();
      await page.getByRole("link", { name: "Customized follow-through", exact: true }).waitFor();
      await page.getByText("1 running · 1 paused", { exact: true }).waitFor();
      assert.equal(await page.getByText("Running", { exact: true }).count(), 1);
      assert.equal(await page.getByText("Paused", { exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Pause", exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Resume", exact: true }).count(), 1);
      assert.deepEqual(installs, [], "Opening the page never installs work in the browser");
      assert.deepEqual(defaultToggles, []);
      const originalRows = structuredClone(overview.installations);
      await automatic.click();
      await page.getByText(/No new automatic assignments will be made/).waitFor();
      assert.equal(await automatic.getAttribute("aria-checked"), "false");
      assert.deepEqual(
        overview.installations,
        originalRows,
        "Turning defaults off preserves enabled and paused work",
      );
      await page.getByText(/Existing work keeps its current running or paused state/).waitFor();
      await automatic.click();
      await page.getByText(/New ready responsibilities are assigned automatically/).waitFor();
      assert.equal(await automatic.getAttribute("aria-checked"), "true");
      assert.deepEqual(defaultToggles, [false, true]);
      assert.deepEqual(toggles, [], "Defaults never call an individual Pause or Resume");
    },
  );
  await check("automatic setup save errors preserve the setting and support retry", async () => {
    const page = await open("admin");
    const automatic = page.getByRole("switch", { name: "Automatic setup", exact: true });
    await automatic.waitFor();
    failDefaults = true;
    await automatic.click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Automatic setup could not be saved" })
      .waitFor();
    assert.equal(await automatic.getAttribute("aria-checked"), "true");
    assert.equal(await automatic.isEnabled(), true);
    assert.equal(await page.locator("article").count(), 0, "the starter library stays collapsed");
    await openLibrary(page);
    assert.equal(await page.locator("article").count(), PROACTIVE_RECIPES.length);
    failDefaults = false;
    await automatic.click();
    await page.getByText(/No new automatic assignments will be made/).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.getByText("No built-in work assigned", { exact: true }).waitFor();
    await setup(page);
    await ready(page);
    assert.equal(
      await enable(page).isEnabled(),
      true,
      "Manual assignment remains available with defaults off",
    );
    assert.deepEqual(defaultToggles, [false, false]);
  });
  await check("automatic setup pending save prevents duplicate changes", async () => {
    const page = await open();
    const automatic = page.getByRole("switch", { name: "Automatic setup", exact: true });
    await automatic.waitFor();
    holdDefaults = true;
    const sent = page.waitForRequest(
      (request) => request.method() === "PATCH" && request.url().endsWith("/proactive/defaults"),
    );
    await automatic.click();
    await sent;
    await page.getByText("Saving…", { exact: true }).waitFor();
    assert.equal(await automatic.isDisabled(), true);
    assert.equal(await automatic.getAttribute("aria-checked"), "true");
    assert.deepEqual(defaultToggles, [false]);
    releaseDefaults?.();
    await page.getByText(/No new automatic assignments will be made/).waitFor();
    assert.equal(await automatic.isEnabled(), true);
  });
  await check("catalogue and navigation display real starter instructions", async () => {
    const page = await open();
    await page.getByText("Waiting for ready AI Employees", { exact: true }).waitFor();
    assert.equal(await page.locator("article").count(), 0, "starters begin collapsed");
    await openLibrary(page);
    assert.equal(await page.locator("article").count(), PROACTIVE_RECIPES.length);
    assert.equal(
      await page.getByRole("link", { name: "Decision stack", exact: true }).getAttribute("href"),
      "/c/company/decisions",
    );
    assert.equal(
      await page.getByRole("link", { name: "Initiatives", exact: true }).getAttribute("href"),
      "/c/company/initiatives",
    );
    assert.equal(
      await page.getByRole("link", { name: "Revisions", exact: true }).getAttribute("href"),
      "/c/company/revisions",
    );
    assert.equal(
      await page.getByRole("link", { name: "All Routines", exact: true }).getAttribute("href"),
      "/c/company/routines",
    );
    await setup(page);
    assert.equal(
      await page.getByRole("textbox", { name: "Instructions", exact: true }).inputValue(),
      PROACTIVE_RECIPES.find((entry) => entry.id === "quote-requests")!.brief,
    );
    assert.equal(await enable(page).isDisabled(), true);
  });
  await check("the page explains proactive work as a clear three-step review flow", async () => {
    const page = await open();
    const flow = page.getByRole("region", { name: "How proactive work moves", exact: true });
    await flow.waitFor();
    await flow.getByText("Human review stays in the loop", { exact: true }).waitFor();
    const steps = flow.getByRole("listitem");
    assert.equal(await steps.count(), 3);
    const expected = [
      ["Step 1", "Review evidence"],
      ["Step 2", "Bring you the next action"],
      ["Step 3", "Carry out what you approve"],
    ] as const;
    for (const [index, [number, title]] of expected.entries()) {
      await steps.nth(index).getByText(number, { exact: true }).waitFor();
      await steps.nth(index).getByRole("heading", { name: title, exact: true }).waitFor();
    }
    await flow
      .getByText(
        "A Routine you create yourself follows the Approval settings you choose on that Routine.",
        { exact: true },
      )
      .waitFor();
  });
  await check(
    "New Routine opens the arbitrary Routine creation route without installing work",
    async () => {
      const page = await open();
      const link = page.getByRole("link", { name: "New Routine", exact: true });
      assert.equal(await link.getAttribute("href"), "/c/company/routines/new");
      await link.click();
      const route = page.getByRole("status", { name: "Current route", exact: true });
      await route
        .filter({ hasText: /^\/c\/company\/routines\/new$/ })
        .waitFor({ state: "attached" });
      assert.equal(await route.textContent(), "/c/company/routines/new");
      assert.deepEqual(postRequests, []);
      assert.deepEqual(installs, []);
    },
  );
  await check("Ask AI Employee lists every employee and their model readiness", async () => {
    const page = await open();
    await page.getByRole("button", { name: "Ask AI Employee", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Ask an AI Employee", exact: true });
    await dialog.waitFor();
    await dialog.getByRole("combobox", { name: "AI Employee", exact: true }).click();
    assert.deepEqual(await page.getByRole("listbox").getByRole("option").allTextContents(), [
      "Choose an AI Employee",
      "Ada",
      "Grace",
      "Lin",
      "New employee — AI Model not connected",
    ]);
    await choose(page, "AI Employee", "Lin");
    await dialog
      .getByRole("textbox", { name: "What should become standing work?", exact: true })
      .fill("Review open commitments every week.");
    assert.equal(
      await dialog.getByRole("button", { name: "Continue to Chat", exact: true }).isEnabled(),
      true,
      "Chat remains available when a connected non-active AI Model can answer",
    );
    assert.deepEqual(postRequests, []);
    assert.deepEqual(installs, []);
  });
  await check(
    "a connected employee opens the correct Chat with the exact unsent Initiative draft",
    async () => {
      const page = await open();
      await page.getByRole("button", { name: "Ask AI Employee", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Ask an AI Employee", exact: true });
      await choose(page, "AI Employee", "Ada");
      const request =
        "Every Monday at 09:00, review open customer commitments and propose one safe owner follow-up.";
      const expectedPrompt = buildInitiativeRequestPrompt(request);
      await dialog
        .getByRole("textbox", { name: "What should become standing work?", exact: true })
        .fill(request);
      await dialog.getByRole("button", { name: "Continue to Chat", exact: true }).click();
      const route = page.getByRole("status", { name: "Current route", exact: true });
      await route
        .filter({ hasText: /^\/c\/company\/employees\/ada\/chat$/ })
        .waitFor({ state: "attached" });
      const prompt = page.getByRole("status", { name: "Ada Chat draft", exact: true });
      await page.waitForFunction(
        (expected) =>
          document.querySelector('output[aria-label="Ada Chat draft"]')?.textContent === expected,
        expectedPrompt,
      );
      assert.equal(await route.textContent(), "/c/company/employees/ada/chat");
      assert.equal(await prompt.textContent(), expectedPrompt);
      assert.equal(await prompt.getAttribute("class"), "sr-only");
      assert.equal(
        await page
          .getByRole("status", { name: "Ada Chat conversation", exact: true })
          .textContent(),
        "new",
        "The handoff starts a new Chat instead of reusing the selected conversation",
      );
      assert.deepEqual(postRequests, [], "Continuing only stages a Chat composer draft");
      assert.deepEqual(installs, [], "Continuing never installs a starter");
    },
  );
  await check("an existing unsent Chat draft is preserved before a new request", async () => {
    const existingDraft = "Keep this older unsent Chat draft separate.";
    const page = await open("owner", existingDraft);
    const draft = page.getByRole("status", { name: "Ada Chat draft", exact: true });
    await draft.filter({ hasText: existingDraft }).waitFor({ state: "attached" });
    await page.getByRole("button", { name: "Ask AI Employee", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Ask an AI Employee", exact: true });
    await choose(page, "AI Employee", "Ada");
    await dialog
      .getByRole("textbox", { name: "What should become standing work?", exact: true })
      .fill("Review open commitments every week.");
    await dialog
      .getByRole("status")
      .filter({ hasText: /^Ada already has an unsent Chat draft\./ })
      .waitFor();
    assert.equal(
      await dialog.getByRole("button", { name: "Continue to Chat", exact: true }).isDisabled(),
      true,
    );
    assert.equal(await draft.textContent(), existingDraft);
    assert.equal(
      await dialog
        .getByRole("link", { name: "Open existing draft", exact: true })
        .getAttribute("href"),
      "/c/company/employees/ada/chat",
    );
    assert.deepEqual(postRequests, []);
    assert.deepEqual(installs, []);
  });
  await check(
    "an employee without a connected model is blocked with a settings route",
    async () => {
      const page = await open();
      await page.getByRole("button", { name: "Ask AI Employee", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Ask an AI Employee", exact: true });
      await choose(page, "AI Employee", "New employee — AI Model not connected");
      await dialog
        .getByRole("textbox", { name: "What should become standing work?", exact: true })
        .fill("Review open commitments every weekday.");
      await dialog
        .getByRole("status")
        .filter({ hasText: /^Connect an AI Model before asking New employee\./ })
        .waitFor();
      const settings = dialog.getByRole("link", { name: "Open Model settings", exact: true });
      assert.equal(await settings.getAttribute("href"), "/c/company/employees/new/settings/model");
      assert.equal(
        await dialog.getByRole("button", { name: "Continue to Chat", exact: true }).isDisabled(),
        true,
      );
      assert.deepEqual(postRequests, []);
      assert.deepEqual(installs, []);
    },
  );
  await check(
    "Ask AI Employee explains how to create the first employee for an empty roster",
    async () => {
      overview.employees = [];
      const page = await open();
      await page.getByRole("button", { name: "Ask AI Employee", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Ask an AI Employee", exact: true });
      await dialog.getByText("No AI Employees yet", { exact: true }).waitFor();
      const create = dialog.getByRole("link", { name: "Create an AI Employee", exact: true });
      assert.equal(await create.getAttribute("href"), "/c/company/employees/new");
      assert.equal(await dialog.getByRole("combobox").count(), 0);
      assert.deepEqual(postRequests, []);
      assert.deepEqual(installs, []);
    },
  );
  await check("ordinary Members cannot see or use proactive creation controls", async () => {
    const page = await open("member");
    assert.equal(
      await page.getByRole("button", { name: "Ask AI Employee", exact: true }).count(),
      0,
    );
    assert.equal(await page.getByRole("link", { name: "New Routine", exact: true }).count(), 0);
    await openLibrary(page);
    const starterButtons = page.getByRole("button", { name: /^(Set up|Add another)$/ });
    assert.equal(await starterButtons.count(), PROACTIVE_RECIPES.length);
    for (const button of await starterButtons.all()) assert.equal(await button.isDisabled(), true);
    assert.deepEqual(postRequests, []);
    assert.deepEqual(installs, []);
  });
  await check("All Email and Scheduled filters account for every starter recipe", async () => {
    const page = await open();
    await openLibrary(page);
    const filters = page.getByRole("group", { name: "Filter starter library", exact: true });
    const expectations = [
      ["All", overview.recipes],
      ["Email", overview.recipes.filter((recipe) => recipe.kind === "email")],
      ["Scheduled", overview.recipes.filter((recipe) => recipe.kind === "routine")],
    ] as const;
    const seen = new Set<string>();
    for (const [label, recipes] of expectations) {
      const filter = filters.getByRole("button", { name: label, exact: true });
      await filter.click();
      assert.equal(await filter.getAttribute("aria-pressed"), "true");
      const names = await starterNames(page, recipes.length);
      assert.deepEqual(
        names,
        recipes.map((recipe) => recipe.name),
      );
      for (const recipe of recipes) seen.add(recipe.id);
    }
    assert.deepEqual([...seen].sort(), overview.recipes.map((recipe) => recipe.id).sort());
  });
  await check(
    "desktop and narrow layouts keep the page and Ask modal within the viewport",
    async () => {
      const page = await open();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        "The desktop page does not overflow horizontally",
      );
      await page.getByRole("button", { name: "Ask AI Employee", exact: true }).click();
      let dialog = page.getByRole("dialog", { name: "Ask an AI Employee", exact: true });
      let bounds = await dialog.boundingBox();
      assert.ok(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= 1440 &&
          bounds.y + bounds.height <= 1000,
        "The desktop Ask modal fits the viewport",
      );
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        "The 390px page does not overflow horizontally",
      );
      await page.getByRole("button", { name: "Ask AI Employee", exact: true }).click();
      dialog = page.getByRole("dialog", { name: "Ask an AI Employee", exact: true });
      bounds = await dialog.boundingBox();
      assert.ok(
        bounds &&
          bounds.x >= 0 &&
          bounds.y >= 0 &&
          bounds.x + bounds.width <= 390 &&
          bounds.y + bounds.height <= 844,
        "The 390px Ask modal fits the viewport",
      );
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        "Opening the Ask modal does not introduce horizontal overflow",
      );
    },
  );
  await check("missing model and resource Grants block setup", async () => {
    const page = await open();
    await setup(page);
    await ready(page, "New employee");
    await page
      .getByText("Connect an active AI Model on this AI Employee.", { exact: true })
      .waitFor();
    await page
      .getByText("Grant Draft access in Email → Settings → AI access.", { exact: true })
      .waitFor();
    await page
      .getByText("Grant Invoicing access in Finance → AI access.", { exact: true })
      .waitFor();
    assert.equal(await enable(page).isDisabled(), true);
    assert.deepEqual(installs, []);
  });
  await check("automatic customer email has one Decision-stack review path", async () => {
    const page = await open();
    await setup(page);
    await ready(page);
    await page
      .getByText("Customer communication is reviewed in Genosyn", { exact: true })
      .waitFor();
    await page
      .getByText(/never creates a draft in Gmail or IMAP and never sends automatically/)
      .waitFor();
    assert.equal(
      await page.getByRole("combobox", { name: "Customer communication", exact: true }).count(),
      0,
    );
    assert.equal(await page.getByText("Prepare drafts for review", { exact: true }).count(), 0);
    assert.equal(await page.getByText(/Draft mode blocks sending/).count(), 0);
    assert.equal(await enable(page).isEnabled(), true);
    await submit(page);
    assert.equal(installs[0].delivery, "draft");
    assert.equal(installs[0].employeeId, "ada");
  });
  await check("mailbox state and AI analysis readiness are enforced", async () => {
    const page = await open();
    await setup(page);
    await ready(page);
    await choose(page, "Mailbox", "paused@example.com");
    await page
      .getByText("Reconnect or resume this mailbox in Email → Settings.", { exact: true })
      .waitFor();
    assert.equal(await enable(page).isDisabled(), true);
    await choose(page, "Mailbox", "manual@example.com");
    await page.getByText("Turn on AI analysis in Email → Settings.", { exact: true }).waitFor();
    assert.equal(await enable(page).isDisabled(), true);
    await choose(page, "Mailbox", "unready@example.com");
    await page
      .getByText(
        "Choose an AI analysis reader with mailbox Read access and a connected AI Model in Email → Settings.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await enable(page).isDisabled(), true);
    assert.deepEqual(installs, []);
  });
  await check(
    "installation sends the reviewed instruction and prevents duplicate setup",
    async () => {
      const page = await open();
      await setup(page);
      await ready(page);
      const instruction =
        "Prepare quotes only from the approved product catalogue. Ask about missing quantities.";
      await page.getByRole("textbox", { name: "Instructions", exact: true }).fill(instruction);
      await submit(page);
      assert.deepEqual(installs[0], {
        recipeId: "quote-requests",
        employeeId: "ada",
        accountId: "mailbox",
        delivery: "draft",
        instruction,
      });
      await setup(page);
      await ready(page);
      await page.getByText(/This responsibility is already assigned/).waitFor();
      assert.equal(await enable(page).isDisabled(), true);
      assert.equal(installs.length, 1);
    },
  );
  await check("pause resume and open navigate the installed work", async () => {
    const page = await open();
    await setup(page);
    await ready(page);
    await submit(page);
    await page.getByText("Running", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    await page.getByText("Paused", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    await page.getByText("Running", { exact: true }).waitFor();
    assert.deepEqual(
      toggles.map((entry) => entry.enabled),
      [false, true],
    );
    await page.getByRole("link", { name: "Open", exact: true }).click();
    await page
      .getByRole("status", { name: "Current route", exact: true })
      .filter({ hasText: /^\/c\/company\/mail\/settings\/rules$/ })
      .waitFor({ state: "attached" });
    assert.equal(
      await page.getByRole("status", { name: "Current route", exact: true }).textContent(),
      "/c/company/mail/settings/rules",
    );
  });
  await check("failed install preserves inputs for a corrected retry", async () => {
    const page = await open();
    await setup(page);
    await ready(page);
    await page
      .getByRole("textbox", { name: "Instructions", exact: true })
      .fill("Keep this reviewed instruction.");
    failInstall = true;
    await enable(page).click();
    await page.getByRole("alert").filter({ hasText: "Draft Grant was revoked" }).waitFor();
    assert.equal(
      await page.getByRole("textbox", { name: "Instructions", exact: true }).inputValue(),
      "Keep this reviewed instruction.",
    );
    assert.equal(await enable(page).isEnabled(), true);
    failInstall = false;
    await submit(page);
    assert.equal(installs.length, 2);
  });
  await check("pending install disables duplicate submit and cancellation", async () => {
    const page = await open();
    await setup(page);
    await ready(page);
    holdInstall = true;
    const sent = page.waitForRequest(
      (request) => request.method() === "POST" && request.url().endsWith("/proactive"),
    );
    await enable(page).click();
    await sent;
    assert.equal(
      await page.getByRole("button", { name: "Assigning…", exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole("button", { name: "Cancel", exact: true }).isDisabled(),
      true,
    );
    assert.equal(installs.length, 1);
    releaseInstall?.();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  });
  await check("load and pause errors are actionable without losing the page", async () => {
    failLoad = true;
    const page = await open();
    await page.getByRole("alert").filter({ hasText: "temporarily unavailable" }).waitFor();
    failLoad = false;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await setup(page);
    await ready(page);
    await submit(page);
    failToggle = true;
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "standing work changed" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Pause", exact: true }).isEnabled(), true);
    assert.equal(overview.installations[0].enabled, true);
  });
  await check("automatic setup and standing work are read-only for ordinary Members", async () => {
    overview.installations.push({
      id: "existing",
      recipeId: "quote-requests",
      employeeId: "ada",
      accountId: "mailbox",
      name: "Quote work",
      enabled: true,
      kind: "email",
      delivery: "draft",
      href: "/c/company/mail/settings/rules",
    });
    const page = await open("member");
    await page
      .getByText(
        "Standing work is read-only for Members. An owner or admin can create Routines, ask an AI Employee for an Initiative, change Automatic setup, and pause responsibilities.",
        { exact: true },
      )
      .waitFor();
    const automatic = page.getByRole("switch", { name: "Automatic setup", exact: true });
    assert.equal(await automatic.getAttribute("aria-checked"), "true");
    assert.equal(await automatic.isDisabled(), true);
    await openLibrary(page);
    for (const button of await page.getByRole("button", { name: /^(Set up|Add another)$/ }).all())
      assert.equal(await button.isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: /^(Pause|Resume)$/ }).count(), 0);
    assert.equal(await page.getByRole("link", { name: "Open", exact: true }).isVisible(), true);
    assert.deepEqual(defaultToggles, []);
    assert.deepEqual(toggles, []);
    assert.deepEqual(installs, []);
  });
  await check(
    "scheduled starters omit send options and allow a mailbox-free follow-through",
    async () => {
      const page = await open();
      await setup(page, "work-followthrough");
      await choose(page, "AI Employee", "Ada");
      assert.equal(await page.getByRole("combobox", { name: "Mailbox", exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("combobox", { name: "Customer communication", exact: true }).count(),
        0,
      );
      await submit(page);
      assert.equal(installs[0].accountId, null);
      assert.equal(installs[0].delivery, "draft");
    },
  );
  await check(
    "daily responsibilities are prominent and can be assigned without extra Grants",
    async () => {
      const recipe = PROACTIVE_RECIPES.find((entry) => entry.id === "advance-responsibilities")!;
      overview.mailboxes = [];
      overview.employees = [
        { ...overview.employees.find((entry) => entry.id === "new")!, modelReady: true },
      ];
      const page = await open();
      await openLibrary(page);
      const card = page
        .locator("article")
        .filter({ has: page.getByRole("heading", { name: recipe.name, exact: true }) });
      await card.getByText("Recommended", { exact: true }).waitFor();
      await card.getByText("Weekdays at 08:00", { exact: true }).waitFor();
      await setup(page, recipe.id);
      await choose(page, "AI Employee", "New employee");
      assert.equal(await page.getByRole("combobox", { name: "Mailbox", exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("combobox", { name: "Customer communication", exact: true }).count(),
        0,
      );
      const instructions = await page
        .getByRole("textbox", { name: "Instructions", exact: true })
        .inputValue();
      assert.match(instructions, /get_proactive_work/);
      assert.match(instructions, /list_initiatives/);
      assert.match(instructions, /previous|declined/);
      await submit(page);
      assert.deepEqual(installs, [
        {
          recipeId: recipe.id,
          employeeId: "new",
          accountId: null,
          delivery: "draft",
          instruction: recipe.brief,
        },
      ]);
    },
  );
  await check("daily responsibility review waits for a connected AI Model", async () => {
    overview.mailboxes = [];
    overview.employees = [overview.employees.find((entry) => entry.id === "new")!];
    const page = await open();
    await setup(page, "advance-responsibilities");
    await choose(page, "AI Employee", "New employee");
    await page
      .getByText("Connect an active AI Model on this AI Employee.", { exact: true })
      .waitFor();
    assert.equal(await enable(page).isDisabled(), true);
    assert.deepEqual(installs, []);
  });
  await check("Members can inspect daily ownership and open Initiatives on mobile", async () => {
    overview.installations.push({
      id: "daily",
      recipeId: "advance-responsibilities",
      employeeId: "ada",
      accountId: null,
      name: "Advance my responsibilities",
      enabled: true,
      kind: "routine",
      delivery: "draft",
      href: "/c/company/routines/ada/daily",
    });
    const page = await open("member");
    await page.setViewportSize({ width: 390, height: 844 });
    const standing = page.getByRole("region", { name: "Standing work", exact: true });
    await standing
      .getByRole("link", { name: "Advance my responsibilities", exact: true })
      .waitFor();
    assert.equal(await standing.getByRole("button", { name: "Pause", exact: true }).count(), 0);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    );
    await fs.mkdir(artifacts, { recursive: true });
    await page.screenshot({
      path: path.join(artifacts, "proactive-daily-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("link", { name: "Initiatives", exact: true }).click();
    await page
      .getByRole("status", { name: "Current route", exact: true })
      .filter({ hasText: /^\/c\/company\/initiatives$/ })
      .waitFor({ state: "attached" });
    assert.deepEqual(defaultToggles, []);
    assert.deepEqual(installs, []);
  });
  await check(
    "self-review can be assigned with a connected model and no extra Grants",
    async () => {
      const recipe = PROACTIVE_RECIPES.find((entry) => entry.id === "improve-own-work");
      assert.ok(recipe, "The shared catalogue includes the self-review responsibility");
      overview.mailboxes = [];
      overview.employees = [
        { ...overview.employees.find((entry) => entry.id === "new")!, modelReady: true },
      ];
      const page = await open();
      await openLibrary(page);
      const card = page.locator("article").filter({
        has: page.getByRole("heading", { name: "Improve my work", exact: true }),
      });
      await card.waitFor();
      await card.getByText("Fridays at 15:00", { exact: true }).waitFor();
      await setup(page, "improve-own-work");
      await choose(page, "AI Employee", "New employee");
      assert.equal(await page.getByRole("combobox", { name: "Mailbox", exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("combobox", { name: "Customer communication", exact: true }).count(),
        0,
      );
      assert.equal(await page.getByText("Before assigning", { exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("textbox", { name: "Instructions", exact: true }).inputValue(),
        recipe.brief,
      );
      assert.equal(await enable(page).isEnabled(), true);
      await submit(page);
      assert.deepEqual(installs, [
        {
          recipeId: "improve-own-work",
          employeeId: "new",
          accountId: null,
          delivery: "draft",
          instruction: recipe.brief,
        },
      ]);
      assert.equal(overview.installations[0].kind, "routine");
    },
  );
  await check("self-review still waits for a connected AI Model", async () => {
    overview.mailboxes = [];
    overview.employees = [overview.employees.find((entry) => entry.id === "new")!];
    const page = await open();
    await setup(page, "improve-own-work");
    await choose(page, "AI Employee", "New employee");
    await page
      .getByText("Connect an active AI Model on this AI Employee.", { exact: true })
      .waitFor();
    assert.equal(await enable(page).isDisabled(), true);
    assert.equal(await page.getByRole("combobox", { name: "Mailbox", exact: true }).count(), 0);
    assert.deepEqual(installs, []);
  });
  await check("self-review assignments and Revisions are visible to Members", async () => {
    overview.installations.push({
      id: "own-review",
      recipeId: "improve-own-work",
      employeeId: "ada",
      accountId: null,
      name: "Improve my work",
      enabled: true,
      kind: "routine",
      delivery: "draft",
      href: "/c/company/routines/improve-my-work",
    });
    const page = await open("member");
    const standing = page.getByRole("region", { name: "Standing work", exact: true });
    await standing.getByRole("link", { name: "Improve my work", exact: true }).waitFor();
    const revisions = page.getByRole("link", { name: "Revisions", exact: true });
    assert.equal(await revisions.getAttribute("href"), "/c/company/revisions");
    assert.equal(await revisions.isVisible(), true);
    assert.deepEqual(installs, [], "Existing automatic self-review requires no browser setup");
    await fs.mkdir(artifacts, { recursive: true });
    await page.screenshot({
      path: path.join(artifacts, "proactive-self-review-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    assert.ok(fits, "The Revisions link and new responsibility fit a narrow screen");
    await page.screenshot({
      path: path.join(artifacts, "proactive-self-review-mobile.png"),
      fullPage: true,
    });
    await revisions.click();
    await page
      .getByRole("status", { name: "Current route", exact: true })
      .filter({ hasText: /^\/c\/company\/revisions$/ })
      .waitFor({ state: "attached" });
    assert.equal(
      await page.getByRole("status", { name: "Current route", exact: true }).textContent(),
      "/c/company/revisions",
    );
    assert.deepEqual(defaultToggles, []);
  });
  await check(
    "live changes refresh standing work and mobile setup remains within the screen",
    async () => {
      const page = await open();
      await page.getByText("Waiting for ready AI Employees", { exact: true }).waitFor();
      const initialLoads = loads;
      overview.installations.push({
        id: "live",
        recipeId: "quote-requests",
        employeeId: "ada",
        accountId: "mailbox",
        name: "Live quote work",
        enabled: true,
        kind: "email",
        delivery: "draft",
        href: "/c/company/mail/settings/rules",
      });
      assert.ok(sockets.at(-1));
      sockets.at(-1)!.send(JSON.stringify({ type: "mail.updated" }));
      await page.getByRole("link", { name: "Live quote work", exact: true }).waitFor();
      assert.ok(loads > initialLoads);
      await fs.mkdir(artifacts, { recursive: true });
      await page.screenshot({
        path: path.join(artifacts, "proactive-desktop.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await setup(page, "customer-code-issues");
      await ready(page);
      const fits = await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      );
      assert.ok(fits, "No horizontal document overflow on a narrow screen");
      const dialog = await page.getByRole("dialog").boundingBox();
      assert.ok(dialog && dialog.x >= 0 && dialog.x + dialog.width <= 391);
      assert.equal(await enable(page).isVisible(), true);
      await page.screenshot({ path: path.join(artifacts, "proactive-mobile.png"), fullPage: true });
    },
  );
  assert.deepEqual(browserErrors, [], "No browser runtime errors");
  console.log(`${checks} Proactive browser regression groups passed.`);
} finally {
  releaseInstall?.();
  releaseDefaults?.();
  await browser.close();
  await server.close();
}
