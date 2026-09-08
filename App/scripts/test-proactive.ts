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
let overview: ProactiveOverview;
let failLoad = false;
let failInstall = false;
let failToggle = false;
let holdInstall = false;
let releaseInstall: (() => void) | undefined;
let loads = 0;
let checks = 0;
await context.routeWebSocket(/\/api\/ws\?/, (socket) => sockets.push(socket));
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (pathname.endsWith("/ws-token")) return route.fulfill({ json: { token: "fixture" } });
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
  sockets.length = 0;
  failLoad = false;
  failInstall = false;
  failToggle = false;
  holdInstall = false;
  releaseInstall = undefined;
  overview = {
    recipes: structuredClone(PROACTIVE_RECIPES),
    installations: [],
    mailboxes: [
      { id: "mailbox", address: "support@example.com", status: "active", analysisEnabled: true },
      { id: "paused", address: "paused@example.com", status: "paused", analysisEnabled: true },
      {
        id: "analysis-off",
        address: "manual@example.com",
        status: "active",
        analysisEnabled: false,
      },
    ],
    employees: [
      {
        id: "ada",
        name: "Ada",
        slug: "ada",
        modelReady: true,
        financeAccess: "invoice",
        revenueAccess: "write",
        repositoryWrite: true,
        calendarRead: true,
        mailGrants: [
          { accountId: "mailbox", accessLevel: "draft" },
          { accountId: "paused", accessLevel: "draft" },
          { accountId: "analysis-off", accessLevel: "draft" },
        ],
      },
      {
        id: "grace",
        name: "Grace",
        slug: "grace",
        modelReady: true,
        financeAccess: "invoice",
        revenueAccess: "write",
        repositoryWrite: true,
        calendarRead: true,
        mailGrants: [{ accountId: "mailbox", accessLevel: "send" }],
      },
      {
        id: "new",
        name: "New employee",
        slug: "new",
        modelReady: false,
        financeAccess: null,
        revenueAccess: null,
        repositoryWrite: false,
        calendarRead: false,
        mailGrants: [],
      },
    ],
  };
}
async function open(role = "owner") {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto(`${server.resolvedUrls!.local[0]}__proactive?role=${role}`, {
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
  await page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: recipe.name, exact: true }) })
    .getByRole("button", { name: "Set up", exact: true })
    .click();
  await page.getByRole("dialog", { name: recipe.name, exact: true }).waitFor();
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
  return page.getByRole("button", { name: /^Enable / });
}
async function submit(page: Page) {
  await enable(page).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
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
    for (const page of context.pages()) await page.close();
  }
}
try {
  await check("catalogue and navigation display real starter instructions", async () => {
    const page = await open();
    await page.getByText("Nothing enabled yet", { exact: true }).waitFor();
    assert.equal(await page.locator("article").count(), PROACTIVE_RECIPES.length);
    assert.equal(
      await page.getByRole("link", { name: /AI Employees/ }).getAttribute("href"),
      "/c/company/employees",
    );
    assert.equal(
      await page.getByRole("link", { name: /Routines and Runs/ }).getAttribute("href"),
      "/c/company/routines",
    );
    await setup(page);
    assert.equal(
      await page.getByRole("textbox", { name: "Instructions", exact: true }).inputValue(),
      PROACTIVE_RECIPES[0].brief,
    );
    assert.equal(await enable(page).isDisabled(), true);
  });
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
  await check(
    "draft is the default and send requires an explicit choice plus Send Grant",
    async () => {
      const page = await open();
      await setup(page);
      await ready(page);
      assert.equal(
        await page
          .getByRole("combobox", { name: "Customer communication", exact: true })
          .inputValue(),
        "Prepare drafts for review",
      );
      assert.equal(await enable(page).isEnabled(), true);
      await choose(page, "Customer communication", "May send when the Soul permits");
      await page
        .getByText("Grant Send access in Email → Settings → AI access.", { exact: true })
        .waitFor();
      assert.equal(await enable(page).isDisabled(), true);
      await choose(page, "AI Employee", "Grace");
      assert.equal(await enable(page).isEnabled(), true);
      await submit(page);
      assert.equal(installs[0].delivery, "soul");
      assert.equal(installs[0].employeeId, "grace");
    },
  );
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
      await page.getByText(/This starter is already installed/).waitFor();
      assert.equal(await enable(page).isDisabled(), true);
      assert.equal(installs.length, 1);
    },
  );
  await check("pause resume and review navigate the installed work", async () => {
    const page = await open();
    await setup(page);
    await ready(page);
    await submit(page);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
    assert.deepEqual(
      toggles.map((entry) => entry.enabled),
      [false, true],
    );
    await page.getByRole("link", { name: "Review work", exact: true }).click();
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
      await page.getByRole("button", { name: "Enabling…", exact: true }).isDisabled(),
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
  await check("ordinary Members can inspect but cannot enable or pause standing work", async () => {
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
      .getByText("An owner or admin can enable and change standing work.", { exact: true })
      .waitFor();
    for (const button of await page.getByRole("button", { name: "Set up", exact: true }).all())
      assert.equal(await button.isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: /^(Pause|Resume)$/ }).count(), 0);
    assert.equal(
      await page.getByRole("link", { name: "Review work", exact: true }).isVisible(),
      true,
    );
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
    "live changes refresh standing work and mobile setup remains within the screen",
    async () => {
      const page = await open();
      await page.getByText("Nothing enabled yet", { exact: true }).waitFor();
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
  await browser.close();
  await server.close();
}
