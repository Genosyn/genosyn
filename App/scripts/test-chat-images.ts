/** Run with `npm run test:chat-images`; uses local Chrome or GENOSYN_TEST_BROWSER.
 * Uses actual React composers and real browser clipboard/file events. APIs are
 * stubbed here; server regression tests cover authorization, persistence and models.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { browserTestVite } from "./browserTestVite";
import { createCanvas } from "@napi-rs/canvas";
import { chromium, type Page } from "playwright-core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 18472, strictPort: true, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-chat-images"),
  plugins: [
    {
      name: "chat-image-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__chat_images", async (_req, res) => {
          const html = await dev.transformIndexHtml(
            "/__chat_images",
            '<html><div id="root"></div><script type="module" src="/@fs' +
              root +
              '/scripts/chatImageHarness.tsx"></script></html>',
          );
          res.setHeader("Content-Type", "text/html");
          res.end(html);
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
const context = await browser
  .newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 1440, height: 1000 },
  })
  .catch(async (error) => {
    await browser.close();
    await server.close();
    throw error;
  });
const canvas = createCanvas(32, 24);
canvas.getContext("2d").fillRect(0, 0, 32, 24);
const png = canvas.toBuffer("image/png").toString("base64");
const employee = {
  id: "employee",
  name: "Alex",
  slug: "alex",
  role: "Engineer",
  model: { id: "model", status: "connected" },
  models: [
    {
      id: "model",
      provider: "openai",
      model: "gpt-4.1",
      label: "GPT 4.1",
      status: "connected",
      isActive: true,
    },
  ],
  hasModel: true,
  ownsRoutine: true,
};
const session = {
  id: "session",
  title: "Check the screenshot",
  instruction: "Check the screenshot",
  employee,
  employeeId: employee.id,
  status: "empty",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  filesChanged: 0,
  insertions: 0,
  deletions: 0,
  branch: "genosyn/test",
  headCommit: null,
};
let uploads = 0;
const sends: Array<Record<string, unknown>> = [];
let delayUpload = false;
let failSend = false;
let failUpload = false;
let modelFailure = false;
const releaseUploads: Array<() => void> = [];
const turns: Array<Record<string, unknown>> = [];
const browserErrors: string[] = [];
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname;
  const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
  if (
    request.method() === "POST" &&
    request.headers()["content-type"]?.includes("multipart/form-data")
  ) {
    const id = `image-${++uploads}`;
    const attachment = {
      id,
      filename: "screenshot.png",
      mimeType: "image/png",
      isImage: true,
      sizeBytes: 68,
    };
    if (delayUpload) await new Promise<void>((resolve) => releaseUploads.push(resolve));
    if (failUpload) return json({ error: "Upload failed; retry the image" }, 500);
    return json(pathname.includes("/assistant/attachments") ? { attachment } : attachment, 201);
  }
  if (request.method() === "POST" && pathname.endsWith("/conversations"))
    return json({ id: "conversation", surface: "help", createdAt: new Date().toISOString() });
  if (request.method() === "POST") {
    const body = request.postDataJSON();
    sends.push(body);
    if (failSend) return json({ error: "Send failed; try again" }, 500);
    if (modelFailure && pathname.endsWith("/messages")) {
      const attachments = (body.attachmentIds ?? []).map((id: string) => ({
        id,
        filename: "screenshot.png",
        mimeType: "image/png",
        isImage: true,
        sizeBytes: 68,
      }));
      const user = {
        id: `user-${sends.length}`,
        role: "user",
        content: body.message,
        attachments,
        createdAt: new Date().toISOString(),
        actions: [],
        suggestions: [],
      };
      const assistant = {
        id: `assistant-${sends.length}`,
        role: "assistant",
        employeeId: employee.id,
        content: "Model temporarily unavailable",
        status: "error",
        attachments: [],
        actions: [],
        suggestions: [],
        createdAt: new Date().toISOString(),
      };
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: user\ndata: ${JSON.stringify(user)}\n\nevent: working\ndata: ${JSON.stringify({ ...assistant, status: "working" })}\n\nevent: assistant\ndata: ${JSON.stringify(assistant)}\n\nevent: done\ndata: {}\n\n`,
      });
    }
    if (pathname.endsWith("/sessions") || pathname.endsWith("/revise")) {
      turns.push({
        id: `turn-${turns.length}`,
        ordinal: turns.length + 1,
        instruction: body.instruction,
        reply: "I can see the image.",
        status: "ok",
        createdAt: new Date().toISOString(),
        attachments: (body.attachmentIds ?? []).map((id: string) => ({
          id,
          filename: "screenshot.png",
          mimeType: "image/png",
          isImage: true,
          sizeBytes: 68,
        })),
      });
      return json(pathname.endsWith("/revise") ? { session, turns } : session);
    }
    return json({ reply: "I can see the image.", status: "ok", employee });
  }
  if (pathname.endsWith("/session-candidates")) return json({ employees: [employee] });
  if (pathname.endsWith("/workspace/status")) return json({ branch: "main" });
  if (pathname.endsWith("/sessions"))
    return json({ sessions: pathname.includes("archived") ? [] : [session] });
  if (pathname.endsWith("/sessions/session")) return json({ session, turns });
  if (pathname.endsWith("/events")) return json({ events: [], more: false });
  if (pathname.endsWith("/diff")) return json({ patch: "", commits: [], files: [] });
  if (
    pathname.includes("/attachments/") ||
    pathname.includes("/session-attachments/") ||
    pathname.includes("/chat-attachments/") ||
    pathname.includes("/comment-attachments/") ||
    pathname.startsWith("/api/files/")
  )
    return route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") });
  if (pathname.endsWith("/employees")) return json([employee]);
  if (pathname.endsWith("/conversations"))
    return json([
      { id: "conversation", surface: "help", title: "Help", createdAt: new Date().toISOString() },
    ]);
  if (pathname.endsWith("/conversations/conversation"))
    return json({ conversation: { id: "conversation", surface: "help" }, messages: [] });
  if (pathname.endsWith("/assistant"))
    return json({ messages: [], roster: [employee], modelId: "model" });
  if (pathname.endsWith("/questions")) return json({ questions: [], employee });
  return json([]);
});

async function open(surface: string) {
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    browserErrors.push(`${surface}: ${error.message}`);
    console.error(`Browser error (${surface}): ${error.message}`);
  });
  const pending = new Set<string>();
  page.on("request", (request) => pending.add(request.url()));
  page.on("requestfinished", (request) => pending.delete(request.url()));
  page.on("requestfailed", (request) => {
    pending.delete(request.url());
    console.error(`Failed request: ${request.url()} ${request.failure()?.errorText}`);
  });
  try {
    await page.goto(`http://127.0.0.1:18472/__chat_images?surface=${surface}`, {
      waitUntil: "commit",
      timeout: 60000,
    });
    // The first visit compiles the real composer graph and Tailwind styles.
    // Subsequent assertions keep Playwright's normal, shorter action timeout.
    await page.locator("textarea").first().waitFor({ timeout: 300000 });
  } catch (error) {
    console.error("Unfinished browser requests:", [...pending]);
    throw error;
  }
  return page;
}
async function paste(page: Page, count = 1, text = "") {
  await page
    .locator("textarea")
    .first()
    .evaluate(
      (element, { png, count, text }) => {
        const data = new DataTransfer();
        for (let i = 0; i < count; i++)
          data.items.add(
            new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "screenshot.png", {
              type: "image/png",
            }),
          );
        if (text) data.setData("text/plain", text);
        element.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
        );
      },
      { png, count, text },
    );
}
async function waitUploads(page: Page, count: number) {
  await page
    .getByRole("button", { name: "Remove screenshot.png", exact: true })
    .nth(count - 1)
    .waitFor();
}
let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  console.log(`RUN ${name}`);
  await run();
  console.log(`PASS ${name}`);
  checks++;
}
try {
  await check("every AI composer accepts pasted screenshots with a removable preview", async () => {
    for (const surface of [
      "repository",
      "followup",
      "help",
      "mail",
      "routine",
      "base",
      "tldr",
      "todo",
    ]) {
      const page = await open(surface);
      await paste(page);
      await waitUploads(page, 1);
      assert.equal(await page.locator('img[alt="screenshot.png"]').count(), 1, surface);
      await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).click();
      assert.equal(await page.locator('img[alt="screenshot.png"]').count(), 0, surface);
      await page.close();
    }
  });
  await check(
    "repository accepts image-only initial and follow-up briefs and retains sent previews",
    async () => {
      for (const surface of ["repository", "followup"]) {
        const page = await open(surface);
        await paste(page);
        await waitUploads(page, 1);
        const before = sends.length;
        await page
          .getByRole("button", {
            name: surface === "repository" ? "Start with Alex" : "Send",
            exact: true,
          })
          .click();
        await page.waitForFunction(
          () => !document.querySelector('button[aria-label="Remove screenshot.png"]'),
        );
        assert.equal(sends.length, before + 1);
        assert.equal((sends.at(-1)!.attachmentIds as string[]).length, 1);
        assert.equal(sends.at(-1)!.instruction, "");
        await page.locator('img[alt="screenshot.png"]').first().waitFor();
        await page.close();
      }
    },
  );
  await check("failed repository send retains text and images for retry", async () => {
    failSend = true;
    const page = await open("repository");
    await page.locator("textarea").fill("Keep my draft");
    await paste(page);
    await waitUploads(page, 1);
    await page.getByRole("button", { name: "Start with Alex", exact: true }).click();
    await page.getByText("Send failed; try again", { exact: true }).waitFor();
    assert.equal(await page.locator("textarea").inputValue(), "Keep my draft");
    assert.equal(
      await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).count(),
      1,
    );
    failSend = false;
    await page.close();
  });
  await check("rejected sends retain images and text in every other AI composer", async () => {
    failSend = true;
    for (const surface of ["help", "mail", "routine", "base", "tldr", "todo"]) {
      const page = await open(surface);
      await page.locator("textarea").first().fill("Inspect this screenshot");
      await paste(page);
      await waitUploads(page, 1);
      const sent = page.waitForRequest(
        (request) =>
          request.method() === "POST" &&
          !request.headers()["content-type"]?.includes("multipart/form-data"),
      );
      await page
        .locator("textarea")
        .first()
        .press(
          surface === "base" || surface === "todo"
            ? process.platform === "darwin"
              ? "Meta+Enter"
              : "Control+Enter"
            : "Enter",
        );
      const request = await sent;
      assert.equal(request.postDataJSON().attachmentIds.length, 1, surface);
      await page.waitForFunction(
        () => document.querySelector("textarea")?.value === "Inspect this screenshot",
      );
      assert.equal(
        await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).count(),
        1,
        surface,
      );
      await page.close();
    }
    failSend = false;
  });
  await check(
    "an accepted image-only message can be retried after the AI reply fails",
    async () => {
      modelFailure = true;
      for (const surface of ["mail", "routine"]) {
        const page = await open(surface);
        await paste(page);
        await waitUploads(page, 1);
        await page.locator("textarea").first().press("Enter");
        await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
        assert.equal(
          await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).count(),
          0,
        );
        const sent = page.waitForRequest((request) => request.method() === "POST");
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        assert.ok((await sent).postDataJSON().message.trim().length > 0, surface);
        await page.close();
      }
      modelFailure = false;
    },
  );
  await check("real browser clipboard image pastes through the keyboard", async () => {
    const page = await open("staging");
    await page.bringToFront();
    await page.evaluate(async (png) => {
      const blob = new Blob([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], {
        type: "image/png",
      });
      await Promise.race([
        navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Clipboard write timed out")), 10000),
        ),
      ]);
    }, png);
    await page.locator("textarea").focus();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+V" : "Control+V");
    await waitUploads(page, 1);
    await page.close();
  });
  await check("concurrent pastes reserve slots, disable send and cannot exceed ten", async () => {
    const page = await open("staging");
    delayUpload = true;
    const before = uploads;
    await paste(page, 6);
    await paste(page, 6);
    await page.getByRole("alert").filter({ hasText: "at most 10" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
    delayUpload = false;
    // Each upload batch progresses sequentially; release its first request.
    for (const release of releaseUploads.splice(0)) release();
    await waitUploads(page, 10);
    assert.equal(uploads - before, 10);
    await page.close();
  });
  await check("switching drafts rejects delayed upload results", async () => {
    const page = await open("staging");
    delayUpload = true;
    await paste(page);
    await page.getByRole("status").filter({ hasText: "Uploading" }).waitFor();
    await page.getByRole("button", { name: "Switch draft" }).click();
    delayUpload = false;
    for (const release of releaseUploads.splice(0)) release();
    await page.getByRole("status").filter({ hasText: "Ready" }).waitFor();
    assert.equal(await page.locator('img[alt="screenshot.png"]').count(), 0);
    await paste(page);
    await waitUploads(page, 1);
    await page.close();
  });
  await check("upload failures recover their slots and show an actionable error", async () => {
    const page = await open("staging");
    failUpload = true;
    await paste(page);
    await page.getByRole("alert").filter({ hasText: "Upload failed" }).waitFor();
    failUpload = false;
    await paste(page);
    await waitUploads(page, 1);
    await page.close();
  });
  await check("dragging an image uses the same upload and preview flow", async () => {
    const page = await open("repository");
    await page.locator("textarea").evaluate((el, png) => {
      const dt = new DataTransfer();
      dt.items.add(
        new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "screenshot.png", {
          type: "image/png",
        }),
      );
      el.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }),
      );
    }, png);
    await waitUploads(page, 1);
    await fs.mkdir(path.resolve(root, "../output/playwright"), { recursive: true });
    await page.screenshot({
      path: path.resolve(root, "../output/playwright/repository-image-paste.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
    );
    await page.screenshot({
      path: path.resolve(root, "../output/playwright/repository-image-paste-mobile.png"),
      fullPage: true,
    });
    await page.close();
  });
  assert.deepEqual(browserErrors, [], "No browser runtime errors");
  console.log(`${checks} browser regression groups passed.`);
} finally {
  await browser.close();
  await server.close();
}
