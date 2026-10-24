/** Real Chrome regression coverage; deterministic API fixtures, no live credentials. */
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import { startBrowserFixture } from "./browserFixture";
import type { AIModel } from "../client/lib/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "../output/playwright");
console.log("Model setup: building fixture screens.");
// Port 0: an ephemeral port, so concurrent suites never collide.
const server = await startBrowserFixture("modelSetupHarness.tsx", 0);
console.log("Model setup: fixture server ready; launching Chrome.");
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
console.log("Model setup: Chrome ready.");
let discoveryFailure = false;
let connectFailure = false;
let listFailure = false;
let customFailure = false;
let attachFailure = false;
// The employee's own models (its Model page) and the company's (Settings → AI Models).
let modelRows: AIModel[] = [];
let companyRows: AIModel[] = [];
let companyListRequests = 0;
const attachRequests: Array<Record<string, unknown>> = [];
const customRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
let holdDiscovery = false;
const discoveryGate: { release?: () => void } = {};
let requests: Array<Record<string, unknown>> = [];
const pageErrors: string[] = [];
const pendingAssets = new Set<string>();
const failedAssets: string[] = [];
let currentPage: Page | null = null;
/** A connected API-key model, with every field the server sends. */
function connectedRow(overrides: Partial<AIModel> = {}): AIModel {
  return {
    id: "claude-model",
    companyId: "company",
    provider: "anthropic",
    model: "claude-sonnet-live",
    authMode: "apikey",
    isActive: true,
    createdAt: "2026-09-09T12:00:00Z",
    connectedAt: "2026-09-09T12:00:00Z",
    status: "connected",
    apiKeyMasked: "sk-…••••",
    apiKeys: [
      {
        id: "primary",
        preview: "sk-…live",
        addedAt: null,
        lastUsedAt: "2026-09-09T12:30:00Z",
        lastErrorAt: null,
        lastErrorStatus: null,
        lastErrorKind: null,
        lastError: null,
        restingUntil: null,
      },
    ],
    // The server still sends the conventional env var; no screen may show it.
    apiKeyEnv: "ANTHROPIC_API_KEY",
    supportsApiKey: true,
    supportsSubscription: false,
    subscriptionAvailable: false,
    subscriptionUnavailableReason: null,
    subscriptionCredentialKind: null,
    subscriptionShellAvailable: false,
    supportsCustomEndpoint: false,
    customEndpointHost: null,
    customEndpointModelId: null,
    customEndpointHasApiKey: false,
    contextWindow: 200_000,
    contextWindowSource: "probed",
    contextWindowProbeable: true,
    maxConcurrentRuns: null,
    effectiveMaxConcurrentRuns: null,
    concurrencySource: "unlimited",
    employees: [
      { id: "employee", name: "Avery", slug: "avery", avatarKey: null, isActive: true },
    ],
    duplicateIds: [],
    ...overrides,
  };
}
await context.routeWebSocket(/\/api\/ws\?/, () => undefined);
await context.route("**/api/**", async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname.endsWith("ws-token")) return route.fulfill({ json: { token: "fixture" } });
  if (pathname.endsWith("/discover")) {
    const body = route.request().postDataJSON() as { provider: string };
    if (holdDiscovery)
      await new Promise<void>((resolve) => {
        discoveryGate.release = resolve;
      });
    if (discoveryFailure)
      return route.fulfill({
        status: 422,
        json: { error: "Could not load available models. Check model access." },
      });
    const prefix = body.provider === "openai" ? "gpt" : "claude";
    return route.fulfill({
      json: {
        models: [
          { id: `${prefix}-live`, label: `${prefix} latest` },
          { id: `${prefix}-chosen`, label: `${prefix} chosen` },
        ],
        recommendedModel: `${prefix}-live`,
      },
    });
  }
  if (pathname.endsWith("/connect")) {
    requests.push(route.request().postDataJSON() as Record<string, unknown>);
    return route.fulfill(
      connectFailure
        ? {
            status: 422,
            json: {
              error: "The model rejected this credential. Check the key.",
              detail: "HTTP 401 · authentication_error\ninvalid x-api-key\nRequest ID: req_fixture",
            },
          }
        : { json: { id: "model", status: "connected" } },
    );
  }
  if (pathname.endsWith("/connect-custom") || pathname.endsWith("/custom-endpoint")) {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    customRequests.push({ path: pathname, body });
    if (customFailure)
      return route.fulfill({
        status: 422,
        json: { error: "This custom model did not complete the tool-use test. Try again." },
      });
    if (pathname.endsWith("/custom-endpoint")) {
      modelRows = modelRows.map((model) => ({
        ...model,
        model: String(body.modelId),
        customEndpointModelId: String(body.modelId),
      }));
    }
    return route.fulfill({ json: { id: "custom-model", status: "connected" } });
  }
  // The company's own list: what Settings → AI Models shows, and what an
  // employee's Add an AI Model offers.
  if (pathname === "/api/companies/company/models" && route.request().method() === "GET") {
    companyListRequests++;
    return route.fulfill({ json: companyRows });
  }
  if (pathname.endsWith("/employees/employee/models/attach")) {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    attachRequests.push(body);
    if (attachFailure)
      return route.fulfill({
        status: 400,
        json: {
          error:
            "This AI Model isn't connected yet. Finish connecting it before attaching it to AI Employees.",
        },
      });
    const offer = companyRows.find((row) => row.id === body.modelId)!;
    modelRows = [
      connectedRow({
        id: offer.id,
        provider: offer.provider,
        model: offer.model,
        employees: [
          ...offer.employees,
          { id: "employee", name: "Avery", slug: "avery", avatarKey: null, isActive: true },
        ],
      }),
    ];
    return route.fulfill({ json: modelRows[0] });
  }
  if (pathname.endsWith("/models") && route.request().method() === "GET")
    return route.fulfill(
      listFailure
        ? { status: 503, json: { error: "Models are temporarily unavailable." } }
        : { json: modelRows },
    );
  return route.fulfill({ json: [] });
});
const url = `${server.origin}/__model-setup`;
async function open(suffix = "") {
  console.log(`Model setup: opening ${suffix ? "employee model section" : "connection form"}.`);
  const page = await context.newPage();
  currentPage = page;
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) pendingAssets.add(pathname);
  });
  page.on("requestfinished", (request) => pendingAssets.delete(new URL(request.url()).pathname));
  page.on("requestfailed", (request) => {
    const pathname = new URL(request.url()).pathname;
    pendingAssets.delete(pathname);
    if (!pathname.startsWith("/api/"))
      failedAssets.push(`${pathname}: ${request.failure()?.errorText ?? "request failed"}`);
  });
  await page.goto(`${url}${suffix}`, { waitUntil: "commit", timeout: 120_000 });
  await page.locator("main").waitFor({ timeout: 180_000 });
  if (suffix)
    await page.getByText("Loading AI Models…", { exact: true }).waitFor({
      state: "hidden",
      timeout: 180_000,
    });
  console.log("Model setup: screen mounted.");
  return page;
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
function releaseHeldDiscovery() {
  discoveryGate.release?.();
  delete discoveryGate.release;
}

async function waitForHeldDiscovery() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (discoveryGate.release) return;
    if (Date.now() > deadline) throw new Error("Discovery request did not arrive.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
let checks = 0;
try {
  await fs.mkdir(artifacts, { recursive: true });
  let page = await open();
  assert.doesNotMatch(await page.locator("main").innerText(), /gpt-4o|claude-opus-4-6/);
  checks++;
  assert.equal(await page.getByRole("button", { name: "Connect AI Model" }).isDisabled(), true);
  checks++;
  holdDiscovery = true;
  await page.getByLabel("API key", { exact: true }).fill("test-key");
  await page.getByRole("status").filter({ hasText: "Finding available models" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Connect AI Model" }).isDisabled(), true);
  checks++;
  await page.waitForFunction(() => document.body.textContent?.includes("Finding available models"));
  await waitForHeldDiscovery();
  holdDiscovery = false;
  releaseHeldDiscovery();
  await page.getByRole("combobox", { name: "Model", exact: true }).waitFor();
  assert.match(
    await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(),
    /Recommended: claude latest/,
  );
  checks++;
  await page.screenshot({ path: path.join(artifacts, "model-setup-desktop.png"), fullPage: true });
  await choose(page, "Model", "claude chosen");
  await page.getByLabel("API key", { exact: true }).fill("replacement-test-key");
  await page.getByRole("combobox", { name: "Model", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(),
    "claude chosen",
  );
  checks++;
  connectFailure = true;
  await page.getByRole("button", { name: "Connect AI Model" }).click();
  const failure = page.getByRole("alert").filter({ hasText: "rejected this credential" });
  await failure.waitFor();
  assert.equal(
    await page.getByLabel("API key", { exact: true }).inputValue(),
    "replacement-test-key",
  );
  checks++;
  // What the service said stays behind its own control until asked for.
  assert.equal(await failure.getByText("invalid x-api-key").count(), 0);
  await failure.getByRole("button", { name: "View details" }).click();
  await failure.getByText("HTTP 401 · authentication_error").waitFor();
  assert.match(await failure.innerText(), /Request ID: req_fixture/);
  await page.screenshot({ path: path.join(artifacts, "model-setup-details.png"), fullPage: true });
  await failure.getByRole("button", { name: "Hide details" }).click();
  assert.equal(await failure.getByText("invalid x-api-key").count(), 0);
  checks++;
  connectFailure = false;
  await page.getByRole("button", { name: "Connect AI Model" }).click();
  await page.getByRole("status").filter({ hasText: "AI Model connected" }).waitFor();
  assert.equal(requests.at(-1)?.model, "claude-chosen");
  checks++;
  await page.close();

  // An old provider response must never seed the new provider's picker.
  page = await open();
  holdDiscovery = true;
  await page.getByLabel("API key", { exact: true }).fill("old-provider-key");
  await waitForHeldDiscovery();
  await choose(page, "AI Model service", "OpenAI / ChatGPT");
  holdDiscovery = false;
  releaseHeldDiscovery();
  assert.equal(await page.getByLabel("API key", { exact: true }).inputValue(), "");
  checks++;
  await page.getByLabel("API key", { exact: true }).fill("new-provider-key");
  await page.getByRole("combobox", { name: "Model", exact: true }).waitFor();
  assert.match(
    await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(),
    /gpt latest/,
  );
  checks++;
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: path.join(artifacts, "model-setup-mobile.png"), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks++;
  await page.close();

  // Discovery failure remains recoverable and permits an explicit model.
  page = await open();
  discoveryFailure = true;
  await page.getByLabel("API key", { exact: true }).fill("restricted-key");
  await page.getByRole("alert").waitFor();
  await page.getByText("Choose a model ID manually", { exact: true }).click();
  await page.getByLabel("Model ID (optional)").fill("claude-explicit");
  requests = [];
  await page.getByRole("button", { name: "Connect AI Model" }).click();
  await page.getByRole("status").filter({ hasText: "AI Model connected" }).waitFor();
  assert.equal(requests[0].model, "claude-explicit");
  checks++;
  await page.close();
  discoveryFailure = false;

  listFailure = true;
  page = await open("?section");
  await page.getByRole("alert").filter({ hasText: "temporarily unavailable" }).waitFor();
  assert.equal(await page.getByLabel("API key", { exact: true }).count(), 0);
  checks++;
  listFailure = false;
  await page.getByRole("button", { name: "Try loading AI Models again" }).click();
  await page.getByLabel("API key", { exact: true }).waitFor();
  checks++;
  await page.close();

  // The "where do I get a key" link follows the service chosen above it: none for
  // a ChatGPT sign-in or a custom endpoint, which have no key to get.
  page = await open();
  const anthropicLink = page.getByRole("link", { name: "Get an Anthropic key" });
  const openaiLink = page.getByRole("link", { name: "Get an OpenAI key" });
  await anthropicLink.waitFor();
  assert.equal(
    await anthropicLink.getAttribute("href"),
    "https://console.anthropic.com/settings/keys",
  );
  assert.equal(await openaiLink.count(), 0);
  checks++;
  await choose(page, "AI Model service", "OpenAI / ChatGPT");
  await openaiLink.waitFor();
  assert.equal(await openaiLink.getAttribute("href"), "https://platform.openai.com/api-keys");
  assert.equal(await anthropicLink.count(), 0);
  checks++;
  await choose(page, "Connect with", "ChatGPT sign-in");
  assert.equal((await openaiLink.count()) + (await anthropicLink.count()), 0);
  checks++;
  await choose(page, "AI Model service", "Custom endpoint");
  assert.equal((await openaiLink.count()) + (await anthropicLink.count()), 0);
  checks++;
  await page.close();

  // With nothing in the company yet, an employee with no AI Model gets the
  // connect form, with no claim that every employee must paste their own key.
  page = await open("?section");
  await page.getByLabel("API key", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Each AI Employee keeps their own", { exact: false }).count(),
    0,
  );
  assert.equal(await page.getByRole("button", { name: /Use the same AI Model as/ }).count(), 0);
  checks++;
  await page.close();

  // A company that already has an AI Model leads with it. Using it attaches the
  // very same model — its keys stay where they are — so the screen never asks
  // for one; connecting a different model is the quieter path, and the other
  // models the company has are listed there.
  companyRows = [
    connectedRow({
      id: "source-model",
      isActive: false,
      employees: [{ id: "casey", name: "Casey", slug: "casey", avatarKey: null, isActive: true }],
    }),
    connectedRow({
      id: "endpoint-model",
      // Older than Casey's: with as many users each, the newest leads.
      createdAt: "2026-09-01T12:00:00Z",
      provider: "custom",
      model: "qwen3-27b",
      authMode: "customEndpoint",
      isActive: false,
      apiKeys: [],
      customEndpointHost: "gpu-box.internal:8000",
      customEndpointModelId: "qwen3-27b",
      employees: [{ id: "sam", name: "Sam", slug: "sam", avatarKey: null, isActive: true }],
    }),
  ];
  page = await open("?section");
  const useCompanyModel = page.getByRole("button", {
    name: "Use the same AI Model as Casey",
    exact: true,
  });
  await useCompanyModel.waitFor();
  await page.getByText("Claude (Anthropic) · claude-sonnet-live", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("API key", { exact: true }).count(), 0);
  assert.equal(
    await page.getByText("Each AI Employee keeps their own", { exact: false }).count(),
    0,
  );
  checks++;
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks++;
  await page.screenshot({ path: path.join(artifacts, "model-attach-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.getByRole("button", { name: "Connect a different model", exact: true }).click();
  await page.getByLabel("API key", { exact: true }).waitFor();
  assert.equal(await useCompanyModel.count(), 0);
  await page.getByText("Custom endpoint · qwen3-27b", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Use this one", exact: true }).count(), 1);
  checks++;
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await useCompanyModel.waitFor();
  checks++;
  attachFailure = true;
  await useCompanyModel.click();
  await page.getByRole("alert").filter({ hasText: "isn't connected yet" }).waitFor();
  assert.equal(await useCompanyModel.isEnabled(), true);
  assert.deepEqual(modelRows, []);
  checks++;
  attachFailure = false;
  await useCompanyModel.click();
  await page.getByText("Connected with an API key", { exact: false }).waitFor();
  assert.deepEqual(attachRequests.at(-1), { modelId: "source-model" });
  // The card says who else runs on the model it now shares.
  await page.getByText("Also used by Casey", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Claude (Anthropic) · claude-sonnet-live", { exact: true }).count(),
    1,
  );
  assert.doesNotMatch(await page.locator("main").innerText(), /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  checks++;
  await page.close();

  // Only an owner or admin can choose an employee's model: a Member is not
  // offered the shortcut (and the company's list is never requested for them),
  // nor a form the server would refuse — they are told who connects one.
  modelRows = [];
  companyListRequests = 0;
  page = await open("?section&role=member");
  await page.getByText("Avery has no AI Model yet", { exact: true }).waitFor();
  await page.getByText("An owner or admin of Company connects one here.", { exact: false }).waitFor();
  assert.equal(await page.getByLabel("API key", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: /Use the same AI Model as/ }).count(), 0);
  assert.equal(companyListRequests, 0);
  checks++;
  await page.close();
  companyRows = [];
  modelRows = [];

  // A connected model is one card: its name, a badge, Test connection, and its
  // own Advanced section, closed, saying what it holds. Adding another model is
  // the page's own button, outside every card.
  modelRows = [connectedRow()];
  page = await open("?section");
  await page.getByText("Claude (Anthropic) · claude-sonnet-live", { exact: true }).waitFor();
  await page.getByText("Connected with an API key", { exact: false }).waitFor();
  assert.doesNotMatch(await page.locator("main").innerText(), /ANTHROPIC_API_KEY|OPENAI_API_KEY/);
  const claudeCard = page.getByRole("group", { name: "Claude (Anthropic) · claude-sonnet-live" });
  await claudeCard.getByRole("button", { name: "Test connection", exact: true }).waitFor();
  const claudeAdvanced = claudeCard.getByRole("button", { name: /^Advanced/ });
  assert.equal(await claudeAdvanced.getAttribute("aria-expanded"), "false");
  assert.match(await claudeAdvanced.innerText(), /API keys, model, context window and Run limit/);
  await page.getByRole("button", { name: "Add an AI Model", exact: true }).waitFor();
  assert.equal(
    await claudeCard.getByRole("button", { name: "Add an AI Model", exact: true }).count(),
    0,
  );
  for (const hidden of [
    page.getByText("Context window", { exact: true }),
    page.getByText("Concurrent Routine Runs", { exact: true }),
    page.getByRole("button", { name: "Detach", exact: true }),
  ]) {
    assert.equal(await hidden.first().isVisible(), false);
  }
  checks++;
  await claudeAdvanced.click();
  for (const shown of [
    claudeCard.getByText("Context window", { exact: true }),
    claudeCard.getByText("Concurrent Routine Runs", { exact: true }),
    claudeCard.getByRole("button", { name: "Detach", exact: true }),
  ]) {
    await shown.first().waitFor({ state: "visible" });
  }
  checks++;
  await page.close();

  modelRows = [
    connectedRow({
      contextWindow: 65_536,
      contextWindowSource: "manual",
      maxConcurrentRuns: 2,
      effectiveMaxConcurrentRuns: 2,
      concurrencySource: "configured",
    }),
  ];
  page = await open("?section");
  await page
    .getByText("Context window set manually · 2 concurrent Runs", { exact: true })
    .waitFor({ state: "visible" });
  assert.equal(await page.getByText("Concurrent Routine Runs", { exact: true }).isVisible(), false);
  checks++;
  await page.close();

  // With several models the active one leads and the others offer Make active
  // without opening anything; each card keeps its own Advanced, and no line
  // outside the cards speaks for them all.
  modelRows = [
    connectedRow(),
    connectedRow({
      id: "gpt-model",
      provider: "openai",
      model: "gpt-live",
      isActive: false,
      contextWindow: null,
      contextWindowProbeable: false,
    }),
  ];
  page = await open("?section");
  await page.getByText("OpenAI · gpt-live", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Make active", exact: true }).waitFor();
  // One Active badge on screen, on the active card.
  assert.equal(
    await page.getByText("Active", { exact: true }).filter({ visible: true }).count(),
    1,
  );
  assert.equal(await page.getByRole("button", { name: /^Advanced/ }).count(), 2);
  const gptCard = page.getByRole("group", { name: "OpenAI · gpt-live" });
  await gptCard.getByRole("button", { name: "Make active", exact: true }).waitFor();
  assert.match(
    await gptCard.getByRole("button", { name: /^Advanced/ }).innerText(),
    /API keys, model, context window and Run limit/,
  );
  assert.equal(await page.getByText(/\d+ other AI Models?/).count(), 0);
  checks++;
  await page.close();
  modelRows = [];

  // Creating a custom model uses one verified save, without a placeholder model row.
  page = await open();
  await choose(page, "AI Model service", "Custom endpoint");
  await page.getByLabel("Base URL", { exact: true }).fill("https://models.example.test/v1");
  await page.getByLabel("Model ID (optional)", { exact: true }).fill("custom-first");
  await page.getByLabel("API key (optional)", { exact: true }).fill("custom-test-key");
  customFailure = true;
  await page.getByRole("button", { name: "Connect AI Model" }).click();
  await page.getByRole("alert").filter({ hasText: "tool-use test" }).waitFor();
  assert.equal(
    await page.getByLabel("Model ID (optional)", { exact: true }).inputValue(),
    "custom-first",
  );
  checks++;
  assert.equal(
    await page.getByLabel("API key (optional)", { exact: true }).inputValue(),
    "custom-test-key",
  );
  checks++;
  customFailure = false;
  await page.getByRole("button", { name: "Connect AI Model" }).click();
  await page.getByRole("status").filter({ hasText: "AI Model connected" }).waitFor();
  assert.match(customRequests.at(-1)!.path, /\/connect-custom$/);
  checks++;
  // A model connected from an employee's page is attached to that employee.
  assert.deepEqual(customRequests.at(-1)!.body, {
    baseURL: "https://models.example.test/v1",
    modelId: "custom-first",
    apiKey: "custom-test-key",
    employeeIds: ["employee"],
  });
  checks++;
  await page.close();

  // Updating an existing custom model keeps the old card after a failed test.
  modelRows = [
    {
      id: "custom-model",
      companyId: "company",
      provider: "custom",
      model: "custom-original",
      authMode: "customEndpoint",
      isActive: true,
      createdAt: "2026-09-09T12:00:00Z",
      status: "connected",
      connectedAt: "2026-09-09T12:00:00Z",
      apiKeyMasked: null,
      apiKeys: [],
      apiKeyEnv: null,
      supportsApiKey: false,
      supportsSubscription: false,
      subscriptionAvailable: false,
      subscriptionUnavailableReason: null,
      subscriptionCredentialKind: null,
      subscriptionShellAvailable: false,
      supportsCustomEndpoint: true,
      customEndpointHost: "models.example.test",
      customEndpointModelId: "custom-original",
      customEndpointHasApiKey: true,
      contextWindow: 8192,
      contextWindowSource: "manual",
      contextWindowProbeable: false,
      maxConcurrentRuns: null,
      effectiveMaxConcurrentRuns: null,
      concurrencySource: "unlimited",
      employees: [
        { id: "employee", name: "Avery", slug: "avery", avatarKey: null, isActive: true },
      ],
      duplicateIds: [],
    },
  ];
  page = await open("?section");
  await page.getByText("Custom endpoint · custom-original", { exact: true }).waitFor();
  // Changing the endpoint is advanced: it sits in the card's own Advanced section,
  // closed until opened, and the form appears only when asked for.
  assert.equal(await page.getByLabel("Base URL", { exact: true }).isVisible(), false);
  const customCard = page.getByRole("group", { name: "Custom endpoint · custom-original" });
  await customCard.getByRole("button", { name: /^Advanced/ }).click();
  await customCard.getByText("models.example.test", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Base URL", { exact: true }).count(), 0);
  await customCard.getByRole("button", { name: "Change endpoint", exact: true }).click();
  assert.equal(await page.getByLabel("Base URL", { exact: true }).count(), 1);
  checks++;
  await page.getByLabel("Base URL", { exact: true }).fill("https://models.example.test/v1");
  await page.getByLabel("Model ID (optional)", { exact: true }).fill("custom-updated");
  customFailure = true;
  await page.getByRole("button", { name: "Save endpoint" }).click();
  await page.getByRole("alert").filter({ hasText: "tool-use test" }).waitFor();
  assert.equal(
    await page.getByText("Custom endpoint · custom-original", { exact: true }).count(),
    1,
  );
  checks++;
  assert.equal(
    await page.getByLabel("Model ID (optional)", { exact: true }).inputValue(),
    "custom-updated",
  );
  checks++;
  customFailure = false;
  await page.getByRole("button", { name: "Save endpoint" }).click();
  await page.getByText("Custom endpoint · custom-updated", { exact: true }).waitFor();
  assert.match(customRequests.at(-1)!.path, /\/custom-model\/custom-endpoint$/);
  checks++;
  assert.equal(customRequests.at(-1)!.body.modelId, "custom-updated");
  checks++;
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  checks++;
  await page.screenshot({
    path: path.join(artifacts, "model-setup-custom-mobile.png"),
    fullPage: true,
  });
  await page.close();
  assert.deepEqual(pageErrors, []);
  console.log(`Model setup: ${checks} browser checks passed.`);
} catch (error) {
  const page = currentPage as Page | null;
  if (page && !page.isClosed()) {
    await page
      .screenshot({
        path: path.join(artifacts, "model-setup-failure.png"),
        fullPage: true,
        timeout: 10_000,
      })
      .catch(() => undefined);
    const body = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "No page body rendered.");
    await fs.writeFile(
      path.join(artifacts, "model-setup-failure.txt"),
      `${String(error)}\n${pageErrors.join("\n")}\nPending assets:\n${[...pendingAssets].join("\n")}\nFailed assets:\n${failedAssets.join("\n")}\n${body}`,
    );
  }
  throw error;
} finally {
  releaseHeldDiscovery();
  await context.close();
  await browser.close();
  await server.close();
}
