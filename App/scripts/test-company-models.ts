/**
 * Real Chrome over the real routers: Settings → AI Models lists the company's
 * AI Models, an owner attaches one model to two AI Employees, both run on it —
 * the very same row and keys — and each employee's Model page says who shares
 * it; detaching it from one leaves it, and the other's use of it, in place.
 * Also: removing a model in use is asked first, naming who would be left with
 * no AI Model; copies of one key are offered for merging and merge into one; a
 * Member is told the page is for owners and admins; a phone-width screen and
 * dark mode.
 *
 * Every API call goes to the real routers on a private in-memory database. No
 * provider is called — nothing here needs a model to answer — and no live
 * credential is used. Run with `npm run test:company-models`.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium, type Locator, type Page } from "playwright-core";
import { config } from "../config";
import { AppDataSource } from "../server/db/datasource";
import { AIEmployee } from "../server/db/entities/AIEmployee";
import { AIModel } from "../server/db/entities/AIModel";
import { Company } from "../server/db/entities/Company";
import { EmployeeModel } from "../server/db/entities/EmployeeModel";
import { Membership } from "../server/db/entities/Membership";
import { User } from "../server/db/entities/User";
import { errorHandler } from "../server/middleware/error";
import { companyModelsRouter } from "../server/routes/companyModels";
import { employeesRouter } from "../server/routes/employees";
import { modelsRouter } from "../server/routes/models";
import { newStoredApiKey, writeApiKeys } from "../server/services/modelApiKeys";
import { getActiveModel } from "../server/services/models";
import { closeTestDb, initTestDb, insert } from "../server/test/dbHarness";
import { attachExistingModel } from "../server/test/modelFixtures";
import { persistTestSession } from "../server/test/userSession";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "../output/playwright");

const SHARED_KEY = "sk-ant-api03-company-models-browser-aaaa1001";
const LINUS_KEY = "sk-ant-api03-company-models-browser-bbbb2002";
const EVERY_SECRET = [SHARED_KEY, LINUS_KEY];

// ---------- The real routers on a private database ----------

const mutable = config as unknown as {
  sessionSecret: string;
  dataDir: string;
  security: { encryptionSecret: string; multiTenant: boolean };
};
mutable.sessionSecret = "company-models-browser-session-secret-0123456789";
mutable.security.encryptionSecret = "company-models-browser-encryption-secret-0123456789";
mutable.security.multiTenant = false;
await initTestDb();

const owner = await insert(User, {
  email: "models-owner@example.test",
  name: "Owner",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const member = await insert(User, {
  email: "models-member@example.test",
  name: "Member",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
const hire = (name: string, role: string) =>
  insert(AIEmployee, {
    companyId: company.id,
    name,
    slug: name.toLowerCase(),
    role,
    soulBody: "",
  });
const ada = await hire("Ada", "Analyst");
const grace = await hire("Grace", "Engineer");
const linus = await hire("Linus", "Support");

const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9, 0, 0));
// The company's Claude, connected in Settings → AI Models and used by nobody yet.
const claude = await insert(AIModel, {
  companyId: company.id,
  provider: "anthropic",
  model: "claude-opus-5-5",
  authMode: "apikey",
  configJson: writeApiKeys("{}", [newStoredApiKey(SHARED_KEY, company.id)]),
  connectedAt: day(1),
  contextWindow: 1_000_000,
  contextWindowSource: "probed",
  createdAt: day(1),
});
// Linus runs on a model of his own.
const linusOwn = await insert(AIModel, {
  companyId: company.id,
  provider: "openai",
  model: "gpt-5.5",
  authMode: "apikey",
  configJson: writeApiKeys("{}", [newStoredApiKey(LINUS_KEY, company.id)]),
  connectedAt: day(2),
  createdAt: day(2),
});
await attachExistingModel({ employeeId: linus.id, modelId: linusOwn.id, isActive: true });

const app = express();
app.use(express.json());
app.use(async (req, _res, next) => {
  (req as unknown as { session: Record<string, unknown> }).session = {
    userId: req.header("x-test-user"),
    sessionVersion: 0,
    authenticatedAt: Date.now(),
  };
  await persistTestSession(req);
  next();
});
app.use("/api/companies/:cid/models", companyModelsRouter);
app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
app.use("/api/companies/:cid/employees", employeesRouter);
app.use(errorHandler);
const api: Server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

// ---------- Chrome ----------

console.log("Company models: building the pages.");
const fixture = await startBrowserFixture("companyModelsHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const pageErrors: string[] = [];
const responses: string[] = [];
const requested: string[] = [];
let actingUser = owner.id;

async function open(
  options: {
    view?: "company" | "employee";
    employee?: AIEmployee;
    role?: "owner" | "member";
    width?: number;
    scheme?: "light" | "dark";
  } = {},
): Promise<Page> {
  actingUser = options.role === "member" ? member.id : owner.id;
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1100, height: 1000 },
    colorScheme: options.scheme ?? "light",
  });
  await context.routeWebSocket(/\/api\/ws\?/, () => undefined);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("ws-token")) return route.fulfill({ json: { token: "fixture" } });
    if (!url.pathname.startsWith(`/api/companies/${company.id}/`)) {
      return route.fulfill({ json: [] });
    }
    requested.push(`${request.method()} ${url.pathname.replace(`/api/companies/${company.id}`, "")}`);
    const forwarded = await fetch(`${apiBase}${url.pathname}${url.search}`, {
      method: request.method(),
      headers: { "content-type": "application/json", "x-test-user": actingUser },
      body: request.postData() ?? undefined,
    });
    const body = await forwarded.text();
    responses.push(body);
    await route.fulfill({
      status: forwarded.status,
      headers: { "content-type": forwarded.headers.get("content-type") ?? "application/json" },
      body,
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("close", () => void context.close());
  const target = options.employee ?? ada;
  const query = new URLSearchParams({
    view: options.view ?? "company",
    cid: company.id,
    role: options.role ?? "owner",
    eid: target.id,
    name: target.name,
  });
  await page.goto(`${fixture.origin}/?${query}`, { waitUntil: "commit", timeout: 120_000 });
  await page.locator("main h1").first().waitFor({ timeout: 120_000 });
  return page;
}

const CLAUDE = "Claude (Anthropic) · claude-opus-5-5";
const card = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const chips = (scope: Locator) =>
  scope.getByRole("list", { name: "AI Employees using this AI Model" }).getByRole("listitem");

/** Each chip's name and whose active model it is: "Ada · active". */
async function chipNames(scope: Locator): Promise<string[]> {
  return chips(scope).evaluateAll((items) =>
    items.map((item) => {
      const name = item.querySelector("a")?.textContent ?? "";
      const status = [...item.querySelectorAll("span")]
        .map((span) => span.textContent ?? "")
        .find((text) => text.startsWith("·"));
      return `${name.trim()} ${(status ?? "").trim()}`.trim();
    }),
  );
}

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `${label} scrolls sideways by ${overflow}px`);
}

/** 0 for black, 1 for white: the relative brightness of a CSS rgb() colour. */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

const attachedTo = async (modelId: string) =>
  (await AppDataSource.getRepository(EmployeeModel).findBy({ modelId }))
    .map((row) => row.employeeId)
    .sort();

let checks = 0;
let page: Page | null = null;
try {
  await fs.mkdir(artifacts, { recursive: true });

  // ── Settings → AI Models lists every model and who uses it ───────────────────
  page = await open();
  await page.getByRole("heading", { name: "AI Models", exact: true }).waitFor();
  const claudeCard = card(page, CLAUDE);
  await claudeCard.waitFor();
  await claudeCard.getByText("Not used by any AI Employee yet", { exact: true }).waitFor();
  const linusCard = card(page, "OpenAI · gpt-5.5");
  assert.deepEqual(await chipNames(linusCard), ["Linus · active"]);
  // Newest first: Linus's model was added after the company's Claude.
  assert.equal(await page.getByRole("group").first().locator("h3").innerText(), "OpenAI · gpt-5.5");
  await page.getByRole("button", { name: "Add an AI Model", exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "company-models-list.png"), fullPage: true });
  checks++;

  // ── Attach one model to two AI Employees ─────────────────────────────────────
  await claudeCard.getByRole("button", { name: "Attach to AI Employees", exact: true }).click();
  await claudeCard.getByRole("checkbox", { name: "Attach to Ada" }).waitFor();
  // Each candidate says what it runs on now.
  await claudeCard.getByText("Now on OpenAI · gpt-5.5", { exact: true }).waitFor();
  await claudeCard.getByText("No AI Model yet", { exact: true }).first().waitFor();
  await claudeCard.getByRole("checkbox", { name: "Attach to Ada" }).check();
  await claudeCard.getByRole("checkbox", { name: "Attach to Grace" }).check();
  const attachButton = claudeCard.getByRole("button", {
    name: "Attach to Ada and Grace",
    exact: true,
  });
  await attachButton.waitFor();
  await page.screenshot({ path: path.join(artifacts, "company-models-attach.png"), fullPage: true });
  await attachButton.click();
  await claudeCard.getByRole("checkbox", { name: "Attach to Ada" }).waitFor({ state: "detached" });
  await chips(claudeCard).filter({ hasText: "Grace" }).waitFor();
  assert.deepEqual(await chipNames(claudeCard), ["Ada · active", "Grace · active"]);
  // The panel closed: only Linus is left to offer, next time it opens.
  assert.equal(await claudeCard.getByRole("checkbox").count(), 0);
  checks++;

  // Both run on it: one row, one key, and each resolves it as its brain.
  assert.deepEqual(await attachedTo(claude.id), [ada.id, grace.id].sort());
  assert.equal(await AppDataSource.getRepository(AIModel).count(), 2);
  assert.equal((await getActiveModel(ada.id))?.id, claude.id);
  assert.equal((await getActiveModel(grace.id))?.id, claude.id);
  checks++;
  await page.close();

  // ── Each employee's Model page shows the shared model, and who shares it ─────
  for (const [employee, other] of [
    [ada, "Grace"],
    [grace, "Ada"],
  ] as const) {
    page = await open({ view: "employee", employee });
    const own = card(page, CLAUDE);
    await own.waitFor();
    await own.getByText(`Also used by ${other}`, { exact: true }).waitFor();
    await own.getByRole("button", { name: /^Advanced/ }).click();
    await own.getByText(`Also used by ${other}. A change here changes it for them too.`).waitFor();
    await page.close();
  }
  checks++;

  // ── Detach it from one; it stays, and the other keeps it ────────────────────
  page = await open();
  await card(page, CLAUDE).getByRole("button", { name: "Detach from Grace", exact: true }).click();
  const confirm = page.getByRole("dialog");
  await confirm.getByText("Detach this AI Model from Grace?").waitFor();
  await confirm.getByText(/stays in Settings → AI Models, and Ada keeps using it/).waitFor();
  await confirm.getByRole("button", { name: "Detach", exact: true }).click();
  await card(page, CLAUDE).getByRole("button", { name: "Detach from Grace" }).waitFor({
    state: "detached",
  });
  assert.deepEqual(await chipNames(card(page, CLAUDE)), ["Ada · active"]);
  assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: claude.id }));
  assert.deepEqual(await attachedTo(claude.id), [ada.id]);
  assert.equal(await getActiveModel(grace.id), null);
  assert.equal((await getActiveModel(ada.id))?.id, claude.id);
  checks++;
  await page.close();

  // Grace's page now offers the company's models back, each one click away: the
  // newest leads, and the one she just left is among the others.
  page = await open({ view: "employee", employee: grace });
  await page.getByRole("button", { name: "Use the same AI Model as Linus", exact: true }).waitFor();
  await page.getByRole("button", { name: "Connect a different model", exact: true }).click();
  const offer = page.getByRole("listitem").filter({ hasText: CLAUDE });
  await offer.getByText(/^Used by Ada/).waitFor();
  await offer.getByRole("button", { name: "Use this one", exact: true }).waitFor();
  await page.close();
  checks++;

  // ── Removing a model in use is asked first, naming who it would strand ───────
  page = await open();
  const inUse = card(page, CLAUDE);
  await inUse.getByRole("button", { name: /^Advanced/ }).click();
  await inUse
    .getByRole("region", { name: "Remove from the company", exact: true })
    .getByRole("button", { name: "Remove" })
    .click();
  const removal = page.getByRole("dialog");
  await removal.getByText("Remove an AI Model Ada uses?").waitFor();
  await removal.getByText(/Ada has no other AI Model and stops working until one is attached/).waitFor();
  await removal.getByRole("button", { name: "Detach and remove", exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "company-models-remove.png"), fullPage: true });
  await removal.getByRole("button", { name: "Cancel", exact: true }).click();
  await removal.waitFor({ state: "detached" });
  assert.ok(await AppDataSource.getRepository(AIModel).findOneBy({ id: claude.id }));
  assert.deepEqual(await attachedTo(claude.id), [ada.id]);
  checks++;
  await page.close();

  // ── Copies of one key are offered for merging, and merge into one ────────────
  const copy = await insert(AIModel, {
    companyId: company.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    configJson: writeApiKeys("{}", [newStoredApiKey(SHARED_KEY, company.id)]),
    connectedAt: day(3),
    createdAt: day(3),
  });
  await attachExistingModel({ employeeId: linus.id, modelId: copy.id, isActive: true });
  page = await open();
  const notice = page.getByRole("status").filter({ hasText: "2 copies of" });
  await notice.getByText(`2 copies of ${CLAUDE} with the same keys`).waitFor();
  await notice.getByText(/Used by Ada and Linus/).waitFor();
  await notice.getByRole("button", { name: "Merge into one", exact: true }).click();
  const merge = page.getByRole("dialog");
  await merge.getByText(`Merge 2 copies of ${CLAUDE}?`).waitFor();
  await merge.getByRole("button", { name: "Merge into one", exact: true }).click();
  await notice.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("group", { name: CLAUDE, exact: true }).count(), 1);
  assert.equal(await AppDataSource.getRepository(AIModel).findOneBy({ id: copy.id }), null);
  assert.deepEqual(await attachedTo(claude.id), [ada.id, linus.id].sort());
  assert.equal((await getActiveModel(linus.id))?.id, claude.id);
  assert.deepEqual(await chipNames(card(page, CLAUDE)), ["Ada · active", "Linus · active"]);
  checks++;

  // ── A phone: the cards, chips and attach panel fit ───────────────────────────
  await page.close();
  page = await open({ width: 375 });
  await card(page, CLAUDE).waitFor();
  await noSidewaysScroll(page, "Settings → AI Models at 375px");
  await card(page, CLAUDE).getByRole("button", { name: "Attach to AI Employees" }).click();
  await card(page, CLAUDE).getByRole("checkbox", { name: "Attach to Grace" }).waitFor();
  await noSidewaysScroll(page, "the attach panel at 375px");
  await page.screenshot({ path: path.join(artifacts, "company-models-phone.png"), fullPage: true });
  checks++;
  await page.close();

  // ── Dark mode ────────────────────────────────────────────────────────────────
  page = await open({ scheme: "dark" });
  await card(page, CLAUDE).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    true,
  );
  const background = await card(page, CLAUDE).evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  assert.ok(luminance(background) < 0.2, `the card is drawn ${background}`);
  const heading = await card(page, CLAUDE)
    .locator("h3")
    .evaluate((element) => getComputedStyle(element).color);
  assert.ok(luminance(heading) > 0.6, `text on the dark card is ${heading}`);
  await page.screenshot({ path: path.join(artifacts, "company-models-dark.png"), fullPage: true });
  checks++;
  await page.close();

  // ── A Member is told the page is for owners and admins ───────────────────────
  const before = requested.length;
  page = await open({ role: "member" });
  await page.getByText("Only owners and admins manage AI Models", { exact: true }).waitFor();
  assert.equal(await page.getByRole("group").count(), 0);
  assert.deepEqual(
    requested.slice(before).filter((line) => line.startsWith("GET /models")),
    [],
    "the closed page never asks for what could only answer 403",
  );
  checks++;
  await page.close();
  page = null;

  // Nothing secret ever came back to the browser.
  for (const body of responses) {
    for (const secret of EVERY_SECRET) assert.ok(!body.includes(secret), "a response carried a key");
    for (const field of ["apiKeyEncrypted", "configJson"]) {
      assert.ok(!body.includes(field), `a response carried ${field}`);
    }
  }
  assert.deepEqual(pageErrors, []);
  checks++;
  console.log(`Company models: ${checks} browser checks passed.`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: path.join(artifacts, "company-models-failure.png"), fullPage: true })
      .catch(() => undefined);
    const body = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "No page body rendered.");
    await fs.writeFile(
      path.join(artifacts, "company-models-failure.txt"),
      `${String(error)}\n${pageErrors.join("\n")}\n${body}`,
    );
  }
  throw error;
} finally {
  await browser.close();
  await fixture.close();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await closeTestDb();
}
