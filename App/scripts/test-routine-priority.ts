/**
 * Real Chrome over the real App and the real server: an owner marks a Routine
 * High priority in its settings and watches the queue reorder — on Running,
 * in the Routines list, and in the AI Employee's day on Home — then sets it
 * back. The page is the whole App (`appHarness.tsx`); every `/api` request
 * goes to `createApp()` on a private in-memory database, signed in with a real
 * session cookie. The Routine queue is held, so the seeded Runs stay waiting
 * and no AI Model is called. Run with `npm run test:routine-priority`.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createApp } from "../server/app";
import { AppDataSource } from "../server/db/datasource";
import { AIEmployee } from "../server/db/entities/AIEmployee";
import { AIModel } from "../server/db/entities/AIModel";
import { Company } from "../server/db/entities/Company";
import { Membership } from "../server/db/entities/Membership";
import { Routine } from "../server/db/entities/Routine";
import { Run } from "../server/db/entities/Run";
import { User } from "../server/db/entities/User";
import { encryptSecret } from "../server/lib/secret";
import { errorHandler } from "../server/middleware/error";
import { setPublicUrl } from "../server/services/publicUrl";
import { stopRoutineQueue } from "../server/services/routineQueue";
import { sessionCookieFor, withTestInstanceSecrets } from "../server/test/apiAccess";
import { closeTestDb, initTestDb, insert } from "../server/test/dbHarness";
import { startBrowserFixture } from "./browserFixture";
import { noSidewaysScroll } from "./appFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "../output/playwright");
const TIMEOUT = 90_000;

// ───────────────────── the real server, on a private database ─────────────────────

const restoreSecrets = withTestInstanceSecrets();
await initTestDb();
// Waiting Runs stay waiting: this suite is about the order, not the work.
stopRoutineQueue();

const owner = await insert(User, {
  email: "owner@oneuptime.example.test",
  name: "Nawaz Dhandala",
  handle: "nawaz",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const company = await insert(Company, { name: "OneUptime", slug: "oneuptime", ownerId: owner.id });
await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
const jamie = await insert(AIEmployee, {
  companyId: company.id,
  name: "Jamie Mallers",
  slug: "jamie",
  role: "VP of Go to Market",
  soulBody: "",
});
// A self-hosted model: one Run at a time, which is why the queue is long.
await insert(AIModel, {
  employeeId: jamie.id,
  provider: "custom",
  model: "Qwen/Qwen3.8-27B",
  authMode: "customEndpoint",
  isActive: true,
  connectedAt: new Date(),
  configJson: JSON.stringify({
    baseURLEncrypted: encryptSecret("http://127.0.0.1:11434/v1"),
    modelId: "Qwen/Qwen3.8-27B",
  }),
});

const HOUR = 60 * 60_000;
async function routineWaiting(name: string, hoursAgo: number) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const routine = await insert(Routine, {
    employeeId: jamie.id,
    name,
    slug,
    cronExpr: "0 9 * * *",
    body: `${name}.`,
    nextRunAt: new Date(Date.now() + 20 * HOUR),
  });
  const queuedAt = new Date(Date.now() - hoursAgo * HOUR);
  await insert(Run, {
    routineId: routine.id,
    employeeId: jamie.id,
    status: "queued",
    triggerKind: "schedule",
    startedAt: queuedAt,
    createdAt: queuedAt,
    logContent:
      "[queue] Waiting for the AI Model Qwen/Qwen3.8-27B: 1 Run is already using it, and it serves 1 at a time.\n",
  });
  return routine;
}

// The screenshot the owner sent, oldest first.
const QUEUE = [
  "Daily X DevOps & Observability Following",
  "Daily Nostr Helpful Replies",
  "Daily GitHub Lead Capture & Outreach",
  "Daily CRM Sync & Sales Update",
  "Incident.io Airgapped Prospecting",
];
const HOURS_AGO = [18, 17, 16.9, 6, 0.6];
const routines = new Map<string, Routine>();
for (const [index, name] of QUEUE.entries()) {
  routines.set(name, await routineWaiting(name, HOURS_AGO[index]));
}
const CRM = "Daily CRM Sync & Sales Update";
const crm = routines.get(CRM)!;

// The Run holding the model right now.
const working = await insert(Routine, {
  employeeId: jamie.id,
  name: "Enterprise Competitor Displacement Prospecting",
  slug: "enterprise-competitor-displacement-prospecting",
  cronExpr: "0 8 * * *",
  body: "Prospect.",
});
await insert(Run, {
  routineId: working.id,
  employeeId: jamie.id,
  status: "running",
  triggerKind: "schedule",
  startedAt: new Date(Date.now() - 40 * 60_000),
  queueActiveEmployeeId: `run:working:${Date.now()}`,
});

const app = createApp();
app.use(errorHandler);
const api: Server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
await setPublicUrl(apiBase);
const cookie = await sessionCookieFor(owner);

// ─────────────────────────────── Chrome ───────────────────────────────

console.log("Routine priority: building the App.");
const fixture = await startBrowserFixture("appHarness.tsx", 0);
let browser: Browser;
try {
  browser = await chromium.launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  });
} catch (error) {
  await fixture.close();
  throw error;
}
const pageErrors: string[] = [];
const writes: { method: string; path: string; body: string }[] = [];

async function newContext(width = 1280, height = 900): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(() => {
    localStorage.setItem("genosyn.pushPromptDismissed", "1");
  });
  // The live socket has no server here; the App backs off quietly.
  await context.routeWebSocket(/\/api\/ws/, () => undefined);
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postDataBuffer() ?? undefined;
    if (method !== "GET" && method !== "HEAD") {
      writes.push({ method, path: url.pathname, body: body?.toString("utf8") ?? "" });
    }
    try {
      const forwarded = await fetch(`${apiBase}${url.pathname}${url.search}`, {
        method,
        headers: {
          cookie,
          ...(request.headers()["content-type"]
            ? { "content-type": request.headers()["content-type"] }
            : {}),
        },
        body: method === "GET" || method === "HEAD" ? undefined : body,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      await route.fulfill({
        status: forwarded.status,
        headers: {
          "content-type": forwarded.headers.get("content-type") ?? "application/json",
        },
        body: Buffer.from(await forwarded.arrayBuffer()),
      });
    } catch {
      await route.fulfill({ status: 504, json: { error: "The test server did not answer." } });
    }
  });
  return context;
}

async function open(context: BrowserContext, appPath: string): Promise<Page> {
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  page.on("pageerror", (error) => pageErrors.push(`${appPath}: ${error.message}`));
  await page.goto(`${fixture.origin}/?path=${encodeURIComponent(appPath)}`, {
    waitUntil: "commit",
    timeout: TIMEOUT,
  });
  return page;
}

const queued = (page: Page) => page.getByRole("region", { name: "Queued", exact: true });
/** The mark a High priority Routine carries; screen readers hear "High priority". */
const HIGH_MARK = "High priority";

/** The Routines under Queued, top to bottom, once they read `expected`. */
async function expectQueue(page: Page, expected: string[]) {
  await page.waitForFunction(
    (names) => {
      const region = document.querySelector('section[aria-labelledby="queued-heading"]');
      const actual = Array.from(region?.querySelectorAll("a[aria-label]") ?? [], (link) =>
        link.getAttribute("aria-label")!.split(": view ")[0],
      );
      return JSON.stringify(actual) === JSON.stringify(names);
    },
    expected,
    { timeout: TIMEOUT },
  );
}

async function placeOf(page: Page, name: string): Promise<string> {
  const row = queued(page).getByRole("listitem").filter({ hasText: name });
  return (await row.locator("[aria-label^='Queue position']").innerText()).trim();
}

async function storedPriority(): Promise<string> {
  return (await AppDataSource.getRepository(Routine).findOneByOrFail({ id: crm.id })).priority;
}

async function waitForPriority(expected: string) {
  const deadline = Date.now() + TIMEOUT;
  while ((await storedPriority()) !== expected) {
    if (Date.now() > deadline) throw new Error(`The Routine never became ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Open the Routine's settings, choose `label` under Priority, and save. */
async function setPriority(context: BrowserContext, label: "High" | "Normal") {
  const page = await open(context, `/c/oneuptime/routines/jamie/${crm.slug}?tab=settings`);
  await page.getByLabel("Name", { exact: true }).waitFor();
  const advanced = page.getByRole("button", { name: /^Advanced/ });
  assert.equal(await advanced.getAttribute("aria-expanded"), "false", "Advanced starts closed");
  await advanced.click();
  const priority = page.getByRole("group", { name: "Priority", exact: true });
  await priority.waitFor();
  const choice = priority.getByRole("button", { name: label, exact: true });
  await choice.click();
  assert.equal(await choice.getAttribute("aria-pressed"), "true");
  await advanced
    .getByText(label === "High" ? /High priority/ : /All defaults/)
    .waitFor({ timeout: TIMEOUT });
  await priority
    .locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]")
    .screenshot({ path: path.join(artifacts, `routine-priority-setting-${label.toLowerCase()}.png`) });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await waitForPriority(label.toLowerCase());
  return page;
}

let checks = 0;
const failures: string[] = [];
async function check(name: string, work: () => Promise<void>) {
  try {
    await work();
    checks += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failures.push(name);
    console.error(`  ✗ ${name}`);
    console.error(error);
  }
}

try {
  await fs.mkdir(artifacts, { recursive: true });
  const context = await newContext();

  await check("Running lists the queue in start order, oldest first, with Next up", async () => {
    const page = await open(context, "/c/oneuptime/routines/running");
    await expectQueue(page, QUEUE);
    assert.equal(await placeOf(page, QUEUE[0]), "Next up");
    assert.equal(await placeOf(page, QUEUE[1]), "#2");
    assert.equal(await placeOf(page, CRM), "#4");
    await queued(page).getByText("In start order · High priority first", { exact: true }).waitFor();
    assert.equal(await queued(page).getByText(HIGH_MARK, { exact: true }).count(), 0);
    await page
      .getByRole("region", { name: "Running now", exact: true })
      .getByText("Enterprise Competitor Displacement Prospecting")
      .waitFor();
    await page.screenshot({ path: path.join(artifacts, "routine-priority-before.png"), fullPage: true });
    await page.close();
  });

  await check("marking the Routine High in its settings saves it and marks its header", async () => {
    const page = await setPriority(context, "High");
    const patch = writes.find(
      (write) => write.method === "PATCH" && write.path.endsWith(`/routines/${crm.id}`),
    );
    assert.ok(patch, "Save sent the Routine's settings");
    assert.equal((JSON.parse(patch.body) as { priority: string }).priority, "high");
    assert.equal("enabled" in JSON.parse(patch.body), false, "a Save never sends enabled");
    // The header marks it once the Routine reloads.
    const title = page.locator("h1", { hasText: CRM });
    await title.locator("xpath=..").getByText(HIGH_MARK, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, "routine-priority-settings.png"), fullPage: true });
    await page.close();
  });

  await check("Running now puts it next up, ahead of Runs queued hours before it", async () => {
    const page = await open(context, "/c/oneuptime/routines/running");
    await expectQueue(page, [CRM, QUEUE[0], QUEUE[1], QUEUE[2], QUEUE[4]]);
    assert.equal(await placeOf(page, CRM), "Next up");
    assert.equal(await placeOf(page, QUEUE[0]), "#2");
    const row = queued(page).getByRole("listitem").filter({ hasText: CRM });
    await row.getByText(HIGH_MARK, { exact: true }).waitFor();
    assert.equal(await queued(page).getByText(HIGH_MARK, { exact: true }).count(), 1);
    await page.screenshot({ path: path.join(artifacts, "routine-priority-after.png"), fullPage: true });
    await page.close();
  });

  await check("the Routines list marks it High, and only it", async () => {
    const page = await open(context, "/c/oneuptime/routines");
    const rowOf = (name: string) =>
      page
        .getByRole("listitem")
        .filter({ has: page.getByRole("link", { name, exact: true }) })
        .first();
    await rowOf(CRM).getByText(HIGH_MARK, { exact: true }).waitFor();
    for (const name of [QUEUE[0], QUEUE[4]]) {
      await rowOf(name).waitFor();
      assert.equal(await rowOf(name).getByText(HIGH_MARK, { exact: true }).count(), 0, name);
    }
    await page.close();
  });

  await check("Jamie's day lists the same order, with places counted across the company", async () => {
    const page = await open(context, "/c/oneuptime");
    const bubbles = page.getByRole("group", { name: "Open an AI employee's day", exact: true });
    await bubbles.getByRole("button").first().click();
    const day = page.getByRole("dialog");
    await day.getByRole("heading", { name: "Jamie Mallers's day", exact: true }).waitFor();
    const queue = day.getByRole("region", { name: "Routine Runs", exact: true });
    await queue.getByText("1 running · 5 pending", { exact: true }).waitFor();
    const pending = queue.getByRole("list", { name: "Pending Routines", exact: true });
    await page.waitForFunction(
      (expected) => {
        const list = document.querySelector('ol[aria-label="Pending Routines"]');
        const actual = Array.from(list?.querySelectorAll("a") ?? [], (link) => link.textContent);
        return JSON.stringify(actual) === JSON.stringify(expected);
      },
      [CRM, QUEUE[0], QUEUE[1], QUEUE[2], QUEUE[4]],
      { timeout: TIMEOUT },
    );
    const first = pending.getByRole("listitem").first();
    assert.equal(
      (await first.locator("[aria-label^='Queue position']").innerText()).trim(),
      "Next up",
    );
    await first.getByText(HIGH_MARK, { exact: true }).waitFor();
    await queue.getByText(/Waiting Runs start in this order, High priority first/).waitFor();
    await page.screenshot({ path: path.join(artifacts, "routine-priority-day.png"), fullPage: true });
    await page.close();
  });

  await check("setting it back to Normal puts it back in its turn", async () => {
    const settings = await setPriority(context, "Normal");
    await settings.close();
    const page = await open(context, "/c/oneuptime/routines/running");
    await expectQueue(page, QUEUE);
    assert.equal(await placeOf(page, CRM), "#4");
    assert.equal(await queued(page).getByText(HIGH_MARK, { exact: true }).count(), 0);
    await page.close();
  });

  await check("on a phone the queue still fits without scrolling sideways", async () => {
    const phone = await newContext(390, 844);
    const page = await open(phone, "/c/oneuptime/routines/running");
    await expectQueue(page, QUEUE);
    await noSidewaysScroll(page, "Running on a phone");
    await page.screenshot({ path: path.join(artifacts, "routine-priority-phone.png"), fullPage: true });
    await phone.close();
  });

  await context.close();
  try {
    assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
  } catch (error) {
    failures.push("no page errors");
    console.error(error);
  }
} finally {
  await browser.close();
  await fixture.close();
  api.closeAllConnections();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await closeTestDb();
  restoreSecrets();
}

console.log(`\n${checks} passed, ${failures.length} failed`);
if (failures.length) {
  console.error(`Failed: ${failures.join("; ")}`);
  process.exit(1);
}
