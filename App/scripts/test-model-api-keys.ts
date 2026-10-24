/**
 * Real Chrome over the real model routers: an owner adds several backup API
 * keys to a Claude AI Model, sees one refused at its test, removes one, moves
 * one up, and reads which key is failing — while a Member only reads. The
 * page is the real model section; every API call goes to the real router on a
 * private in-memory database. Only the model's connection test is stubbed, so
 * no provider is called and no live credential is needed.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium, type Page } from "playwright-core";
import { config } from "../config";
import { AppDataSource } from "../server/db/datasource";
import { AIEmployee } from "../server/db/entities/AIEmployee";
import { AIModel } from "../server/db/entities/AIModel";
import { AIModelKeyHealth } from "../server/db/entities/AIModelKeyHealth";
import { Company } from "../server/db/entities/Company";
import { Membership } from "../server/db/entities/Membership";
import { User } from "../server/db/entities/User";
import { maskSecret } from "../server/lib/secret";
import { errorHandler } from "../server/middleware/error";
import { companyModelsRouter } from "../server/routes/companyModels";
import { modelsRouter } from "../server/routes/models";
import { agentRuntime } from "../server/services/agent/runtime";
import {
  decryptApiKeys,
  newStoredApiKey,
  readApiKeys,
  writeApiKeys,
} from "../server/services/modelApiKeys";
import { closeTestDb, initTestDb, insert } from "../server/test/dbHarness";
import { insertEmployeeModel } from "../server/test/modelFixtures.js";
import { persistTestSession } from "../server/test/userSession";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "../output/playwright");

const PRIMARY = "sk-ant-api03-browser-primary-key-aaaa1001";
const BACKUPS = [
  "sk-ant-api03-browser-backup-key-bbbb2002",
  "sk-ant-api03-browser-backup-key-cccc3003",
  "sk-ant-api03-browser-backup-key-dddd4004",
];
const DEAD = "sk-ant-api03-browser-dead-key-eeee5005";
const EVERY_KEY = [PRIMARY, ...BACKUPS, DEAD];

// ---------- The real router on a private database ----------

const mutable = config as unknown as {
  sessionSecret: string;
  security: { encryptionSecret: string };
};
mutable.sessionSecret = "model-api-keys-browser-session-secret-0123456789";
mutable.security.encryptionSecret = "model-api-keys-browser-encryption-secret-0123456789";
await initTestDb();

const owner = await insert(User, {
  email: "keys-owner@example.test",
  name: "Owner",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const member = await insert(User, {
  email: "keys-member@example.test",
  name: "Member",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
const employee = await insert(AIEmployee, {
  companyId: company.id,
  name: "Avery",
  slug: "avery",
  role: "Operations",
  soulBody: "",
});
const model = await insertEmployeeModel({
  employeeId: employee.id,
  provider: "anthropic",
  model: "claude-opus-5-5",
  authMode: "apikey",
  isActive: true,
  configJson: writeApiKeys("{}", [newStoredApiKey(PRIMARY, company.id)]),
  connectedAt: new Date(),
  contextWindow: 1_000_000,
  contextWindowSource: "probed",
});

// The connection test: a key passes unless it is the dead one. What it was
// asked to test is recorded, to prove each new key is tested on its own.
const tested: string[][] = [];
agentRuntime.run = async (params) => {
  const keys = decryptApiKeys(params.model.configJson).map((key) => key.apiKey);
  tested.push(keys);
  if (keys.includes(DEAD)) {
    throw Object.assign(new Error("The AI Model request failed (HTTP 401)."), {
      status: 401,
      providerDetail: "HTTP 401 · authentication_error\ninvalid x-api-key",
    });
  }
  await params.registry.resolve("connection_test")!.run({ ok: true });
  return { finalText: "OK", steps: 2, stopReason: "end_turn" };
};

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
// The model and its keys are the company's; the employee's router lists which it uses.
app.use("/api/companies/:cid/models", companyModelsRouter);
app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
app.use(errorHandler);
const api: Server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

// ---------- Chrome ----------

console.log("Model API keys: building the model section.");
const fixture = await startBrowserFixture("modelApiKeysHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1100, height: 1000 } });
const pageErrors: string[] = [];
let actingUser = owner.id;
const responses: string[] = [];

await context.routeWebSocket(/\/api\/ws\?/, () => undefined);
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname.endsWith("ws-token")) return route.fulfill({ json: { token: "fixture" } });
  if (!url.pathname.startsWith(`/api/companies/${company.id}/`)) return route.fulfill({ json: [] });
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

async function open(role: "owner" | "member" = "owner", width = 1100): Promise<Page> {
  actingUser = role === "owner" ? owner.id : member.id;
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 1000 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${fixture.origin}/?cid=${company.id}&eid=${employee.id}&role=${role}`, {
    waitUntil: "commit",
    timeout: 120_000,
  });
  await page
    .getByText("Claude (Anthropic) · claude-opus-5-5")
    .first()
    .waitFor({ timeout: 120_000 });
  return page;
}

async function openAdvanced(page: Page) {
  await page.getByRole("button", { name: /Advanced/ }).click();
  await page.getByRole("region", { name: "API keys" }).waitFor();
}

const keysPanel = (page: Page) => page.getByRole("region", { name: "API keys" });
const keyRows = (page: Page) => keysPanel(page).getByRole("listitem");

async function rowPreviews(page: Page): Promise<string[]> {
  return keyRows(page).evaluateAll((rows) =>
    rows.map((row) => row.querySelector(".font-mono")?.textContent ?? ""),
  );
}

async function addKey(page: Page, apiKey: string) {
  await keysPanel(page).getByLabel("Add a backup key").fill(apiKey);
  await keysPanel(page).getByRole("button", { name: "Add backup key" }).click();
}

async function waitForRows(page: Page, count: number) {
  await page.waitForFunction(
    ({ count }) =>
      document.querySelectorAll('section[aria-labelledby^="api-keys-"] li').length === count,
    { count },
    { timeout: 30_000 },
  );
}

async function assertNoKeyOnPage(page: Page) {
  const html = await page.content();
  for (const key of EVERY_KEY) assert.ok(!html.includes(key), `the page shows ${key}`);
}

const savedKeys = async () =>
  decryptApiKeys(
    (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id })).configJson,
  ).map((key) => key.apiKey);

let checks = 0;
try {
  await fs.mkdir(artifacts, { recursive: true });
  let page = await open();

  // Closed, Advanced already says what it holds.
  assert.match(
    await page.getByRole("button", { name: /Advanced/ }).innerText(),
    /API keys, model, context window and Run limit/,
  );
  await openAdvanced(page);
  assert.deepEqual(await rowPreviews(page), [maskSecret(PRIMARY)]);
  // Badges are set in capitals by CSS; innerText reports them that way.
  assert.match(await keyRows(page).first().innerText(), /Primary/i);
  // The only key can't be removed or moved.
  assert.equal(
    await keysPanel(page).getByRole("button", { name: "Remove key 1" }).isDisabled(),
    true,
  );
  assert.equal(
    await keysPanel(page).getByRole("button", { name: "Move key 1 up" }).isDisabled(),
    true,
  );
  checks++;

  // Three backup keys, one after another: each tested on its own.
  for (const [index, key] of BACKUPS.entries()) {
    await addKey(page, key);
    await waitForRows(page, index + 2);
    assert.equal(await keysPanel(page).getByLabel("Add a backup key").inputValue(), "");
  }
  assert.deepEqual(await rowPreviews(page), [PRIMARY, ...BACKUPS].map(maskSecret));
  assert.deepEqual(await savedKeys(), [PRIMARY, ...BACKUPS]);
  assert.deepEqual(
    tested,
    BACKUPS.map((key) => [key]),
  );
  assert.match(await page.getByText(/Connected with 4 API keys/).innerText(), /4 API keys/);
  await assertNoKeyOnPage(page);
  checks++;

  // A key that fails its test is explained where it was typed, and not added.
  await addKey(page, DEAD);
  const refused = keysPanel(page)
    .getByRole("alert")
    .filter({ hasText: "rejected this credential" });
  await refused.waitFor();
  await refused.getByRole("button", { name: "View details" }).click();
  await refused.getByText("HTTP 401 · authentication_error").waitFor();
  assert.equal(await keyRows(page).count(), 4);
  assert.deepEqual(await savedKeys(), [PRIMARY, ...BACKUPS]);
  await page.screenshot({
    path: path.join(artifacts, "model-api-keys-refused.png"),
    fullPage: true,
  });
  checks++;

  // So is a key the model already holds.
  await addKey(page, BACKUPS[0]);
  await keysPanel(page)
    .getByRole("alert")
    .filter({ hasText: "already on this AI Model" })
    .waitFor();
  assert.equal(await keyRows(page).count(), 4);
  await keysPanel(page).getByLabel("Add a backup key").fill("");
  checks++;

  // Remove the second backup, after confirming.
  await keysPanel(page).getByRole("button", { name: "Remove key 3" }).click();
  const confirm = page.getByRole("dialog");
  await confirm.getByText("Remove this API key?").waitFor();
  assert.match(await confirm.innerText(), new RegExp(maskSecret(BACKUPS[1]).replace("…", ".")));
  await confirm.getByRole("button", { name: "Remove key" }).click();
  await waitForRows(page, 3);
  assert.deepEqual(await rowPreviews(page), [PRIMARY, BACKUPS[0], BACKUPS[2]].map(maskSecret));
  assert.deepEqual(await savedKeys(), [PRIMARY, BACKUPS[0], BACKUPS[2]]);
  checks++;

  // Cancelling a removal changes nothing.
  await keysPanel(page).getByRole("button", { name: "Remove key 2" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  assert.equal(await keyRows(page).count(), 3);
  checks++;

  // Move the last backup up one place.
  await keysPanel(page).getByRole("button", { name: "Move key 3 up" }).click();
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll('section[aria-labelledby^="api-keys-"] li .font-mono'))
        .map((cell) => cell.textContent)
        .join("|") === expected,
    [PRIMARY, BACKUPS[2], BACKUPS[0]].map(maskSecret).join("|"),
  );
  assert.deepEqual(await savedKeys(), [PRIMARY, BACKUPS[2], BACKUPS[0]]);
  checks++;

  // Move it to the top: it becomes the primary.
  await keysPanel(page).getByRole("button", { name: "Move key 2 up" }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('section[aria-labelledby^="api-keys-"] li .font-mono')?.textContent ===
      expected,
    maskSecret(BACKUPS[2]),
  );
  assert.match(await keyRows(page).first().innerText(), /Primary/i);
  assert.deepEqual(await savedKeys(), [BACKUPS[2], PRIMARY, BACKUPS[0]]);
  checks++;

  // A key the provider refused shows as failing, with why and when.
  const [, refusedKey] = readApiKeys(
    (await AppDataSource.getRepository(AIModel).findOneByOrFail({ id: model.id })).configJson,
  );
  await insert(AIModelKeyHealth, {
    modelId: model.id,
    keyId: refusedKey.id,
    lastUsedAt: new Date(Date.now() - 3 * 3_600_000),
    lastErrorAt: new Date(Date.now() - 2 * 60_000),
    lastErrorStatus: 402,
    lastErrorKind: "billing",
    lastErrorMessage: "Your credit balance is too low to access the Anthropic API.",
    coolDownUntil: new Date(Date.now() + 3 * 60_000),
  });
  await page.close();
  page = await open();
  assert.match(
    await page.getByRole("button", { name: /Advanced/ }).innerText(),
    /2 backup API keys · 1 API key failing/,
  );
  // The card says it outside Advanced too: a dead key is not something to go
  // looking for, and work carrying on on the other keys is worth knowing.
  await page
    .getByRole("status")
    .filter({ hasText: "The provider is refusing 1 of 3 API keys" })
    .waitFor();
  await openAdvanced(page);
  const failing = keyRows(page).nth(1);
  assert.match(await failing.innerText(), /Skipped for now/i);
  assert.match(await failing.innerText(), /Refused 2 min ago \(out of credit, HTTP 402\)/);
  assert.match(await failing.innerText(), /Your credit balance is too low/);
  assert.match(await failing.innerText(), /last used 3 h ago/);
  await assertNoKeyOnPage(page);
  await page.screenshot({
    path: path.join(artifacts, "model-api-keys-desktop.png"),
    fullPage: true,
  });
  checks++;

  // A phone-width screen keeps every control reachable without sideways scrolling.
  await page.close();
  page = await open("owner", 375);
  await openAdvanced(page);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
  await keysPanel(page).getByRole("button", { name: "Remove key 3" }).waitFor();
  await page.screenshot({
    path: path.join(artifacts, "model-api-keys-mobile.png"),
    fullPage: true,
  });
  checks++;

  // A Member reads the keys and their health, and changes nothing.
  await page.close();
  page = await open("member");
  await openAdvanced(page);
  assert.equal(await keyRows(page).count(), 3);
  assert.equal(await keysPanel(page).getByLabel("Add a backup key").count(), 0);
  assert.equal(
    await keysPanel(page)
      .getByRole("button", { name: /Remove key|Move key/ })
      .count(),
    0,
  );
  checks++;

  for (const body of responses) {
    for (const key of EVERY_KEY) assert.ok(!body.includes(key), "an API response carried a key");
    assert.ok(!body.includes("apiKeyEncrypted"), "an API response carried a ciphertext");
  }
  assert.deepEqual(pageErrors, []);
  checks++;
  console.log(`Model API keys: ${checks} browser checks passed.`);
} finally {
  await context.close();
  await browser.close();
  await fixture.close();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await closeTestDb();
}
