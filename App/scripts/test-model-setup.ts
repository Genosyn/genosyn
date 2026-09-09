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
const server = await startBrowserFixture("modelSetupHarness.tsx", 18485);
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
let modelRows: AIModel[] = [];
const customRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
let holdDiscovery = false;
const discoveryGate: { release?: () => void } = {};
let requests: Array<Record<string, unknown>> = [];
const pageErrors: string[] = [];
const pendingAssets = new Set<string>();
const failedAssets: string[] = [];
let currentPage: Page | null = null;
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
        ? { status: 422, json: { error: "The model rejected this credential. Check the key." } }
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
  await page.getByRole("alert").filter({ hasText: "rejected this credential" }).waitFor();
  assert.equal(
    await page.getByLabel("API key", { exact: true }).inputValue(),
    "replacement-test-key",
  );
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

  // Creating a custom model uses one verified save, without a placeholder model row.
  page = await open();
  await choose(page, "AI Model service", "Custom endpoint");
  await page.getByLabel("Base URL", { exact: true }).fill("https://models.example.test/v1");
  await page.getByLabel("Model ID", { exact: true }).fill("custom-first");
  await page.getByLabel("API key (optional)", { exact: true }).fill("custom-test-key");
  customFailure = true;
  await page.getByRole("button", { name: "Connect AI Model" }).click();
  await page.getByRole("alert").filter({ hasText: "tool-use test" }).waitFor();
  assert.equal(await page.getByLabel("Model ID", { exact: true }).inputValue(), "custom-first");
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
  assert.deepEqual(customRequests.at(-1)!.body, {
    baseURL: "https://models.example.test/v1",
    modelId: "custom-first",
    apiKey: "custom-test-key",
  });
  checks++;
  await page.close();

  // Updating an existing custom model keeps the old card after a failed test.
  modelRows = [
    {
      id: "custom-model",
      employeeId: "employee",
      provider: "custom",
      model: "custom-original",
      authMode: "customEndpoint",
      isActive: true,
      status: "connected",
      connectedAt: "2026-09-09T12:00:00Z",
      apiKeyMasked: null,
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
    },
  ];
  page = await open("?section");
  await page.getByText("custom · custom-original", { exact: true }).waitFor();
  await page.getByText("Change provider, model, or endpoint", { exact: true }).click();
  assert.equal(await page.getByLabel("Base URL", { exact: true }).count(), 1);
  checks++;
  await page.getByLabel("Base URL", { exact: true }).fill("https://models.example.test/v1");
  await page.getByLabel("Model id", { exact: true }).fill("custom-updated");
  customFailure = true;
  await page.getByRole("button", { name: "Update endpoint" }).click();
  await page.getByRole("alert").filter({ hasText: "tool-use test" }).waitFor();
  assert.equal(await page.getByText("custom · custom-original", { exact: true }).count(), 1);
  checks++;
  assert.equal(await page.getByLabel("Model id", { exact: true }).inputValue(), "custom-updated");
  checks++;
  customFailure = false;
  await page.getByRole("button", { name: "Update endpoint" }).click();
  await page.getByText("custom · custom-updated", { exact: true }).waitFor();
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
