/** Real-Chrome regression coverage for the public Base Form experience. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { chromium, type Page, type Route } from "playwright-core";

import { config } from "../config";
import type { PublicBaseForm } from "../client/lib/api";
import { AppDataSource } from "../server/db/datasource";
import { Base } from "../server/db/entities/Base";
import { BaseField } from "../server/db/entities/BaseField";
import { BaseFormSubmission } from "../server/db/entities/BaseFormSubmission";
import { BaseRecord } from "../server/db/entities/BaseRecord";
import { BaseTable } from "../server/db/entities/BaseTable";
import { Company } from "../server/db/entities/Company";
import { User } from "../server/db/entities/User";
import { resetInstanceSecretsCacheForTests } from "../server/lib/instanceSecrets";
import { errorHandler } from "../server/middleware/error";
import { createBaseForm, updateBaseForm } from "../server/services/baseForms";
import { closeTestDb, initTestDb, insert } from "../server/test/dbHarness";
import {
  publicFormsRouter,
  resetPublicFormSubmitThrottleForTests,
} from "../server/routes/publicForms";
import { startBrowserFixture } from "./browserFixture";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.resolve(appRoot, "../output/playwright");
const repositoryManagedSecretPaths = [
  path.join(appRoot, "data", ".instance-secrets.json"),
  path.join(appRoot, "data", ".instance-secrets.required"),
] as const;

async function repositoryManagedSecretSnapshot() {
  return Promise.all(
    repositoryManagedSecretPaths.map(async (secretPath) => {
      try {
        const [contents, stats] = await Promise.all([fs.readFile(secretPath), fs.stat(secretPath)]);
        return {
          path: path.basename(secretPath),
          exists: true as const,
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          digest: createHash("sha256").update(contents).digest("hex"),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { path: path.basename(secretPath), exists: false as const };
        }
        throw error;
      }
    }),
  );
}

type ManagedSecretIsolation = {
  dataDir: string;
  close: () => Promise<void>;
};

async function isolateManagedSecrets(): Promise<ManagedSecretIsolation> {
  const mutableConfig = config as { dataDir: string };
  const originalDataDir = mutableConfig.dataDir;
  let dataDir = "";
  try {
    const repositorySecretsBefore = await repositoryManagedSecretSnapshot();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-forms-browser-secrets-"));
    mutableConfig.dataDir = dataDir;
    resetInstanceSecretsCacheForTests();
    let closed = false;
    return {
      dataDir,
      async close() {
        if (closed) return;
        closed = true;
        mutableConfig.dataDir = originalDataDir;
        resetInstanceSecretsCacheForTests();
        await fs.rm(dataDir, { recursive: true, force: true });
        assert.deepEqual(
          await repositoryManagedSecretSnapshot(),
          repositorySecretsBefore,
          "the Forms browser suite must leave App/data managed-secret files untouched",
        );
      },
    };
  } catch (error) {
    mutableConfig.dataDir = originalDataDir;
    resetInstanceSecretsCacheForTests();
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

type RealFormsApi = {
  origin: string;
  token: string;
  companyId: string;
  formId: string;
  tableId: string;
  fields: { name: BaseField; seats: BaseField; plan: BaseField };
  questions: { name: string; seats: string; plan: string };
  close: () => Promise<void>;
};

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function startRealFormsApi(): Promise<RealFormsApi> {
  await initTestDb();
  let apiServer: Server | null = null;
  try {
    resetPublicFormSubmitThrottleForTests();
    const owner = await insert(User, {
      email: `forms-browser-${randomUUID()}@example.test`,
      name: "Forms browser owner",
      passwordHash: "x",
      sessionVersion: 0,
    });
    const company = await insert(Company, {
      name: "Real Forms Company",
      slug: `real-forms-${randomUUID()}`,
      ownerId: owner.id,
    });
    const base = await insert(Base, {
      companyId: company.id,
      name: "Leads",
      slug: "leads",
      color: "emerald",
      createdById: owner.id,
    });
    const table = await insert(BaseTable, {
      baseId: base.id,
      name: "Inbound",
      slug: "inbound",
      sortOrder: 1_000,
      archivedAt: null,
    });
    const fields = {
      name: await insert(BaseField, {
        tableId: table.id,
        name: "Name",
        type: "text",
        configJson: "{}",
        isPrimary: true,
        sortOrder: 1_000,
      }),
      seats: await insert(BaseField, {
        tableId: table.id,
        name: "Seats",
        type: "number",
        configJson: "{}",
        isPrimary: false,
        sortOrder: 2_000,
      }),
      plan: await insert(BaseField, {
        tableId: table.id,
        name: "Plan",
        type: "select",
        configJson: JSON.stringify({
          options: [
            { id: "starter", label: "Starter", color: "slate" },
            { id: "growth", label: "Growth", color: "emerald" },
          ],
        }),
        isPrimary: false,
        sortOrder: 3_000,
      }),
    };
    const created = await createBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: table.id,
      title: "Real submission",
      actorUserId: owner.id,
    });
    const questions = {
      name: randomUUID(),
      seats: randomUUID(),
      plan: randomUUID(),
    };
    const published = await updateBaseForm({
      companyId: company.id,
      baseSlug: base.slug,
      tableId: table.id,
      formSlug: created.form.slug,
      actorUserId: owner.id,
      patch: {
        submitLabel: "Create Base row",
        successTitle: "Row created",
        successMessage: "This response passed through the real public Forms API.",
        questions: [
          {
            id: questions.name,
            fieldId: fields.name.id,
            label: "Contact name",
            description: "Written to the Name field.",
            required: true,
          },
          {
            id: questions.seats,
            fieldId: fields.seats.id,
            label: "Seat count",
            description: "Written as a number.",
            required: true,
          },
          {
            id: questions.plan,
            fieldId: fields.plan.id,
            label: "Requested plan",
            description: "Written as the choice id.",
            required: true,
          },
        ],
        published: true,
      },
    });
    assert.ok(published.form.publicUrl);
    const token = new URL(published.form.publicUrl).pathname.split("/").pop();
    assert.ok(token);

    const app = express();
    app.use(express.json({ limit: "1mb" }));
    app.use("/api/forms", publicFormsRouter);
    app.use(errorHandler);
    const listeningServer = await new Promise<Server>((resolve) => {
      const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
    });
    apiServer = listeningServer;
    const address = listeningServer.address();
    if (!address || typeof address === "string") throw new Error("Real Forms API did not start");
    let closed = false;
    return {
      origin: `http://127.0.0.1:${(address as AddressInfo).port}`,
      token,
      companyId: company.id,
      formId: published.form.id,
      tableId: table.id,
      fields,
      questions,
      async close() {
        if (closed) return;
        closed = true;
        if (apiServer) await closeServer(apiServer);
        await closeTestDb();
      },
    };
  } catch (error) {
    if (apiServer) await closeServer(apiServer).catch(() => undefined);
    await closeTestDb().catch(() => undefined);
    throw error;
  }
}

const managedSecrets = await isolateManagedSecrets();
const realApi = await startRealFormsApi().catch(async (error) => {
  await managedSecrets.close().catch(() => undefined);
  throw error;
});

async function closeRealTestState(): Promise<void> {
  const apiCleanup = await Promise.allSettled([realApi.close()]);
  const secretCleanup = await Promise.allSettled([managedSecrets.close()]);
  const failure = [...apiCleanup, ...secretCleanup].find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

const server = await startBrowserFixture("baseFormsBrowserHarness.tsx", 18494).catch(
  async (error) => {
    await closeRealTestState().catch(() => undefined);
    throw error;
  },
);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await Promise.allSettled([server.close(), closeRealTestState()]);
    throw error;
  });
const context = await browser
  .newContext({ viewport: { width: 1180, height: 900 } })
  .catch(async (error) => {
    await Promise.allSettled([browser.close(), server.close(), closeRealTestState()]);
    throw error;
  });

const ids = {
  name: "00000000-0000-4000-8000-000000000001",
  request: "00000000-0000-4000-8000-000000000002",
  size: "00000000-0000-4000-8000-000000000003",
  consent: "00000000-0000-4000-8000-000000000004",
  date: "00000000-0000-4000-8000-000000000005",
  datetime: "00000000-0000-4000-8000-000000000006",
  email: "00000000-0000-4000-8000-000000000007",
  website: "00000000-0000-4000-8000-000000000008",
  region: "00000000-0000-4000-8000-000000000009",
  topics: "00000000-0000-4000-8000-000000000010",
} as const;

const openForm: PublicBaseForm = {
  companyName: "Northwind",
  color: "violet",
  title: "Product inquiry",
  description: "Tell us what you need and the right team will follow up.",
  submitLabel: "Send inquiry",
  successTitle: "Inquiry received",
  successMessage: "Thanks — the Northwind team has your response.",
  allowAnotherResponse: true,
  acceptingResponses: true,
  questions: [
    {
      id: ids.name,
      label: "Full name",
      description: "How should we address you?",
      required: true,
      type: "text",
      options: [],
    },
    {
      id: ids.request,
      label: "Tell us about your request",
      description: "A few sentences is plenty.",
      required: false,
      type: "longtext",
      options: [],
    },
    {
      id: ids.size,
      label: "Team size",
      description: "An estimate is fine.",
      required: true,
      type: "number",
      options: [],
    },
    {
      id: ids.consent,
      label: "I agree to be contacted",
      description: "Required before we can reply.",
      required: true,
      type: "checkbox",
      options: [],
    },
    {
      id: ids.date,
      label: "Preferred date",
      description: "Optional.",
      required: false,
      type: "date",
      options: [],
    },
    {
      id: ids.datetime,
      label: "Preferred date and time",
      description: "Optional.",
      required: false,
      type: "datetime",
      options: [],
    },
    {
      id: ids.email,
      label: "Email address",
      description: "We will only use this to reply.",
      required: true,
      type: "email",
      options: [],
    },
    {
      id: ids.website,
      label: "Website",
      description: "Include http or https.",
      required: true,
      type: "url",
      options: [],
    },
    {
      id: ids.region,
      label: "Region",
      description: "Choose the team closest to you.",
      required: true,
      type: "select",
      options: [
        { id: "emea", label: "EMEA", color: "indigo" },
        { id: "americas", label: "Americas", color: "emerald" },
      ],
    },
    {
      id: ids.topics,
      label: "Topics",
      description: "Choose any that apply.",
      required: false,
      type: "multiselect",
      options: [
        { id: "product", label: "Product", color: "violet" },
        { id: "pricing", label: "Pricing", color: "amber" },
      ],
    },
  ],
};

type Submission = { submissionId: string; values: Record<string, unknown> };
const submissions: Submission[] = [];
let rejectNextSubmission = false;
let holdNextSubmission = false;
let releaseSubmission: (() => void) | null = null;
const pageErrors: string[] = [];
const failedAssets: string[] = [];
let currentPage: Page | null = null;

async function handleFormsRoute(route: Route) {
  const url = new URL(route.request().url());
  const token = url.pathname.split("/")[3] ?? "";
  if (token === realApi.token) {
    const response = await route.fetch({
      url: `${realApi.origin}${url.pathname}${url.search}`,
    });
    return route.fulfill({ response });
  }
  if (route.request().method() === "GET") {
    if (token === "unavailable") {
      return route.fulfill({
        status: 404,
        json: { error: "internal fixture details must not appear" },
      });
    }
    return route.fulfill({
      json: token === "closed" ? { ...openForm, acceptingResponses: false } : openForm,
    });
  }
  if (route.request().method() === "POST" && url.pathname.endsWith("/responses")) {
    submissions.push(route.request().postDataJSON() as Submission);
    if (holdNextSubmission) {
      holdNextSubmission = false;
      await new Promise<void>((resolve) => {
        releaseSubmission = resolve;
      });
      releaseSubmission = null;
    }
    if (rejectNextSubmission) {
      rejectNextSubmission = false;
      return route.fulfill({
        status: 503,
        json: { error: "The Form service is temporarily unavailable. Please try again." },
      });
    }
    return route.fulfill({ json: { ok: true } });
  }
  return route.fulfill({ status: 404, json: { error: "Not found" } });
}

function watch(page: Page) {
  currentPage = page;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) {
      failedAssets.push(`${pathname}: ${request.failure()?.errorText ?? "request failed"}`);
    }
  });
}

async function open(
  mode: "open" | "closed" | "unavailable" | "real",
  page = context.pages()[0],
) {
  const current = page ?? (await context.newPage());
  watch(current);
  const search = new URLSearchParams({ mode });
  if (mode === "real") search.set("token", realApi.token);
  await current.goto(`${server.origin}/?${search}`, { waitUntil: "commit", timeout: 120_000 });
  await current.locator("header").waitFor({ timeout: 180_000 });
  return current;
}

async function waitForHeldSubmission() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (releaseSubmission) return;
    if (Date.now() > deadline) throw new Error("The held Form submission never reached the API.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function continueHeldSubmission() {
  const release = releaseSubmission as (() => void) | null;
  if (!release) throw new Error("No held Form submission is ready to continue.");
  release();
}

async function captureFailureScreenshot() {
  const page = currentPage as Page | null;
  if (!page || page.isClosed()) return;
  await page.screenshot({
    path: path.join(artifacts, "base-forms-browser-failed.png"),
    fullPage: true,
  });
}

async function fillRequired(page: Page, suffix: string) {
  await page.locator(`#form-question-control-${ids.name}`).fill(`Ada ${suffix}`);
  await page.locator(`#form-question-control-${ids.size}`).fill("42");
  await page.locator(`#form-question-control-${ids.consent}`).check();
  await page.locator(`#form-question-control-${ids.email}`).fill(`ada-${suffix}@example.test`);
  await page.locator(`#form-question-control-${ids.website}`).fill("https://example.test");
  await page.getByText("EMEA", { exact: true }).click();
}

let checks = 0;
let runError: unknown = null;
let cleanupError: unknown = null;
try {
  await context.route("**/api/forms/**", handleFormsRoute);
  await fs.mkdir(artifacts, { recursive: true });
  const isolatedSecretFiles = await fs.readdir(managedSecrets.dataDir);
  assert.ok(isolatedSecretFiles.includes(".instance-secrets.json"));
  assert.ok(isolatedSecretFiles.includes(".instance-secrets.required"));
  let page = await context.newPage();
  page = await open("open", page);
  await page.getByRole("heading", { level: 1, name: "Product inquiry" }).waitFor();
  assert.equal(await page.getByText("Form by Northwind", { exact: true }).count(), 1);
  checks++;

  const progress = page.getByRole("progressbar", { name: "Required questions completed" });
  assert.equal(await progress.getAttribute("aria-valuemin"), "0");
  assert.equal(await progress.getAttribute("aria-valuemax"), "6");
  assert.equal(await progress.getAttribute("aria-valuenow"), "0");
  checks++;

  // Empty submission reports all required fields at once, then places focus
  // at the first invalid answer rather than leaving keyboard users behind.
  await page.getByRole("button", { name: "Send inquiry", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Complete the highlighted questions" })
    .waitFor();
  assert.equal(
    await page.locator('[id^="public-form-question-"] [role="alert"]').count(),
    6,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    `form-question-control-${ids.name}`,
  );
  checks++;

  // Bad values keep their field-specific guidance while blank optional
  // answers remain valid.
  await page.locator(`#form-question-control-${ids.email}`).fill("not-an-email");
  await page.locator(`#form-question-control-${ids.website}`).fill("example.test");
  await page.getByRole("button", { name: "Send inquiry", exact: true }).click();
  assert.equal(
    await page.locator(`#public-form-question-${ids.email}`).getByText("Enter a valid email address.").count(),
    1,
  );
  assert.equal(
    await page.locator(`#public-form-question-${ids.website}`).getByText("Enter a complete URL.").count(),
    1,
  );
  checks++;

  await fillRequired(page, "first");
  await page.locator(`#form-question-control-${ids.request}`).fill("We need a polished intake flow.");
  await page.locator(`#form-question-control-${ids.date}`).fill("2026-10-20");
  await page.locator(`#form-question-control-${ids.datetime}`).fill("2026-10-20T14:30");
  await page.getByText("Product", { exact: true }).click();
  await page.getByText("Pricing", { exact: true }).click();
  assert.equal(await progress.getAttribute("aria-valuenow"), "6");
  checks++;

  // Every answer family should arrive in the shape Base rows expect.
  holdNextSubmission = true;
  await page.getByRole("button", { name: "Send inquiry", exact: true }).click();
  await page.getByRole("button", { name: "Submitting…", exact: true }).waitFor();
  await waitForHeldSubmission();
  assert.equal(await page.getByRole("button", { name: "Submitting…" }).isDisabled(), true);
  assert.equal(await page.locator(`#form-question-control-${ids.name}`).isDisabled(), true);
  continueHeldSubmission();
  await page.getByRole("heading", { level: 1, name: "Inquiry received" }).waitFor();
  const first = submissions.at(-1);
  assert.ok(first);
  assert.match(first.submissionId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(first.values, {
    [ids.name]: "Ada first",
    [ids.request]: "We need a polished intake flow.",
    [ids.size]: 42,
    [ids.consent]: true,
    [ids.date]: "2026-10-20",
    [ids.datetime]: "2026-10-20T14:30",
    [ids.email]: "ada-first@example.test",
    [ids.website]: "https://example.test",
    [ids.region]: "emea",
    [ids.topics]: ["product", "pricing"],
  });
  checks++;

  assert.equal(
    await page.evaluate(() => document.activeElement?.textContent),
    "Inquiry received",
  );
  assert.equal(
    await page.getByText("Thanks — the Northwind team has your response.", { exact: true }).count(),
    1,
  );
  checks++;

  // Starting another response clears every control and allocates a new
  // idempotency id. A failed retry keeps that new id and preserves answers.
  await page.getByRole("button", { name: "Submit another response", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "Product inquiry" }).waitFor();
  assert.equal(await page.locator(`#form-question-control-${ids.name}`).inputValue(), "");
  assert.equal(await page.locator(`#form-question-control-${ids.consent}`).isChecked(), false);
  assert.equal(await page.getByRole("checkbox", { name: "Product", exact: true }).isChecked(), false);
  checks++;

  await fillRequired(page, "retry");
  rejectNextSubmission = true;
  await page.getByRole("button", { name: "Send inquiry", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "temporarily unavailable. Please try again" })
    .waitFor();
  assert.equal(await page.locator(`#form-question-control-${ids.name}`).inputValue(), "Ada retry");
  const failed = submissions.at(-1);
  assert.ok(failed);
  await page.getByRole("button", { name: "Send inquiry", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "Inquiry received" }).waitFor();
  const retried = submissions.at(-1);
  assert.ok(retried);
  assert.equal(retried.submissionId, failed.submissionId);
  assert.notEqual(retried.submissionId, first.submissionId);
  checks++;
  await page.close();

  // One path deliberately leaves the deterministic browser mocks: the real
  // React screen calls the production public router over HTTP, whose service
  // writes both the Base row and its idempotency lineage into an in-memory DB.
  page = await context.newPage();
  page = await open("real", page);
  await page.getByRole("heading", { level: 1, name: "Real submission" }).waitFor();
  assert.equal(await page.getByText("Form by Real Forms Company", { exact: true }).count(), 1);
  await page.locator(`#form-question-control-${realApi.questions.name}`).fill("Grace Hopper");
  await page.locator(`#form-question-control-${realApi.questions.seats}`).fill("12");
  await page.getByText("Growth", { exact: true }).click();
  await page.getByRole("button", { name: "Create Base row", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "Row created" }).waitFor();

  const rows = await AppDataSource.getRepository(BaseRecord).findBy({ tableId: realApi.tableId });
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].dataJson), {
    [realApi.fields.name.id]: "Grace Hopper",
    [realApi.fields.seats.id]: 12,
    [realApi.fields.plan.id]: "growth",
  });
  const lineage = await AppDataSource.getRepository(BaseFormSubmission).findBy({
    formId: realApi.formId,
  });
  assert.equal(lineage.length, 1);
  assert.equal(lineage[0].companyId, realApi.companyId);
  assert.equal(lineage[0].recordId, rows[0].id);
  assert.match(
    lineage[0].clientSubmissionId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  checks++;
  await page.close();

  page = await context.newPage();
  page = await open("closed", page);
  await page
    .getByRole("heading", { level: 1, name: "This form is not accepting responses" })
    .waitFor();
  assert.equal(await page.getByText("Form by Northwind", { exact: true }).count(), 1);
  assert.equal(await page.locator("form").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Send inquiry" }).count(), 0);
  checks++;
  await page.close();

  page = await context.newPage();
  page = await open("unavailable", page);
  await page.getByRole("heading", { level: 1, name: "This form is unavailable" }).waitFor();
  assert.doesNotMatch(await page.locator("body").innerText(), /internal fixture details/i);
  assert.match(await page.locator("body").innerText(), /Ask the sender for a new link/i);
  checks++;
  await page.close();

  // The actual public screen, at a narrow phone viewport: no clipped cards,
  // every native input labelled, and both custom choice groups named.
  page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 740 });
  page = await open("open", page);
  await page.getByRole("heading", { level: 1, name: "Product inquiry" }).waitFor();
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    true,
  );
  const accessibility = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type="hidden"]), textarea',
    ));
    const unlabeled = controls.filter(
      (control) => control.labels?.length === 0 && !control.getAttribute("aria-labelledby"),
    );
    const choiceGroups = Array.from(document.querySelectorAll("fieldset"));
    return {
      controls: controls.length,
      unlabeled: unlabeled.map((control) => control.id || control.type),
      unnamedGroups: choiceGroups.filter((group) => !group.getAttribute("aria-labelledby")).length,
      questionCards: document.querySelectorAll('[id^="public-form-question-"]').length,
    };
  });
  assert.deepEqual(accessibility, {
    controls: 12,
    unlabeled: [],
    unnamedGroups: 0,
    questionCards: 10,
  });
  checks++;
  await page.screenshot({ path: path.join(artifacts, "base-forms-mobile.png"), fullPage: true });
  await page.close();

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(failedAssets, []);
  checks++;
  console.log(`PASS ${checks} public Base Forms browser regression groups`);
} catch (error) {
  runError = error;
  await captureFailureScreenshot();
  throw error;
} finally {
  const browserCleanup = await Promise.allSettled([browser.close(), server.close()]);
  const realCleanup = await Promise.allSettled([closeRealTestState()]);
  const cleanup = [...browserCleanup, ...realCleanup];
  if (!runError) {
    const failure = cleanup.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") cleanupError = failure.reason;
  }
}
if (cleanupError) throw cleanupError;
