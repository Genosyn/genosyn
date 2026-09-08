/** Real-browser Work session model regressions. Run `npm run test:work-session-models`.
 * APIs are deterministic fixtures; server tests cover stored models and authorization.
 * Uses installed Chrome, or GENOSYN_TEST_BROWSER to choose another Playwright channel.
 * Set GENOSYN_TEST_FILTER to a group-name substring to run one regression while iterating.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { browserTestVite } from "./browserTestVite";
import { chromium, type Page, type WebSocketRoute } from "playwright-core";
import type { RepositoryWorkSessionCandidatesResponse } from "../client/lib/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 18473, strictPort: false, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-work-session-models"),
  plugins: [
    {
      name: "work-session-model-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__work_session_models", async (_request, response) => {
          const html = await dev.transformIndexHtml(
            "/__work_session_models",
            '<html><div id="root"></div><script type="module" src="/@fs' +
              root +
              '/scripts/workSessionModelHarness.tsx"></script></html>',
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
const sends: Array<{
  employeeId: string;
  modelId: string;
  instruction: string;
  attachmentIds: string[];
}> = [];
const browserErrors: string[] = [];
const liveSockets: WebSocketRoute[] = [];
let candidateRequests = 0;
let liveEmployees: RepositoryWorkSessionCandidatesResponse["employees"] = [];
await context.routeWebSocket(/\/api\/ws\?/, (socket) => liveSockets.push(socket));
let failSend = false;
let holdSend = false;
const pendingSends: Array<() => void> = [];
function releaseSends() {
  for (const release of pendingSends.splice(0)) release();
}
let checks = 0;
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const pathname = new URL(request.url()).pathname;
  if (pathname.endsWith("/ws-token")) return route.fulfill({ json: { token: "fixture-token" } });
  if (request.method() === "GET" && pathname.endsWith("/session-candidates")) {
    candidateRequests++;
    return route.fulfill({ json: { employees: liveEmployees } });
  }
  if (request.method() === "GET" && pathname.endsWith("/sessions"))
    return route.fulfill({ json: { sessions: [] } });
  if (pathname.endsWith("/workspace/status")) return route.fulfill({ json: { branch: "main" } });
  if (request.method() === "POST" && pathname.endsWith("/session-attachments")) {
    return route.fulfill({
      status: 201,
      json: {
        id: "attachment",
        filename: "brief.txt",
        mimeType: "text/plain",
        isImage: false,
        sizeBytes: 12,
      },
    });
  }
  if (request.method() === "POST" && pathname.endsWith("/sessions")) {
    sends.push(request.postDataJSON());
    if (holdSend)
      await new Promise<void>((resolve) => {
        pendingSends.push(resolve);
      });
    if (failSend)
      return route.fulfill({
        status: 400,
        json: { error: "The selected AI Model is no longer connected." },
      });
    return route.fulfill({
      json: { id: "session", employeeId: sends.at(-1)!.employeeId, status: "running" },
    });
  }
  return route.fulfill({ json: [] });
});

async function open(scenario = "multiple") {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
    console.error(`Browser error: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`Browser console: ${message.text()}`);
  });
  page.on("requestfailed", (request) =>
    console.error(`Failed request: ${request.url()} ${request.failure()?.errorText}`),
  );
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${server.resolvedUrls!.local[0]}__work_session_models?scenario=${scenario}`, {
    waitUntil: "commit",
    timeout: 60000,
  });
  try {
    const ready =
      scenario === "live"
        ? page.getByRole("heading", { name: "AI work", exact: true })
        : page.getByRole("region", { name: "Test fixture controls" });
    await ready.waitFor({ timeout: Number(process.env.GENOSYN_TEST_LOAD_TIMEOUT ?? 300000) });
  } catch (error) {
    await fs.mkdir(path.resolve(root, "../output/playwright"), { recursive: true });
    await page.screenshot({
      path: path.resolve(root, `../output/playwright/work-session-models-failed-${scenario}.png`),
      fullPage: true,
    });
    console.error("Browser page:", await page.locator("body").innerText());
    throw error;
  }
  return page;
}
async function choose(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function modelValue(page: Page) {
  return page.getByRole("combobox", { name: "AI Model", exact: true }).inputValue();
}
async function send(page: Page, name = "Alex") {
  const count = Number(await page.getByRole("status", { name: "Started count" }).textContent());
  await page.getByRole("button", { name: `Start with ${name}`, exact: true }).click();
  await page.waitForFunction(
    (before) =>
      Number(document.querySelector('output[aria-label="Started count"]')?.textContent) ===
      before + 1,
    count,
  );
  return sends.at(-1)!;
}
async function check(name: string, run: () => Promise<void>) {
  if (process.env.GENOSYN_TEST_FILTER && !name.includes(process.env.GENOSYN_TEST_FILTER)) return;
  console.log(`RUN ${name}`);
  await run();
  console.log(`PASS ${name}`);
  checks++;
}
try {
  await check(
    "all assigned models are shown; default selected; disconnected options unavailable",
    async () => {
      const page = await open();
      assert.equal(await modelValue(page), "Claude Sonnet (default)");
      await page.getByRole("combobox", { name: "AI Model", exact: true }).click();
      assert.deepEqual(await page.getByRole("option").allTextContents(), [
        "GPT 5.4",
        "Claude Sonnet (default)",
        "Company local model — Not connected",
      ]);
      assert.equal(
        await page
          .getByRole("option", { name: "Company local model — Not connected", exact: true })
          .getAttribute("aria-disabled"),
        "true",
      );
      await page.keyboard.press("Escape");
      await page.close();
    },
  );

  await check(
    "an alternate model is sent in the Work session request without changing the default",
    async () => {
      const page = await open();
      await page
        .getByRole("textbox", { name: "Work brief" })
        .fill("  Implement the requested outcome  ");
      await choose(page, "AI Model", "GPT 5.4");
      assert.deepEqual(await send(page), {
        employeeId: "alex",
        modelId: "gpt",
        instruction: "Implement the requested outcome",
        attachmentIds: [],
      });
      assert.equal(await page.getByRole("textbox", { name: "Work brief" }).inputValue(), "");
      await page.getByRole("combobox", { name: "AI Model", exact: true }).click();
      await page.getByRole("option", { name: "Claude Sonnet (default)", exact: true }).waitFor();
      await page.close();
    },
  );

  await check("one model hides the picker and submits that model automatically", async () => {
    const page = await open("one");
    assert.equal(await page.getByRole("combobox", { name: "AI Model", exact: true }).count(), 0);
    await page.getByRole("textbox", { name: "Work brief" }).fill("Write the release notes");
    const request = await send(page, "Jamie");
    assert.equal(request.employeeId, "jamie");
    assert.equal(request.modelId, "jamie-gpt");
    await page.close();
  });

  await check(
    "switching employees updates models and resets a previous employee's explicit choice",
    async () => {
      const page = await open();
      await choose(page, "AI Model", "GPT 5.4");
      await choose(page, "AI employee", "Jamie");
      assert.equal(await page.getByRole("combobox", { name: "AI Model", exact: true }).count(), 0);
      await choose(page, "AI employee", "Alex");
      assert.equal(await modelValue(page), "Claude Sonnet (default)");
      await page.close();
    },
  );

  await check("zero or disconnected models block both mouse and keyboard submissions", async () => {
    for (const scenario of ["none", "disconnected", "single-disconnected"]) {
      const page = await open(scenario);
      await page.getByRole("textbox", { name: "Work brief" }).fill("Preserve this brief");
      const employee = scenario === "none" ? "Sam" : "Alex";
      await page
        .getByText(`Connect an AI Model for ${employee} before starting a Work session.`, {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: `Start with ${employee}` }).isDisabled(),
        true,
      );
      const before = sends.length;
      await page.getByRole("textbox", { name: "Work brief" }).press("Control+Enter");
      assert.equal(sends.length, before);
      assert.equal(
        await page.getByRole("textbox", { name: "Work brief" }).inputValue(),
        "Preserve this brief",
      );
      assert.equal(
        await page.getByRole("combobox", { name: "AI Model", exact: true }).count(),
        scenario === "disconnected" ? 1 : 0,
      );
      await page.close();
    }
  });

  await check(
    "refreshing model order retains selection; removal or disconnection falls back safely",
    async () => {
      for (const change of ["Remove GPT", "Disconnect GPT"]) {
        const page = await open();
        await choose(page, "AI Model", "GPT 5.4");
        await page.getByRole("button", { name: "Reorder models", exact: true }).click();
        assert.equal(await modelValue(page), "GPT 5.4");
        await page.getByRole("button", { name: change, exact: true }).click();
        assert.equal(await modelValue(page), "Claude Sonnet (default)");
        await page.getByRole("textbox", { name: "Work brief" }).fill("Use the available model");
        assert.equal((await send(page)).modelId, "claude");
        await page.close();
      }
    },
  );

  await check(
    "default refresh is reflected unless the Member has made an explicit choice",
    async () => {
      const page = await open();
      await page.getByRole("button", { name: "Make GPT default", exact: true }).click();
      assert.equal(await modelValue(page), "GPT 5.4 (default)");
      await choose(page, "AI Model", "Claude Sonnet");
      await page.getByRole("button", { name: "Load employees", exact: true }).click();
      await page.getByRole("button", { name: "Make GPT default", exact: true }).click();
      assert.equal(await modelValue(page), "Claude Sonnet");
      await page.close();
    },
  );

  await check(
    "removing the selected employee cannot send their stale id with another employee's model",
    async () => {
      const page = await open();
      await choose(page, "AI Model", "GPT 5.4");
      await page.getByRole("button", { name: "Remove Alex", exact: true }).click();
      assert.equal(
        await page.getByRole("combobox", { name: "AI employee", exact: true }).inputValue(),
        "Jamie",
      );
      await page
        .getByRole("textbox", { name: "Work brief" })
        .fill("Start with the remaining employee");
      const request = await send(page, "Jamie");
      assert.equal(request.employeeId, "jamie");
      assert.equal(request.modelId, "jamie-gpt");
      await page.close();
    },
  );

  await check(
    "failed starts preserve model, brief and attachment for a successful retry",
    async () => {
      const page = await open();
      await choose(page, "AI Model", "GPT 5.4");
      await page.getByRole("textbox", { name: "Work brief" }).fill("Keep my brief and attachment");
      await page.getByLabel("Attach files to work brief").setInputFiles({
        name: "brief.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Test brief"),
      });
      await page.getByRole("button", { name: "Remove brief.txt", exact: true }).waitFor();
      failSend = true;
      await page.getByRole("button", { name: "Start with Alex", exact: true }).click();
      await page
        .getByText("The selected AI Model is no longer connected.", { exact: true })
        .waitFor();
      assert.equal(await modelValue(page), "GPT 5.4");
      assert.equal(
        await page.getByRole("textbox", { name: "Work brief" }).inputValue(),
        "Keep my brief and attachment",
      );
      assert.equal(
        await page.getByRole("button", { name: "Remove brief.txt", exact: true }).count(),
        1,
      );
      failSend = false;
      await choose(page, "AI Model", "Claude Sonnet (default)");
      assert.equal(
        await page
          .getByText("The selected AI Model is no longer connected.", { exact: true })
          .count(),
        0,
      );
      const request = await send(page);
      assert.equal(request.modelId, "claude");
      assert.deepEqual(request.attachmentIds, ["attachment"]);
      assert.equal(
        await page.getByRole("button", { name: "Remove brief.txt", exact: true }).count(),
        0,
      );
      await page.close();
    },
  );

  await check(
    "keyboard submission uses the selected model and locks both pickers until it finishes",
    async () => {
      const page = await open();
      await choose(page, "AI Model", "GPT 5.4");
      await page.getByRole("textbox", { name: "Work brief" }).fill("Keyboard start");
      holdSend = true;
      const requestPromise = page.waitForRequest(
        (request) => request.method() === "POST" && request.url().endsWith("/sessions"),
      );
      await page.getByRole("textbox", { name: "Work brief" }).press("Control+Enter");
      const request = await requestPromise;
      assert.equal(request.postDataJSON().modelId, "gpt");
      assert.equal(
        await page.getByRole("combobox", { name: "AI Model", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole("combobox", { name: "AI employee", exact: true }).isDisabled(),
        true,
      );
      await page.getByRole("button", { name: "Starting…", exact: true }).waitFor();
      const before = sends.length;
      await page.getByRole("textbox", { name: "Work brief" }).press("Control+Enter");
      assert.equal(sends.length, before);
      holdSend = false;
      releaseSends();
      await page.waitForFunction(
        () => document.querySelector('output[aria-label="Started count"]')?.textContent === "1",
      );
      assert.equal(
        await page.getByRole("combobox", { name: "AI Model", exact: true }).isEnabled(),
        true,
      );
      await page.close();
    },
  );

  await check("loading, failed loading and empty employee states recover correctly", async () => {
    for (const scenario of ["loading", "error", "empty"]) {
      const page = await open(scenario);
      assert.equal(await page.getByRole("combobox", { name: "AI Model", exact: true }).count(), 0);
      if (scenario === "error") {
        await page.getByText("Could not load AI employees", { exact: true }).waitFor();
        await page.getByRole("button", { name: /retry/i }).click();
      } else {
        if (scenario === "empty")
          await page.getByText("No employee can work here yet", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Load employees", exact: true }).click();
      }
      assert.equal(await modelValue(page), "Claude Sonnet (default)");
      await page.close();
    }
  });

  await check("the picker is usable by keyboard and fits on narrow screens", async () => {
    const page = await open();
    const picker = page.getByRole("combobox", { name: "AI Model", exact: true });
    const pickerId = await picker.getAttribute("id");
    assert.ok(pickerId);
    async function waitForHighlight(name: string) {
      const option = page.getByRole("option", { name, exact: true });
      await option.waitFor();
      const optionId = await option.getAttribute("id");
      assert.ok(optionId);
      await page.waitForFunction(
        ([inputId, activeId]) =>
          document.getElementById(inputId)?.getAttribute("aria-activedescendant") === activeId,
        [pickerId!, optionId],
      );
    }
    await picker.focus();
    // Opening the menu highlights its selection in an effect. Wait for that
    // visible state before navigating, then for ArrowUp before accepting it.
    await waitForHighlight("Claude Sonnet (default)");
    await picker.press("ArrowUp");
    await waitForHighlight("GPT 5.4");
    await picker.press("Enter");
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.equal(await modelValue(page), "GPT 5.4");
    await fs.mkdir(path.resolve(root, "../output/playwright"), { recursive: true });
    await page.screenshot({
      path: path.resolve(root, "../output/playwright/work-session-models-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.getByRole("combobox", { name: "AI Model", exact: true }).click();
    const menu = await page.getByRole("listbox").boundingBox();
    assert.ok(menu && menu.x >= 0 && menu.x + menu.width <= 390);
    await page.screenshot({
      path: path.resolve(root, "../output/playwright/work-session-models-mobile.png"),
      fullPage: true,
    });
    await page.getByRole("option", { name: "Claude Sonnet (default)", exact: true }).click();
    assert.equal(await modelValue(page), "Claude Sonnet (default)");
    await page.close();
  });
  await check(
    "live employee events refresh the actual repository page's model choices",
    async () => {
      liveEmployees = [
        {
          id: "alex",
          name: "Alex",
          slug: "alex",
          role: "Engineer",
          avatarKey: null,
          models: [
            {
              id: "gpt",
              provider: "openai",
              model: "gpt-5.4",
              label: "GPT 5.4",
              status: "connected",
              isActive: false,
            },
            {
              id: "claude",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              label: "Claude Sonnet",
              status: "connected",
              isActive: true,
            },
            {
              id: "local",
              provider: "custom",
              model: "company-local",
              label: "Company local model",
              status: "not_connected",
              isActive: false,
            },
          ],
        },
      ];
      const page = await open("live");
      await page
        .getByRole("status", { name: "Company socket", exact: true })
        .filter({ hasText: "open" })
        .waitFor();
      await page.getByRole("combobox", { name: "AI Model", exact: true }).waitFor();
      await choose(page, "AI Model", "GPT 5.4");
      await page
        .getByRole("textbox", { name: "Work brief" })
        .fill("Keep this draft through model changes");
      const firstRead = candidateRequests;
      liveEmployees = liveEmployees.map((employee) => ({
        ...employee,
        models: employee.models.filter((model) => model.id !== "gpt"),
      }));
      const freshRead = page.waitForResponse((response) =>
        response.url().endsWith("/session-candidates"),
      );
      assert.ok(liveSockets.at(-1), "Company WebSocket connected");
      liveSockets
        .at(-1)!
        .send(JSON.stringify({ type: "resource.changed", kind: "employee", scopeIds: ["alex"] }));
      await freshRead;
      await page.waitForFunction(() => !document.querySelector('option[value="gpt"]'));
      assert.ok(candidateRequests > firstRead, "Employee event triggered a fresh candidates read");
      assert.equal(await modelValue(page), "Claude Sonnet (default)");
      assert.equal(
        await page.getByRole("textbox", { name: "Work brief" }).inputValue(),
        "Keep this draft through model changes",
      );

      // A reconnect/default change emitted for the employee must update this page too.
      liveEmployees = liveEmployees.map((employee) => ({
        ...employee,
        models: employee.models.map((model) => ({
          ...model,
          status: "connected",
          isActive: model.id === "local",
        })),
      }));
      const reconnectedRead = page.waitForResponse((response) =>
        response.url().endsWith("/session-candidates"),
      );
      liveSockets
        .at(-1)!
        .send(JSON.stringify({ type: "resource.changed", kind: "employee", scopeIds: ["alex"] }));
      await reconnectedRead;
      await page.waitForFunction(() =>
        Array.from(document.querySelectorAll('input[role="combobox"]')).some(
          (element) => (element as HTMLInputElement).value === "Company local model (default)",
        ),
      );
      assert.equal(await modelValue(page), "Company local model (default)");
      await page.close();
    },
  );
  assert.deepEqual(browserErrors, [], "No browser runtime errors");
  console.log(`${checks} Work session model browser regression groups passed.`);
} finally {
  holdSend = false;
  releaseSends();
  await browser.close();
  await server.close();
}
