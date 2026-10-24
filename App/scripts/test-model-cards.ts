/**
 * Real Chrome over the real models router: each AI Model card on an employee's
 * Settings → Model is self-contained. Its status, Test connection and Make
 * active sit on the card, and its own Advanced section — closed, its closed
 * line naming what is set inside — holds that model's settings and no other's:
 * a Claude model's API keys, a custom endpoint's server, a ChatGPT sign-in.
 * Nothing about one model sits outside its card; the page itself holds only
 * Add an AI Model. Also: changing a model from the list its own keys reach,
 * adding the company's model, removing one, a Member's read-only cards, a
 * phone-width screen, dark mode, and the `#advanced` link.
 *
 * Every API call goes to the real router on a private in-memory database. The
 * model's connection test, the provider's model list and the ChatGPT runtime
 * are stubbed, so no provider is called and no live credential is needed.
 * Run with `npm run test:model-cards`.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium, type Locator, type Page } from "playwright-core";
import { config } from "../config";
import { AppDataSource } from "../server/db/datasource";
import { AIEmployee } from "../server/db/entities/AIEmployee";
import { AIModel } from "../server/db/entities/AIModel";
import { AIModelKeyHealth } from "../server/db/entities/AIModelKeyHealth";
import { Company } from "../server/db/entities/Company";
import { Membership } from "../server/db/entities/Membership";
import { User } from "../server/db/entities/User";
import { encryptSecret } from "../server/lib/secret";
import { errorHandler } from "../server/middleware/error";
import { modelsRouter } from "../server/routes/models";
import { CodexAppServer } from "../server/services/agent/codexAppServer";
import { agentRuntime } from "../server/services/agent/runtime";
import { configWithSubscriptionAccessToken } from "../server/services/codexSubscription";
import { decryptApiKeys, newStoredApiKey, writeApiKeys } from "../server/services/modelApiKeys";
import { closeTestDb, initTestDb, insert } from "../server/test/dbHarness";
import { insertEmployeeModel } from "../server/test/modelFixtures.js";
import { fakeCodexVerification } from "../server/test/modelVerification";
import { persistTestSession } from "../server/test/userSession";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "../output/playwright");

const PRIMARY = "sk-ant-api03-model-cards-primary-aaaa1001";
const BACKUP = "sk-ant-api03-model-cards-backup-bbbb2002";
const DEAD = "sk-ant-api03-model-cards-dead-cccc3003";
const GRACE_KEY = "sk-ant-api03-model-cards-grace-dddd4004";
const ENDPOINT_KEY = "model-cards-endpoint-key-eeee5005";
const EVERY_SECRET = [PRIMARY, BACKUP, DEAD, GRACE_KEY, ENDPOINT_KEY, "model-cards-access-token"];

// ---------- The real router on a private database ----------

const mutable = config as unknown as {
  sessionSecret: string;
  security: { encryptionSecret: string; multiTenant: boolean };
};
mutable.sessionSecret = "model-cards-browser-session-secret-0123456789";
mutable.security.encryptionSecret = "model-cards-browser-encryption-secret-0123456789";
mutable.security.multiTenant = false;
// ChatGPT test turns make their temporary Codex homes here, not in the shared tmp.
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-model-cards-"));
process.env.TMPDIR = tempRoot;
await initTestDb();

const owner = await insert(User, {
  email: "cards-owner@example.test",
  name: "Owner",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const member = await insert(User, {
  email: "cards-member@example.test",
  name: "Member",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
await insert(Membership, { companyId: company.id, userId: member.id, role: "member" });
const ada = await insert(AIEmployee, {
  companyId: company.id,
  name: "Ada",
  slug: "ada",
  role: "Analyst",
  soulBody: "",
});
const grace = await insert(AIEmployee, {
  companyId: company.id,
  name: "Grace",
  slug: "grace",
  role: "Engineer",
  soulBody: "",
});

const day = (n: number) => new Date(Date.UTC(2026, 9, n, 9, 0, 0));
const claude = await insertEmployeeModel({
  employeeId: ada.id,
  provider: "anthropic",
  model: "claude-opus-5-5",
  authMode: "apikey",
  isActive: true,
  configJson: writeApiKeys(
    "{}",
    [PRIMARY, BACKUP, DEAD].map((key) => newStoredApiKey(key, company.id)),
  ),
  connectedAt: day(9),
  contextWindow: 1_000_000,
  contextWindowSource: "probed",
  createdAt: day(9),
});
const qwen = await insertEmployeeModel({
  employeeId: ada.id,
  provider: "custom",
  model: "Qwen/Qwen3.8-27B",
  authMode: "customEndpoint",
  isActive: false,
  configJson: JSON.stringify({
    baseURLEncrypted: encryptSecret("https://34.57.23.218:46455/v1", company.id),
    baseURLPreview: "34.57.23.218:46455",
    modelId: "Qwen/Qwen3.8-27B",
    apiKeyEncrypted: encryptSecret(ENDPOINT_KEY, company.id),
    apiKeyPreview: "mode…5005",
  }),
  connectedAt: day(8),
  contextWindow: 65_536,
  contextWindowSource: "manual",
  maxConcurrentRuns: 2,
  createdAt: day(8),
});
const chatgptRow = await insertEmployeeModel({
  employeeId: ada.id,
  provider: "openai",
  model: "auto",
  authMode: "subscription",
  isActive: false,
  configJson: "{}",
  connectedAt: day(7),
  createdAt: day(7),
});
await AppDataSource.getRepository(AIModel).update(
  { id: chatgptRow.id },
  { configJson: configWithSubscriptionAccessToken(chatgptRow, "model-cards-access-token") },
);
// The dead key: refused for being out of credit two minutes ago, resting now.
const deadKey = JSON.parse(claude.configJson).backupKeys[1].id as string;
await insert(AIModelKeyHealth, {
  modelId: claude.id,
  keyId: deadKey,
  lastErrorAt: new Date(Date.now() - 2 * 60_000),
  lastErrorStatus: 402,
  lastErrorKind: "billing",
  lastErrorMessage: "Your credit balance is too low to access the Anthropic API.",
  coolDownUntil: new Date(Date.now() + 3 * 60_000),
});
// Grace runs on an OpenAI model of her own — the one Ada can be given in a
// click — and keeps a Claude model too, which Ada will already run by then.
await insertEmployeeModel({
  employeeId: grace.id,
  provider: "openai",
  model: "gpt-5.5",
  authMode: "apikey",
  isActive: true,
  configJson: writeApiKeys("{}", [newStoredApiKey(GRACE_KEY, company.id)]),
  connectedAt: day(5),
});
await insertEmployeeModel({
  employeeId: grace.id,
  provider: "anthropic",
  model: "claude-sonnet-5",
  authMode: "apikey",
  isActive: false,
  configJson: writeApiKeys("{}", [newStoredApiKey(GRACE_KEY, company.id)]),
  connectedAt: day(4),
});

// The connection test: passes unless told to refuse, recording which model it asked.
let refuseTests = false;
const testedModels: string[] = [];
agentRuntime.run = async (params) => {
  testedModels.push(`${params.model.provider}:${params.model.model}`);
  if (refuseTests) {
    throw Object.assign(new Error("The AI Model request failed (HTTP 401)."), {
      status: 401,
      providerDetail: "HTTP 401 · authentication_error\ninvalid x-api-key",
    });
  }
  await params.registry.resolve("connection_test")!.run({ ok: true });
  return { finalText: "OK", steps: 2, stopReason: "end_turn" };
};
// ChatGPT's runtime answers its isolated test turn without a network.
CodexAppServer.start = async (options) => fakeCodexVerification(options.cwd);

// The provider's model list and context-window probe, without a network.
const realFetch = globalThis.fetch;
const catalogAskedWith: string[] = [];
globalThis.fetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  const parsed = new URL(url);
  if (parsed.hostname === "api.anthropic.com" && parsed.pathname === "/v1/models") {
    catalogAskedWith.push(new Headers(init?.headers).get("x-api-key") ?? "");
    return Response.json({
      data: [
        {
          id: "claude-opus-5-5",
          display_name: "Claude Opus 5.5",
          created_at: "2026-09-01T00:00:00Z",
        },
        {
          id: "claude-sonnet-5",
          display_name: "Claude Sonnet 5",
          created_at: "2026-08-01T00:00:00Z",
        },
      ],
      has_more: false,
      last_id: "claude-sonnet-5",
    });
  }
  if (parsed.hostname === "api.anthropic.com") {
    return Response.json({ id: parsed.pathname.split("/").pop(), max_input_tokens: 1_000_000 });
  }
  return new Response("{}", { status: 404 });
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
app.use("/api/companies/:cid/employees/:eid/models", modelsRouter);
app.use(errorHandler);
const api: Server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
const apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

// ---------- Chrome ----------

console.log("Model cards: building the model section.");
const fixture = await startBrowserFixture("modelCardsHarness.tsx", 0);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await fixture.close();
    throw error;
  });
const pageErrors: string[] = [];
const responses: string[] = [];
let actingUser = owner.id;

async function open(
  options: {
    role?: "owner" | "member";
    width?: number;
    scheme?: "light" | "dark";
    hash?: string;
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
    const forwarded = await realFetch(`${apiBase}${url.pathname}${url.search}`, {
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
  const query = new URLSearchParams({
    cid: company.id,
    eid: ada.id,
    role: options.role ?? "owner",
    ...(options.hash ? { hash: options.hash } : {}),
  });
  await page.goto(`${fixture.origin}/?${query}`, { waitUntil: "commit", timeout: 120_000 });
  await page.getByRole("group").first().waitFor({ timeout: 120_000 });
  return page;
}

const CLAUDE = "Claude (Anthropic) · claude-opus-5-5";
const QWEN = "Custom endpoint · Qwen/Qwen3.8-27B";
const CHATGPT = "OpenAI (ChatGPT sign-in) · default model";
const card = (page: Page, name: string) => page.getByRole("group", { name, exact: true });
const advancedToggle = (scope: Page | Locator) =>
  scope.getByRole("button", { name: /^Advanced/ }).first();

async function openAdvanced(scope: Locator) {
  const toggle = advancedToggle(scope);
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true");
}

/** Every Advanced toggle on the page belongs to a card. */
async function assertNothingOutsideCards(page: Page) {
  const outside = await page.evaluate(
    () =>
      [...document.querySelectorAll("button[aria-expanded]")].filter(
        (button) => /^Advanced/.test(button.textContent ?? "") && !button.closest('[role="group"]'),
      ).length,
  );
  assert.equal(outside, 0, "an Advanced toggle sits outside every card");
  // The old page-wide line ("1 other AI Model · 2 concurrent Runs") is gone.
  assert.equal(await page.getByText(/\d+ other AI Models?/).count(), 0);
}

async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow <= 0) return;
  // Name what sticks out, so a failure says where to look.
  const culprits = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(-5)
      .map(
        (element) =>
          `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 80)} "${(
            element.textContent ?? ""
          )
            .trim()
            .slice(0, 40)}"`,
      ),
  );
  assert.fail(`${label} scrolls sideways by ${overflow}px:\n${culprits.join("\n")}`);
}

const savedModel = (id: string) => AppDataSource.getRepository(AIModel).findOneBy({ id });

/** 0 for black, 1 for white: the relative brightness of a CSS rgb() colour. */
function luminance(color: string): number {
  const [r, g, b] = (color.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0"]).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

let checks = 0;
try {
  await fs.mkdir(artifacts, { recursive: true });
  let page = await open();

  // ── Each card is whole, and its Advanced is its own ─────────────────────────
  await card(page, CLAUDE).waitFor();
  await card(page, QWEN).waitFor();
  await card(page, CHATGPT).waitFor();
  await page.getByText("3 AI Models — Ada uses the active one for chat and Routines.").waitFor();
  assert.equal(await page.getByRole("button", { name: /^Advanced/ }).count(), 3);
  for (const name of [CLAUDE, QWEN, CHATGPT]) {
    const toggles = card(page, name).getByRole("button", { name: /^Advanced/ });
    assert.equal(await toggles.count(), 1, `${name} has one Advanced of its own`);
    assert.equal(await toggles.getAttribute("aria-expanded"), "false", `${name} starts closed`);
    await card(page, name).getByRole("button", { name: "Test connection" }).waitFor();
  }
  await assertNothingOutsideCards(page);
  // Each closed line names its own model's settings, and nothing of the others.
  assert.match(
    await advancedToggle(card(page, CLAUDE)).innerText(),
    /2 backup API keys · 1 API key failing/,
  );
  assert.match(
    await advancedToggle(card(page, QWEN)).innerText(),
    /Context window set manually · 2 concurrent Runs/,
  );
  assert.doesNotMatch(await advancedToggle(card(page, QWEN)).innerText(), /API key/);
  assert.match(await advancedToggle(card(page, CHATGPT)).innerText(), /ChatGPT sign-in and model/);
  // The refused key is said on its card, outside Advanced, and only there.
  await card(page, CLAUDE)
    .getByRole("status")
    .filter({ hasText: "The provider is refusing 1 of 3 API keys" })
    .waitFor();
  assert.equal(
    await card(page, QWEN)
      .getByText(/refusing/)
      .count(),
    0,
  );
  // Make active is offered on the others, not on the active one.
  assert.equal(await card(page, CLAUDE).getByRole("button", { name: "Make active" }).count(), 0);
  await card(page, QWEN).getByRole("button", { name: "Make active" }).waitFor();
  await page.getByRole("button", { name: "Add an AI Model", exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "model-cards-closed.png"), fullPage: true });
  checks++;

  // Opening Claude's Advanced shows Claude's settings, inside Claude's card.
  await openAdvanced(card(page, CLAUDE));
  const claudeKeys = card(page, CLAUDE).getByRole("region", { name: "API keys" });
  await claudeKeys.waitFor();
  assert.equal(await claudeKeys.getByRole("listitem").count(), 3);
  for (const setting of ["Model", "Context window", "Concurrent Routine Runs", "Remove from Ada"]) {
    await card(page, CLAUDE).getByRole("region", { name: setting, exact: true }).waitFor();
  }
  assert.equal(await card(page, CLAUDE).getByRole("region", { name: "Endpoint" }).count(), 0);
  // The other cards stay closed: their settings are nowhere on screen.
  assert.equal(await advancedToggle(card(page, QWEN)).getAttribute("aria-expanded"), "false");
  assert.equal(
    await page.getByRole("region", { name: "Endpoint" }).filter({ visible: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("region", { name: "API keys" }).filter({ visible: true }).count(),
    1,
  );
  checks++;

  // The custom endpoint's Advanced holds its server and its own tuning.
  await openAdvanced(card(page, QWEN));
  const endpoint = card(page, QWEN).getByRole("region", { name: "Endpoint", exact: true });
  await endpoint.getByText("34.57.23.218:46455", { exact: true }).waitFor();
  await endpoint.getByText("Saved", { exact: true }).waitFor();
  assert.equal(await card(page, QWEN).getByRole("region", { name: "API keys" }).count(), 0);
  const qwenWindow = card(page, QWEN).getByRole("region", { name: "Context window", exact: true });
  assert.match(await qwenWindow.innerText(), /65,536\s+tokens · set by hand/);
  assert.equal(
    await card(page, QWEN).getByRole("combobox", { name: "Concurrent Routine Runs" }).inputValue(),
    "2 at a time",
  );
  // The endpoint form appears only when asked for, and never shows the saved URL.
  assert.equal(await page.getByLabel("Base URL", { exact: true }).count(), 0);
  checks++;

  // A ChatGPT sign-in: the sign-in and the model, no context window or Run limit.
  await openAdvanced(card(page, CHATGPT));
  await card(page, CHATGPT).getByRole("region", { name: "ChatGPT sign-in", exact: true }).waitFor();
  await card(page, CHATGPT).getByRole("region", { name: "Model", exact: true }).waitFor();
  assert.equal(
    await card(page, CHATGPT).getByRole("region", { name: "Context window" }).count(),
    0,
  );
  assert.equal(
    await card(page, CHATGPT).getByRole("region", { name: "Concurrent Routine Runs" }).count(),
    0,
  );
  await page.screenshot({ path: path.join(artifacts, "model-cards-open.png"), fullPage: true });
  await assertNothingOutsideCards(page);
  checks++;

  // ── Test connection, on the card it tests ───────────────────────────────────
  const claudeBefore = await savedModel(claude.id);
  await card(page, CLAUDE).getByRole("button", { name: "Test connection" }).click();
  await card(page, CLAUDE)
    .getByText(/^Working — the model answered in/)
    .waitFor();
  assert.equal(
    await card(page, QWEN)
      .getByText(/^Working —/)
      .count(),
    0,
  );
  assert.deepEqual(testedModels, ["anthropic:claude-opus-5-5"]);
  const claudeAfter = await savedModel(claude.id);
  assert.equal(claudeAfter?.configJson, claudeBefore?.configJson, "the test wrote no credential");
  assert.deepEqual(claudeAfter?.connectedAt, claudeBefore?.connectedAt);
  refuseTests = true;
  await card(page, QWEN).getByRole("button", { name: "Test connection" }).click();
  const refused = card(page, QWEN)
    .getByRole("alert")
    .filter({ hasText: "rejected this credential" });
  await refused.waitFor();
  await refused.getByRole("button", { name: "View details" }).click();
  await refused.getByText("HTTP 401 · authentication_error").waitFor();
  refuseTests = false;
  // A ChatGPT sign-in is tested in its own isolated turn, and stays on its default.
  await card(page, CHATGPT).getByRole("button", { name: "Test connection" }).click();
  await card(page, CHATGPT)
    .getByText(/^Working — the model answered in/)
    .waitFor();
  assert.equal((await savedModel(chatgptRow.id))?.model, "auto");
  assert.deepEqual(
    (await fs.readdir(tempRoot)).filter((entry) => entry.startsWith("genosyn-codex-")),
    [],
    "the test's Codex homes are gone",
  );
  checks++;

  // ── Settings change on the card they belong to ──────────────────────────────
  await card(page, QWEN).getByRole("combobox", { name: "Concurrent Routine Runs" }).click();
  await page.getByRole("option", { name: "3 at a time", exact: true }).click();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[role="group"]')]
        .find((group) => group.textContent?.includes("Qwen/Qwen3.8-27B"))
        ?.textContent?.includes("Context window set manually · 3 concurrent Runs") ?? false,
  );
  assert.equal((await savedModel(qwen.id))?.maxConcurrentRuns, 3);
  checks++;

  // Changing Claude's model is a pick from the list its own keys reach.
  const choice = card(page, CLAUDE).getByRole("region", { name: "Model", exact: true });
  await choice.getByRole("button", { name: "Change" }).click();
  const picker = card(page, CLAUDE).getByRole("combobox", { name: "Model", exact: true });
  await picker.waitFor();
  // The current model is chosen, and marked, in the list.
  assert.equal(await picker.inputValue(), "Claude Opus 5.5 (current)");
  assert.ok(catalogAskedWith.length > 0, "the list was read with the model's own key");
  assert.equal(catalogAskedWith[0], PRIMARY);
  assert.equal(await card(page, CLAUDE).getByLabel("API key", { exact: true }).count(), 0);
  await picker.click();
  await page.getByRole("option", { name: "Claude Sonnet 5", exact: true }).click();
  await card(page, CLAUDE).getByRole("button", { name: "Save", exact: true }).click();
  await card(page, "Claude (Anthropic) · claude-sonnet-5").waitFor();
  // The test passed for the old model; it says nothing about the new one.
  assert.equal(
    await card(page, "Claude (Anthropic) · claude-sonnet-5")
      .getByText(/^Working —/)
      .count(),
    0,
  );
  // The new model's context window was read at once, not left unknown.
  await card(page, "Claude (Anthropic) · claude-sonnet-5")
    .getByRole("region", { name: "Context window", exact: true })
    .getByText("1,000,000", { exact: true })
    .waitFor();
  assert.equal((await savedModel(claude.id))?.model, "claude-sonnet-5");
  // Every key came through the change: the backups were not dropped.
  assert.deepEqual(
    decryptApiKeys((await savedModel(claude.id))!.configJson).map((key) => key.apiKey),
    [PRIMARY, BACKUP, DEAD],
  );
  checks++;

  // Make active moves the work to another card, which then leads.
  await card(page, QWEN).getByRole("button", { name: "Make active" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[role="group"] h3')?.textContent ===
      "Custom endpoint · Qwen/Qwen3.8-27B",
  );
  await card(page, QWEN).getByText("Active", { exact: true }).waitFor();
  assert.equal((await savedModel(qwen.id))?.isActive, true);
  checks++;

  // ── Adding one: the company's model in a click, or the connect form ─────────
  // Cancel puts the page back as it was.
  await page.getByRole("button", { name: "Add an AI Model", exact: true }).click();
  await page.getByLabel("API key", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByLabel("API key", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Add an AI Model", exact: true }).click();
  const offers = page.getByRole("listitem").filter({ hasText: "Grace runs on it" });
  const gptOffer = offers.filter({ hasText: "OpenAI · gpt-5.5" });
  await gptOffer.waitFor();
  // Grace's Claude model is the one Ada now runs: offering it would only copy it again.
  assert.equal(await offers.filter({ hasText: "claude-sonnet-5" }).count(), 0);
  await page.getByLabel("API key", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "model-cards-add.png"), fullPage: true });
  await gptOffer.getByRole("button", { name: "Use this one", exact: true }).click();
  const gptCard = card(page, "OpenAI · gpt-5.5");
  await gptCard.getByText("Active", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("API key", { exact: true }).count(), 0, "the panel closed");
  const copies = await AppDataSource.getRepository(AIModel).findBy({
    employeeId: ada.id,
    model: "gpt-5.5",
  });
  assert.equal(copies.length, 1);
  assert.equal(copies[0].isActive, true);
  assert.equal(await page.getByRole("button", { name: /^Advanced/ }).count(), 4);
  await assertNothingOutsideCards(page);
  checks++;

  // ── Removing one, from its own card, after asking ───────────────────────────
  await openAdvanced(card(page, CHATGPT));
  await card(page, CHATGPT)
    .getByRole("region", { name: "Remove from Ada", exact: true })
    .getByRole("button", { name: "Remove" })
    .click();
  const confirm = page.getByRole("dialog");
  await confirm.getByText("Remove this AI Model from Ada?").waitFor();
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await card(page, CHATGPT).waitFor({ state: "detached" });
  assert.equal(await savedModel(chatgptRow.id), null);
  assert.equal(await page.getByRole("button", { name: /^Advanced/ }).count(), 3);
  await page.close();
  checks++;

  // ── `#advanced`: the chat's context-window link opens the active card's ─────
  page = await open({ hash: "advanced" });
  // The active card leads, open; the others stay closed.
  const groups = page.getByRole("group");
  await groups.nth(2).waitFor();
  assert.equal(await groups.first().locator("h3").innerText(), "OpenAI · gpt-5.5");
  assert.equal(await advancedToggle(groups.first()).getAttribute("aria-expanded"), "true");
  for (const index of [1, 2]) {
    assert.equal(await advancedToggle(groups.nth(index)).getAttribute("aria-expanded"), "false");
  }
  await page.close();
  checks++;

  // ── A Member reads every card, with nothing to press ────────────────────────
  page = await open({ role: "member" });
  await card(page, QWEN).waitFor();
  for (const name of ["Test connection", "Make active", "Add an AI Model", "Cancel"]) {
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `${name}`);
  }
  await openAdvanced(card(page, "Claude (Anthropic) · claude-sonnet-5"));
  const memberKeys = card(page, "Claude (Anthropic) · claude-sonnet-5").getByRole("region", {
    name: "API keys",
  });
  assert.equal(await memberKeys.getByRole("listitem").count(), 3);
  assert.equal(await memberKeys.getByLabel("Add a backup key").count(), 0);
  for (const name of ["Set manually", "Ask the provider", "Change", "Remove"]) {
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `${name}`);
  }
  assert.equal(await page.getByRole("combobox", { name: "Concurrent Routine Runs" }).count(), 0);
  await page.close();
  checks++;

  // ── A phone: every card and its Advanced fit, nothing scrolls sideways ──────
  page = await open({ width: 375 });
  await noSidewaysScroll(page, "the model cards at 375px");
  await openAdvanced(card(page, QWEN));
  await openAdvanced(card(page, "Claude (Anthropic) · claude-sonnet-5"));
  await noSidewaysScroll(page, "the open Advanced sections at 375px");
  await card(page, QWEN).getByRole("button", { name: "Test connection" }).waitFor();
  await page.screenshot({ path: path.join(artifacts, "model-cards-phone.png"), fullPage: true });
  await page.close();
  checks++;

  // ── Dark mode: the cards and their Advanced are drawn dark ──────────────────
  page = await open({ scheme: "dark" });
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains("dark")),
    true,
  );
  await openAdvanced(card(page, QWEN));
  // No white card on a dark page, and no dark text on a dark card — whatever
  // exact shades the theme picks.
  const cardBackground = await card(page, QWEN).evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  assert.ok(luminance(cardBackground) < 0.2, `the card is drawn ${cardBackground}`);
  for (const text of [
    card(page, QWEN).locator("h3"),
    card(page, QWEN).getByRole("region", { name: "Endpoint", exact: true }).locator("h4"),
  ]) {
    const color = await text.evaluate((element) => getComputedStyle(element).color);
    assert.ok(luminance(color) > 0.6, `text on the dark card is ${color}`);
  }
  await page.screenshot({ path: path.join(artifacts, "model-cards-dark.png"), fullPage: true });
  await page.close();
  checks++;

  // Nothing secret ever came back to the browser.
  for (const body of responses) {
    for (const secret of EVERY_SECRET)
      assert.ok(!body.includes(secret), "a response carried a secret");
    for (const field of ["apiKeyEncrypted", "baseURLEncrypted", "codexAccessTokenEncrypted"]) {
      assert.ok(!body.includes(field), `a response carried ${field}`);
    }
  }
  assert.deepEqual(pageErrors, []);
  checks++;
  console.log(`Model cards: ${checks} browser checks passed.`);
} finally {
  await browser.close();
  await fixture.close();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  await closeTestDb();
  globalThis.fetch = realFetch;
  await fs.rm(tempRoot, { recursive: true, force: true });
}
