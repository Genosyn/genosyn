/** Run with `npm run test:chat-images`; uses local Chrome or GENOSYN_TEST_BROWSER.
 * Add `-- "check name substring"` to run one regression group while iterating.
 * Uses actual React composers and real browser clipboard/file events. APIs are
 * stubbed here; server regression tests cover authorization, persistence and models.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { browserTestVite } from "./browserTestVite";
import { createCanvas } from "@napi-rs/canvas";
import { chromium, type Page } from "playwright-core";
import { xlsxFixture, xlsxCell } from "../server/test/xlsxFixtures.js";
import { XLSX_MIME } from "../server/services/xlsxPackage.js";
import { readXlsx } from "../server/services/xlsxRead.js";
import { editXlsx } from "../server/services/xlsxEdit.js";
import type { TldrQuestionsResponse } from "../client/lib/tldrQuestions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let completedWorkbook: Buffer = Buffer.alloc(0);
type ControlledReply = {
  body: Record<string, unknown>;
  response: ServerResponse;
  assistant: Record<string, unknown>;
  completed: boolean;
};
let controlledReplies = false;
let activeReplies = 0;
let maxActiveReplies = 0;
const replies: ControlledReply[] = [];
const assistantHistory = new Map<string, Array<Record<string, unknown>>>();
function streamEvent(response: ServerResponse, event: string, data: unknown) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function finishReply(reply: ControlledReply, status: "ok" | "error" = "ok") {
  assert.equal(reply.completed, false, "Each reply finishes only once");
  reply.completed = true;
  activeReplies--;
  reply.assistant.status = status;
  reply.assistant.content =
    status === "ok" ? `Finished: ${reply.body.message}` : "Model temporarily unavailable";
  streamEvent(reply.response, "assistant", reply.assistant);
  streamEvent(reply.response, "done", {});
  reply.response.end();
}
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 18472, strictPort: true, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-chat-images"),
  plugins: [
    {
      name: "chat-image-browser-fixture",
      configureServer(dev) {
        // Real HTTP streaming lets the member interact after partial text has
        // appeared and before the AI finishes. Intercepted fulfill responses
        // arrive all at once, which cannot exercise a busy composer or queue.
        dev.middlewares.use(async (req, res, next) => {
          const pathname = new URL(req.url ?? "/", "http://fixture").pathname;
          if (
            !controlledReplies ||
            req.method !== "POST" ||
            !pathname.endsWith("/assistant/messages")
          )
            return next();
          let raw = "";
          for await (const chunk of req) raw += chunk.toString();
          const body = JSON.parse(raw) as Record<string, unknown>;
          sends.push(body);
          const createdAt = new Date().toISOString();
          const user = {
            id: `controlled-user-${replies.length}`,
            role: "user",
            content: body.message,
            attachments: ((body.attachmentIds ?? []) as string[]).map((id) => ({
              id,
              filename: "screenshot.png",
              mimeType: "image/png",
              isImage: true,
              sizeBytes: 68,
            })),
            actions: [],
            suggestions: [],
            createdAt,
          };
          const assistant = {
            id: `controlled-assistant-${replies.length}`,
            role: "assistant",
            employeeId: employee.id,
            content: `Checking: ${body.message}`,
            status: "working",
            attachments: [],
            actions: [],
            suggestions: [],
            createdAt,
          };
          const key = `${pathname.replace(/\/messages$/, "")}:${body.threadId ?? ""}`;
          const history = assistantHistory.get(key) ?? [];
          history.push(user, assistant);
          assistantHistory.set(key, history);
          replies.push({ body, response: res, assistant, completed: false });
          activeReplies++;
          maxActiveReplies = Math.max(maxActiveReplies, activeReplies);
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.flushHeaders();
          streamEvent(res, "user", user);
          streamEvent(res, "target", { employee });
          streamEvent(res, "working", { ...assistant, content: "" });
          streamEvent(res, "chunk", { text: assistant.content });
        });
        // Chromium downloads can bypass page request interception. Serve the
        // real workbook bytes so the browser exercises a complete HTTP download.
        dev.middlewares.use(
          "/api/companies/company/mail/accounts/account/assistant/attachments/workbook-completed",
          (_req, res) => {
            res.setHeader("Content-Type", XLSX_MIME);
            res.setHeader("Content-Disposition", 'attachment; filename="supplier-edited.xlsx"');
            res.end(completedWorkbook);
          },
        );
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
let workbookMode = false;
let uploadedWorkbook: Buffer = Buffer.alloc(0);
const releaseUploads: Array<() => void> = [];
const turns: Array<Record<string, unknown>> = [];
const browserErrors: string[] = [];
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  const pathname = url.pathname;
  const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
  if (controlledReplies && request.method() === "POST" && pathname.endsWith("/assistant/messages"))
    return route.continue();
  if (workbookMode && request.method() === "GET" && pathname.endsWith("/workbook-completed")) {
    return route.continue();
  }
  if (
    request.method() === "POST" &&
    request.headers()["content-type"]?.includes("multipart/form-data")
  ) {
    if (workbookMode) {
      assert.ok(
        request.postDataBuffer()?.includes(uploadedWorkbook),
        "Upload preserves the original workbook bytes",
      );
      return json(
        {
          attachment: {
            id: "workbook-source",
            filename: "supplier.xlsx",
            mimeType: XLSX_MIME,
            isImage: false,
            sizeBytes: uploadedWorkbook.length,
          },
        },
        201,
      );
    }
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
    if (workbookMode && pathname.endsWith("/messages")) {
      assert.deepEqual(body.attachmentIds, ["workbook-source"]);
      const read = await readXlsx(uploadedWorkbook);
      assert.ok(read.sheets.some((sheet) => sheet.name === "Supplier"));
      completedWorkbook = (
        await editXlsx(uploadedWorkbook, [
          { sheet: "Supplier", cell: "B1", value: "Example Company" },
        ])
      ).bytes;
      const user = {
        id: "workbook-request",
        role: "user",
        content: body.message,
        attachments: [
          {
            id: "workbook-source",
            filename: "supplier.xlsx",
            mimeType: XLSX_MIME,
            sizeBytes: uploadedWorkbook.length,
          },
        ],
        createdAt: new Date().toISOString(),
        actions: [],
        suggestions: [],
      };
      const assistant = {
        id: "workbook-reply",
        role: "assistant",
        employeeId: employee.id,
        content: "The original Excel form is filled. The completed workbook is attached.",
        status: "ok",
        attachments: [
          {
            id: "workbook-completed",
            filename: "supplier-edited.xlsx",
            mimeType: XLSX_MIME,
            sizeBytes: completedWorkbook.length,
          },
        ],
        createdAt: new Date().toISOString(),
        actions: [],
        suggestions: [],
      };
      return route.fulfill({
        contentType: "text/event-stream",
        body: `event: user\ndata: ${JSON.stringify(user)}\n\nevent: assistant\ndata: ${JSON.stringify(assistant)}\n\nevent: done\ndata: {}\n\n`,
      });
    }
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
    return json({
      messages: controlledReplies
        ? (assistantHistory.get(`${pathname}:${url.searchParams.get("threadId") ?? ""}`) ?? [])
        : [],
      roster: [employee],
      modelId: "model",
    });
  if (pathname.endsWith("/questions"))
    return json({
      questions: [],
      canAsk: true,
      canDelegateAutomation: true,
      maxQuestions: 12,
    } satisfies TldrQuestionsResponse);
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
const checkName = process.argv[2];
async function check(name: string, run: () => Promise<void>) {
  if (checkName && !name.includes(checkName)) return;
  console.log(`RUN ${name}`);
  await run();
  console.log(`PASS ${name}`);
  checks++;
}
try {
  await check(
    "Excel form uploads in Mail, is edited, and downloads as a readable workbook",
    async () => {
      workbookMode = true;
      uploadedWorkbook = await xlsxFixture({
        sheets: [
          {
            name: "Supplier",
            rows: `<row r="1">${xlsxCell("A1", "Company name")}<c r="B1" s="0"/></row>`,
          },
        ],
      });
      const page = await open("mail");
      await page
        .locator('input[type="file"]')
        .setInputFiles({ name: "supplier.xlsx", mimeType: XLSX_MIME, buffer: uploadedWorkbook });
      await page.getByRole("button", { name: "Remove supplier.xlsx", exact: true }).waitFor();
      await page
        .locator("textarea")
        .first()
        .fill("Fill the original Excel form with Example Company.");
      await page.locator("textarea").first().press("Enter");
      const output = page.getByTitle("Download supplier-edited.xlsx", { exact: true });
      await output.waitFor();
      const downloadPromise = page.waitForEvent("download");
      await output.click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), "supplier-edited.xlsx");
      const downloaded = await fs.readFile((await download.path())!);
      assert.ok(
        downloaded.equals(completedWorkbook),
        `Downloaded the completed workbook from ${download.url()}`,
      );
      const result = await readXlsx(downloaded);
      assert.equal(
        result.sheets[0].cells.find((cell) => cell.cell === "B1")?.value,
        "Example Company",
      );
      assert.equal(
        (await readXlsx(uploadedWorkbook)).sheets[0].cells.find((cell) => cell.cell === "B1")
          ?.value,
        null,
      );
      await fs.mkdir(path.resolve(root, "../output/playwright"), { recursive: true });
      await page.screenshot({
        path: path.resolve(root, "../output/playwright/excel-workbook-mail.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      await page.close();
      workbookMode = false;
    },
  );
  await check(
    "Mail and Routine show ongoing work and drain removable follow-ups serially across panel navigation",
    async () => {
      controlledReplies = true;
      for (const surface of ["mail", "routine"]) {
        assistantHistory.clear();
        maxActiveReplies = 0;
        const before = sends.length;
        const page = await open(surface);
        const composer = page.locator("textarea").first();
        const queue = page.getByRole("region", { name: "Queued messages", exact: true });
        const working = page.getByRole("status").filter({ hasText: "Alex is working" });
        await composer.fill("Review the original request");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        await page.getByText("Checking: Review the original request", { exact: true }).waitFor();
        await working.waitFor();
        assert.equal(await composer.isEnabled(), true, surface);
        assert.equal(await composer.getAttribute("placeholder"), "Add a follow-up for Alex…");
        const firstReply = replies.at(-1)!;

        await composer.fill("Use this attachment in the follow-up");
        await paste(page);
        await waitUploads(page, 1);
        const queuedAttachmentId = `image-${uploads}`;
        await page.getByRole("button", { name: "Queue message", exact: true }).click();
        await queue.getByText("Use this attachment in the follow-up", { exact: true }).waitFor();
        await queue.getByText("screenshot.png", { exact: true }).waitFor();
        assert.equal(await composer.inputValue(), "");
        await composer.fill("Remove this queued request");
        await composer.press("Enter");
        await queue.getByText("Remove this queued request", { exact: true }).waitFor();
        await composer.fill("Check the totals afterwards");
        await composer.press("Enter");
        await queue.getByText("Check the totals afterwards", { exact: true }).waitFor();
        assert.equal(
          sends.length,
          before + 1,
          `${surface}: queued messages do not start concurrent work`,
        );
        await queue.getByRole("button", { name: "Remove queued message 2", exact: true }).click();
        assert.equal(
          await queue.getByText("Remove this queued request", { exact: true }).count(),
          0,
        );

        // A later composer attachment has its own lifetime. Removing it must
        // not mutate the image already captured by the queued message.
        await paste(page);
        await waitUploads(page, 1);
        await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).click();
        assert.equal(await queue.getByText("screenshot.png", { exact: true }).count(), 1);
        await working.waitFor();
        await fs.mkdir(path.resolve(root, "../output/playwright"), { recursive: true });
        await page.screenshot({
          path: path.resolve(root, `../output/playwright/${surface}-assistant-queue.png`),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          true,
          `${surface}: queued messages fit a narrow screen`,
        );
        await page.screenshot({
          path: path.resolve(root, `../output/playwright/${surface}-assistant-queue-mobile.png`),
          fullPage: true,
        });
        await page.setViewportSize({ width: 1440, height: 1000 });

        await page.getByRole("button", { name: "Switch conversation", exact: true }).click();
        await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
        assert.equal(
          await queue.count(),
          0,
          `${surface}: a different conversation has its own queue`,
        );
        assert.equal(await working.count(), 0);
        await page.getByRole("button", { name: "Switch conversation", exact: true }).click();
        await queue.getByText("Use this attachment in the follow-up", { exact: true }).waitFor();
        await working.waitFor();
        await page.getByRole("button", { name: "Close AI panel", exact: true }).click();
        const nextStarted = page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.request().postDataJSON()?.message === "Use this attachment in the follow-up",
        );
        finishReply(firstReply);
        await nextStarted;
        assert.equal(
          sends.length,
          before + 2,
          `${surface}: the queue continues while the panel is closed`,
        );
        const secondReply = replies.at(-1)!;
        assert.deepEqual(secondReply.body.attachmentIds, [queuedAttachmentId]);
        await page.getByRole("button", { name: "Reopen AI panel", exact: true }).click();
        await page
          .getByText("Checking: Use this attachment in the follow-up", { exact: true })
          .waitFor();
        await queue.getByText("Check the totals afterwards", { exact: true }).waitFor();
        await working.waitFor();
        finishReply(secondReply);
        await page.getByText("Checking: Check the totals afterwards", { exact: true }).waitFor();
        const thirdReply = replies.at(-1)!;
        assert.deepEqual(thirdReply.body.attachmentIds, []);
        finishReply(thirdReply);
        await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
        assert.equal(await working.count(), 0);
        assert.equal(await queue.count(), 0);
        assert.equal(maxActiveReplies, 1, `${surface}: only one reply runs at a time`);
        assert.deepEqual(
          sends.slice(before).map((body) => body.message),
          [
            "Review the original request",
            "Use this attachment in the follow-up",
            "Check the totals afterwards",
          ],
        );
        await page.close();
      }
      controlledReplies = false;
    },
  );
  await check(
    "Mail and Routine retain and pause queued messages when an AI reply fails",
    async () => {
      controlledReplies = true;
      for (const surface of ["mail", "routine"]) {
        assistantHistory.clear();
        const before = sends.length;
        const page = await open(surface);
        const composer = page.locator("textarea").first();
        const queue = page.getByRole("region", { name: "Queued messages", exact: true });
        await composer.fill("Start the review");
        await composer.press("Enter");
        await page.getByText("Checking: Start the review", { exact: true }).waitFor();
        await composer.fill("Keep this follow-up after a failure");
        await composer.press("Enter");
        await queue.getByText("Keep this follow-up after a failure", { exact: true }).waitFor();
        finishReply(replies.at(-1)!, "error");
        await page.getByRole("button", { name: "Resume queue", exact: true }).waitFor();
        assert.equal(sends.length, before + 1, `${surface}: a failure pauses pending work`);
        await queue.getByText("Keep this follow-up after a failure", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Resume queue", exact: true }).click();
        await page
          .getByText("Checking: Keep this follow-up after a failure", { exact: true })
          .waitFor();
        assert.equal(sends.length, before + 2);
        finishReply(replies.at(-1)!);
        await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
        assert.equal(await queue.count(), 0);
        await page.close();
      }
      controlledReplies = false;
    },
  );
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
  await check(
    "rejected sends retain images and text in every other AI composer or its queue",
    async () => {
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
        if (surface === "mail" || surface === "routine") {
          const queue = page.getByRole("region", { name: "Queued messages", exact: true });
          await queue.getByRole("button", { name: "Resume queue", exact: true }).waitFor();
          await queue.getByText("Inspect this screenshot", { exact: true }).waitFor();
          await queue.getByText("screenshot.png", { exact: true }).waitFor();
          assert.equal(await page.locator("textarea").first().inputValue(), "");
        } else {
          await page.waitForFunction(
            () => document.querySelector("textarea")?.value === "Inspect this screenshot",
          );
          assert.equal(
            await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).count(),
            1,
            surface,
          );
        }
        await page.close();
      }
      failSend = false;
    },
  );
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
        await page.locator("textarea").first().fill("Keep this unsent follow-up draft");
        await paste(page);
        await waitUploads(page, 1);
        const sent = page.waitForRequest((request) => request.method() === "POST");
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        const retry = (await sent).postDataJSON();
        assert.ok(retry.message.trim().length > 0, surface);
        assert.notEqual(retry.message, "Keep this unsent follow-up draft");
        assert.deepEqual(retry.attachmentIds, []);
        assert.equal(
          await page.locator("textarea").first().inputValue(),
          "Keep this unsent follow-up draft",
        );
        assert.equal(
          await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).count(),
          1,
        );
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
  assert.ok(checks > 0, `No browser regression group matched ${checkName}`);
  console.log(`${checks} browser regression groups passed.`);
} finally {
  await browser.close();
  await server.close();
}
