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
type Row = Record<string, unknown>;
/** One streamed Ask AI turn: the user row and one owed answer per addressed employee. */
type ControlledReply = {
  body: Row;
  response: ServerResponse;
  user: Row;
  answers: Row[];
  completed: boolean;
};
let controlledReplies = false;
let activeReplies = 0;
let maxActiveReplies = 0;
const replies: ControlledReply[] = [];
/** Ask AI rows per conversation id, as `GET /ask-ai/conversations/:id` returns them. */
const assistantHistory = new Map<string, Row[]>();
/** The fixture page Ask AI is opened on (see chatImageHarness.tsx). */
const ASK_AI_PAGE = "/c/company/mail/t/thread";
const ASK_AI = "/api/companies/company/ask-ai";
const ASK_AI_SEND = /^\/api\/companies\/company\/ask-ai\/conversations\/([^/]+)\/messages$/;
function streamEvent(response: ServerResponse, event: string, data: unknown) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function sse(events: Array<[string, unknown]>) {
  return events
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}
function replyText(reply: ControlledReply, answer: Row, finished: boolean) {
  const message = String(reply.body.message);
  if (reply.answers.length === 1) return `${finished ? "Finished" : "Checking"}: ${message}`;
  const name = askAiRoster.find((entry) => entry.id === answer.employeeId)!.name;
  return `${name} ${finished ? "finished" : "checking"}: ${message}`;
}
/** The next employee in a multi-employee turn starts writing. */
function startNextAnswer(reply: ControlledReply) {
  const answer = reply.answers.find((row) => row.status === "queued");
  assert.ok(answer, "A later employee is still waiting to answer");
  answer.status = "working";
  answer.content = replyText(reply, answer, false);
  streamEvent(reply.response, "working", { ...answer, content: "" });
  streamEvent(reply.response, "chunk", { text: answer.content });
}
/** The answer being written settles; later employees' answers stay owed. */
function settleAnswer(reply: ControlledReply, status: "ok" | "error" = "ok") {
  const answer = reply.answers.find((row) => row.status === "working");
  assert.ok(answer, "An answer is being written");
  answer.status = status;
  answer.content =
    status === "ok" ? replyText(reply, answer, true) : "Model temporarily unavailable";
  streamEvent(reply.response, "assistant", answer);
}
function endReply(reply: ControlledReply) {
  assert.equal(reply.completed, false, "Each reply finishes only once");
  assert.ok(
    reply.answers.every((row) => row.status !== "working" && row.status !== "queued"),
    "Every owed answer settles before the turn is done",
  );
  reply.completed = true;
  activeReplies--;
  streamEvent(reply.response, "done", {});
  reply.response.end();
}
/** Settle every answer still owed, in order, then close the stream. */
function finishReply(reply: ControlledReply, status: "ok" | "error" = "ok") {
  settleAnswer(reply, status);
  while (reply.answers.some((row) => row.status === "queued")) {
    startNextAnswer(reply);
    settleAnswer(reply, status);
  }
  endReply(reply);
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
          const sendPath = ASK_AI_SEND.exec(pathname);
          if (!controlledReplies || req.method !== "POST" || !sendPath) return next();
          let raw = "";
          for await (const chunk of req) raw += chunk.toString();
          const body = JSON.parse(raw) as Row;
          sends.push(body);
          const conversationId = sendPath[1];
          const turn = replies.length;
          const user = askAiUser(body, `controlled-user-${turn}`, conversationId, [
            ...imageAttachments(body.attachmentIds),
          ]);
          const targets = askAiTargets(body);
          const answers = targets.map((target, index) =>
            askAiAnswer(
              `controlled-assistant-${turn}-${index}`,
              conversationId,
              user.id as string,
              target.id,
              index === 0 ? "working" : "queued",
            ),
          );
          const reply: ControlledReply = { body, response: res, user, answers, completed: false };
          answers[0].content = replyText(reply, answers[0], false);
          const history = assistantHistory.get(conversationId) ?? [];
          history.push(user, ...answers);
          assistantHistory.set(conversationId, history);
          replies.push(reply);
          activeReplies++;
          maxActiveReplies = Math.max(maxActiveReplies, activeReplies);
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.flushHeaders();
          // The server's order: the turn, who answers, the first answer
          // working and the rest queued, then the first answer's text.
          streamEvent(res, "user", user);
          streamEvent(res, "targets", { employees: targets });
          streamEvent(res, "working", { ...answers[0], content: "" });
          for (const queued of answers.slice(1)) streamEvent(res, "queued", queued);
          streamEvent(res, "chunk", { text: answers[0].content });
        });
        // Chromium downloads can bypass page request interception. Serve the
        // real workbook bytes so the browser exercises a complete HTTP download.
        dev.middlewares.use(
          `${ASK_AI}/conversations/conversation/attachments/workbook-completed`,
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
/** Ask AI's roster: Alex owns the email on screen; Sam can be tagged alongside. */
const askAiRoster = [
  { id: employee.id, name: "Alex", slug: "alex", role: "Engineer", modelId: "model" },
  { id: "sam", name: "Sam", slug: "sam", role: "Analyst", modelId: "sam-model" },
].map(({ modelId, ...entry }) => ({
  ...entry,
  avatarKey: null,
  hasModel: true,
  models: [{ id: modelId, provider: "openai", model: "gpt-4.1", isActive: true }],
}));
const askAiConversations = [
  { id: "conversation", title: "Review" },
  { id: "other-conversation", title: "Other review" },
].map((conversation) => ({
  ...conversation,
  lastMessageAt: new Date().toISOString(),
  createdAt: new Date().toISOString(),
}));
/** What the server resolves the email on screen to. */
const askAiContextItem = {
  kind: "mail_thread",
  id: "thread",
  label: "Supplier form",
  sublabel: "demo@example.test",
  href: "/mail/t/thread",
};
function askAiContextItems(refs: unknown) {
  return ((refs ?? []) as Array<{ kind: string; id: string }>).some(
    (ref) => ref.kind === askAiContextItem.kind && ref.id === askAiContextItem.id,
  )
    ? [askAiContextItem]
    : [];
}
/** Mentions in the message, else the picked employees, else the page's owner. */
function askAiTargets(body: Row) {
  const mentioned = [...String(body.message).matchAll(/(^|[\s(])@([a-z0-9-]+)/gi)]
    .map((match) => askAiRoster.find((entry) => entry.slug === match[2].toLowerCase()))
    .filter((entry): entry is (typeof askAiRoster)[number] => Boolean(entry));
  const picked = ((body.employeeIds ?? []) as string[])
    .map((id) => askAiRoster.find((entry) => entry.id === id))
    .filter((entry): entry is (typeof askAiRoster)[number] => Boolean(entry));
  return mentioned.length > 0 ? mentioned : picked.length > 0 ? picked : [askAiRoster[0]];
}
function imageAttachments(ids: unknown) {
  return ((ids ?? []) as string[]).map((id) => ({
    id,
    filename: "screenshot.png",
    mimeType: "image/png",
    isImage: true,
    sizeBytes: 68,
  }));
}
function askAiUser(body: Row, id: string, conversationId: string, attachments: Row[]): Row {
  const page = body.page as { path: string; label: string | null };
  return {
    id,
    conversationId,
    role: "user",
    turnId: null,
    employeeId: null,
    modelId: null,
    content: body.message,
    status: null,
    actions: [],
    suggestions: [],
    attachments,
    context: { path: page.path, pageLabel: page.label, items: askAiContextItems(body.refs) },
    createdAt: new Date().toISOString(),
  };
}
function askAiAnswer(
  id: string,
  conversationId: string,
  turnId: string,
  employeeId: string,
  status: "queued" | "working" | "ok" | "error",
  content = "",
  attachments: Row[] = [],
): Row {
  return {
    id,
    conversationId,
    role: "assistant",
    turnId,
    employeeId,
    modelId: askAiRoster.find((entry) => entry.id === employeeId)?.models[0].id ?? null,
    content,
    status,
    actions: [],
    suggestions: [],
    attachments,
    context: null,
    createdAt: new Date().toISOString(),
  };
}
/** Every Ask AI send carries the page it was written on and that page's records. */
function assertAskAiSend(body: Row, label: string) {
  assert.deepEqual(body.page, { path: ASK_AI_PAGE, label: "Email" }, `${label}: page`);
  assert.deepEqual(body.refs, [{ kind: "mail_thread", id: "thread" }], `${label}: refs`);
  assert.deepEqual(body.exclude, [], `${label}: exclude`);
}
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
  if (controlledReplies && request.method() === "POST" && ASK_AI_SEND.test(pathname))
    return route.continue();
  if (workbookMode && request.method() === "GET" && pathname.endsWith("/workbook-completed")) {
    return route.continue();
  }
  if (pathname === ASK_AI || pathname.startsWith(`${ASK_AI}/`)) {
    const rest = pathname.slice(ASK_AI.length);
    const method = request.method();
    if (method === "GET" && rest === "")
      return json({ conversations: askAiConversations, roster: askAiRoster });
    if (method === "POST" && rest === "/conversations") {
      const now = new Date().toISOString();
      return json(
        {
          conversation: { id: "new-conversation", title: null, lastMessageAt: now, createdAt: now },
        },
        201,
      );
    }
    if (method === "POST" && rest === "/context") {
      const body = request.postDataJSON();
      assert.ok(Array.isArray(body.refs), "Context preview sends the page's refs");
      assert.ok(Array.isArray(body.exclude), "Context preview sends exclusions");
      return json({
        items: askAiContextItems(body.refs),
        defaultEmployeeIds: [employee.id],
        withheld: {},
      });
    }
    if (method === "GET" && /^\/conversations\/[^/]+\/attachments\/[^/]+$/.test(rest))
      return route.fulfill({ contentType: "image/png", body: Buffer.from(png, "base64") });
    const conversation = /^\/conversations\/([^/]+)$/.exec(rest);
    if (method === "GET" && conversation)
      return json({
        conversation: askAiConversations.find((c) => c.id === conversation[1]),
        messages: controlledReplies ? (assistantHistory.get(conversation[1]) ?? []) : [],
        roster: askAiRoster,
        modelId: null,
      });
    // Uploads and sends share the handling below with the other composers.
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
    return json(pathname === `${ASK_AI}/attachments` ? { attachment } : attachment, 201);
  }
  if (request.method() === "POST" && pathname.endsWith("/conversations"))
    return json({ id: "conversation", surface: "help", createdAt: new Date().toISOString() });
  if (request.method() === "POST") {
    const body = request.postDataJSON();
    sends.push(body);
    if (failSend) return json({ error: "Send failed; try again" }, 500);
    const askAiSend = ASK_AI_SEND.exec(pathname);
    if (workbookMode && askAiSend) {
      assert.deepEqual(body.attachmentIds, ["workbook-source"]);
      const read = await readXlsx(uploadedWorkbook);
      assert.ok(read.sheets.some((sheet) => sheet.name === "Supplier"));
      completedWorkbook = (
        await editXlsx(uploadedWorkbook, [
          { sheet: "Supplier", cell: "B1", value: "Example Company" },
        ])
      ).bytes;
      const user = askAiUser(body, "workbook-request", askAiSend[1], [
        {
          id: "workbook-source",
          filename: "supplier.xlsx",
          mimeType: XLSX_MIME,
          isImage: false,
          sizeBytes: uploadedWorkbook.length,
        },
      ]);
      const assistant = askAiAnswer(
        "workbook-reply",
        askAiSend[1],
        user.id as string,
        employee.id,
        "ok",
        "The original Excel form is filled. The completed workbook is attached.",
        [
          {
            id: "workbook-completed",
            filename: "supplier-edited.xlsx",
            mimeType: XLSX_MIME,
            isImage: false,
            sizeBytes: completedWorkbook.length,
          },
        ],
      );
      return route.fulfill({
        contentType: "text/event-stream",
        body: sse([
          ["user", user],
          ["targets", { employees: [askAiRoster[0]] }],
          ["working", { ...assistant, status: "working", content: "", attachments: [] }],
          ["assistant", assistant],
          ["done", {}],
        ]),
      });
    }
    if (modelFailure && askAiSend) {
      const user = askAiUser(
        body,
        `user-${sends.length}`,
        askAiSend[1],
        imageAttachments(body.attachmentIds),
      );
      const assistant = askAiAnswer(
        `assistant-${sends.length}`,
        askAiSend[1],
        user.id as string,
        employee.id,
        "error",
        "Model temporarily unavailable",
      );
      return route.fulfill({
        contentType: "text/event-stream",
        body: sse([
          ["user", user],
          ["targets", { employees: [askAiRoster[0]] }],
          ["working", { ...assistant, status: "working", content: "" }],
          ["assistant", assistant],
          ["done", {}],
        ]),
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
    if (surface === "askai") {
      // The composer renders before its conversation loads, and ignores
      // pastes until then. Wait for the loaded conversation, the email's
      // context chip, and the page owner Alex as the default addressee.
      await page.waitForFunction(() => {
        const attach = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Attach a file"]',
        );
        return Boolean(attach && !attach.disabled);
      });
      await page
        .getByLabel("Page context")
        .getByRole("link", { name: askAiContextItem.label, exact: true })
        .waitFor();
      await page.getByRole("button", { name: "Remove Alex", exact: true }).waitFor();
    }
  } catch (error) {
    console.error("Unfinished browser requests:", [...pending]);
    throw error;
  }
  return page;
}
/** Switch Ask AI conversations through the panel's own history menu. */
async function switchConversation(page: Page, title: string) {
  const menu = page.getByTitle("Conversations", { exact: true });
  await menu.click();
  await page.getByRole("menuitem", { name: new RegExp(`^${title}\\b`) }).click();
  await menu.getByText(title, { exact: true }).waitFor();
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
async function fitsNarrowScreen(page: Page, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  // Ask AI switches from docked to full-screen through matchMedia-driven
  // React state, which may finish rendering after setViewportSize resolves.
  await page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    label,
  );
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
    "Excel form uploads in Ask AI, is edited, and downloads as a readable workbook",
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
      const page = await open("askai");
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
      assert.equal(
        await output.getAttribute("href"),
        `${ASK_AI}/conversations/conversation/attachments/workbook-completed`,
        "The produced workbook downloads from its own conversation",
      );
      assertAskAiSend(sends.at(-1)!, "workbook");
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
        path: path.resolve(root, "../output/playwright/excel-workbook-askai.png"),
        fullPage: true,
      });
      await fitsNarrowScreen(page, "The workbook reply fits a narrow screen");
      await page.close();
      workbookMode = false;
    },
  );
  await check(
    "Ask AI shows ongoing work and drains removable follow-ups serially across conversations and a closed panel",
    async () => {
      controlledReplies = true;
      assistantHistory.clear();
      maxActiveReplies = 0;
      const before = sends.length;
      const page = await open("askai");
      const composer = page.getByRole("textbox", { name: "Message", exact: true });
      const queue = page.getByRole("region", { name: "Queued messages", exact: true });
      const working = page.getByRole("status").filter({ hasText: "Alex is working" });
      await composer.fill("Review the original request");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText("Checking: Review the original request", { exact: true }).waitFor();
      await working.waitFor();
      assert.equal(await composer.isEnabled(), true);
      assert.equal(
        await composer.getAttribute("placeholder"),
        "Add a follow-up — it sends after the current reply…",
      );
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
      assert.equal(sends.length, before + 1, "queued messages do not start concurrent work");
      await queue.getByRole("button", { name: "Remove queued message 2", exact: true }).click();
      assert.equal(await queue.getByText("Remove this queued request", { exact: true }).count(), 0);

      // A later composer attachment has its own lifetime. Removing it must
      // not mutate the image already captured by the queued message.
      await paste(page);
      await waitUploads(page, 1);
      await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).click();
      assert.equal(await queue.getByText("screenshot.png", { exact: true }).count(), 1);
      await working.waitFor();
      await fs.mkdir(path.resolve(root, "../output/playwright"), { recursive: true });
      await page.screenshot({
        path: path.resolve(root, "../output/playwright/askai-queue.png"),
        fullPage: true,
      });
      await fitsNarrowScreen(page, "queued messages fit a narrow screen");
      await page.screenshot({
        path: path.resolve(root, "../output/playwright/askai-queue-mobile.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 1440, height: 1000 });

      await switchConversation(page, "Other review");
      await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
      assert.equal(await queue.count(), 0, "a different conversation has its own queue");
      assert.equal(await working.count(), 0);
      await switchConversation(page, "Review");
      await queue.getByText("Use this attachment in the follow-up", { exact: true }).waitFor();
      await working.waitFor();
      await page.getByRole("button", { name: "Close Ask AI", exact: true }).click();
      await page.getByRole("complementary", { name: "Ask AI" }).waitFor({ state: "detached" });
      const nextStarted = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          ASK_AI_SEND.test(new URL(response.url()).pathname) &&
          response.request().postDataJSON()?.message === "Use this attachment in the follow-up",
      );
      finishReply(firstReply);
      await nextStarted;
      assert.equal(sends.length, before + 2, "the queue continues while the panel is closed");
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
      await page.getByText("Finished: Check the totals afterwards", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
      assert.equal(await working.count(), 0);
      assert.equal(await queue.count(), 0);
      assert.equal(maxActiveReplies, 1, "only one reply runs at a time");
      assert.deepEqual(
        sends.slice(before).map((body) => body.message),
        [
          "Review the original request",
          "Use this attachment in the follow-up",
          "Check the totals afterwards",
        ],
      );
      // Queued messages keep the page they were written on.
      sends.slice(before).forEach((body, index) => assertAskAiSend(body, `send ${index + 1}`));
      await page.close();
      controlledReplies = false;
    },
  );
  await check(
    "Ask AI serializes fast submissions and pauses queued messages when an AI reply fails",
    async () => {
      controlledReplies = true;
      assistantHistory.clear();
      maxActiveReplies = 0;
      const before = sends.length;
      const page = await open("askai");
      const composer = page.getByRole("textbox", { name: "Message", exact: true });
      const queue = page.getByRole("region", { name: "Queued messages", exact: true });
      // Back to back, before the first reply has even started streaming.
      await composer.fill("Start the review");
      await composer.press("Enter");
      await composer.fill("Keep this follow-up after a failure");
      await composer.press("Enter");
      await queue.getByText("Keep this follow-up after a failure", { exact: true }).waitFor();
      await page.getByText("Checking: Start the review", { exact: true }).waitFor();
      assert.equal(sends.length, before + 1, "fast submissions serialize");
      finishReply(replies.at(-1)!, "error");
      await page.getByRole("button", { name: "Resume queue", exact: true }).waitFor();
      await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
      assert.equal(sends.length, before + 1, "a failure pauses pending work");
      await queue.getByText("Keep this follow-up after a failure", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Resume queue", exact: true }).click();
      await page
        .getByText("Checking: Keep this follow-up after a failure", { exact: true })
        .waitFor();
      assert.equal(sends.length, before + 2);
      finishReply(replies.at(-1)!);
      await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
      assert.equal(await queue.count(), 0);
      assert.equal(maxActiveReplies, 1, "only one reply runs at a time");
      await page.close();
      controlledReplies = false;
    },
  );
  await check(
    "Ask AI answers two tagged employees in order and holds a follow-up until both finish",
    async () => {
      controlledReplies = true;
      assistantHistory.clear();
      maxActiveReplies = 0;
      const before = sends.length;
      const page = await open("askai");
      const composer = page.getByRole("textbox", { name: "Message", exact: true });
      const queue = page.getByRole("region", { name: "Queued messages", exact: true });
      const status = page.getByRole("status");
      const question = "@alex @sam compare the supplier totals";
      const followUp = "Which supplier should we pick?";
      await composer.fill(question);
      await page.getByRole("button", { name: "Remove Sam", exact: true }).waitFor();
      await page.getByRole("button", { name: "Remove Alex", exact: true }).waitFor();
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await page.getByText(`Alex checking: ${question}`, { exact: true }).waitFor();
      await page.getByText("Sam · waiting", { exact: true }).waitFor();
      await status.filter({ hasText: "Alex is working" }).waitFor();
      const reply = replies.at(-1)!;
      assert.equal(reply.body.message, question);
      // Mentions address the turn; the server reads them from the message.
      assert.deepEqual(reply.body.employeeIds, []);
      assertAskAiSend(reply.body, "tagged message");

      await composer.fill(followUp);
      await page.getByRole("button", { name: "Queue message", exact: true }).click();
      await queue.getByText(followUp, { exact: true }).waitFor();
      assert.equal(sends.length, before + 1);

      // Alex's answer settles while Sam's is still owed.
      settleAnswer(reply);
      await page.getByText(`Alex finished: ${question}`, { exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(sends.length, before + 1, "the follow-up waits while Sam is still queued");
      await queue.getByText(followUp, { exact: true }).waitFor();
      startNextAnswer(reply);
      await page.getByText(`Sam checking: ${question}`, { exact: true }).waitFor();
      await status.filter({ hasText: "Sam is working" }).waitFor();
      assert.equal(sends.length, before + 1, "the follow-up waits while Sam is working");
      settleAnswer(reply);
      await page.getByText(`Sam finished: ${question}`, { exact: true }).waitFor();
      await page.waitForTimeout(300);
      assert.equal(sends.length, before + 1, "the follow-up waits for the turn to finish");

      // A response (not just a request) means the fixture has registered it.
      const followUpStarted = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          ASK_AI_SEND.test(new URL(response.url()).pathname) &&
          response.request().postDataJSON()?.message === followUp,
      );
      endReply(reply);
      await followUpStarted;
      const next = replies.at(-1)!;
      assert.equal(next.body.message, followUp);
      // Whoever answered the tagged turn is who the conversation is with now.
      assert.deepEqual(next.body.employeeIds, ["employee", "sam"]);
      await page.getByText(`Alex checking: ${followUp}`, { exact: true }).waitFor();
      finishReply(next);
      await page.getByText(`Sam finished: ${followUp}`, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Send message", exact: true }).waitFor();
      assert.equal(await queue.count(), 0);
      assert.equal(maxActiveReplies, 1, "only one reply runs at a time");

      const transcript = await page.getByRole("complementary", { name: "Ask AI" }).innerText();
      const order = [
        `Alex finished: ${question}`,
        `Sam finished: ${question}`,
        followUp,
        `Alex finished: ${followUp}`,
        `Sam finished: ${followUp}`,
      ].map((text) => transcript.indexOf(text));
      assert.ok(
        order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])),
        `Answers render in order: ${order.join(", ")}`,
      );
      await fs.mkdir(path.resolve(root, "../output/playwright"), { recursive: true });
      await page.screenshot({
        path: path.resolve(root, "../output/playwright/askai-two-employees.png"),
        fullPage: true,
      });
      await page.close();
      controlledReplies = false;
    },
  );
  await check("every AI composer accepts pasted screenshots with a removable preview", async () => {
    for (const surface of ["repository", "followup", "help", "askai", "tldr", "todo"]) {
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
      for (const surface of ["help", "askai", "tldr", "todo"]) {
        const page = await open(surface);
        await page.locator("textarea").first().fill("Inspect this screenshot");
        await paste(page);
        await waitUploads(page, 1);
        const sent = page.waitForRequest(
          (request) =>
            request.method() === "POST" &&
            !request.headers()["content-type"]?.includes("multipart/form-data") &&
            !request.url().endsWith("/ask-ai/context"),
        );
        await page
          .locator("textarea")
          .first()
          .press(
            surface === "todo"
              ? process.platform === "darwin"
                ? "Meta+Enter"
                : "Control+Enter"
              : "Enter",
          );
        const request = await sent;
        assert.equal(request.postDataJSON().attachmentIds.length, 1, surface);
        if (surface === "askai") {
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
    "an accepted image-only Ask AI message carries its page and can be retried after the AI reply fails",
    async () => {
      modelFailure = true;
      const page = await open("askai");
      const isSend = (request: { method(): string; url(): string }) =>
        request.method() === "POST" && ASK_AI_SEND.test(new URL(request.url()).pathname);
      await paste(page);
      await waitUploads(page, 1);
      const imageAttachmentId = `image-${uploads}`;
      const first = page.waitForRequest(isSend);
      await page.locator("textarea").first().press("Enter");
      const sent = (await first).postDataJSON();
      assert.equal(sent.message, "");
      assert.deepEqual(sent.attachmentIds, [imageAttachmentId]);
      assertAskAiSend(sent, "image-only send");
      await page.getByRole("button", { name: "Try again", exact: true }).waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).count(),
        0,
      );
      await page.locator("textarea").first().fill("Keep this unsent follow-up draft");
      await paste(page);
      await waitUploads(page, 1);
      const again = page.waitForRequest(isSend);
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      const retry = (await again).postDataJSON();
      assert.ok(retry.message.trim().length > 0, "a retry re-sends a non-empty message");
      assert.notEqual(retry.message, "Keep this unsent follow-up draft");
      assert.deepEqual(retry.attachmentIds, []);
      assert.deepEqual(retry.employeeIds, [employee.id], "a retry asks the employee that failed");
      // The retry asks about the records the failed turn was sent with.
      assertAskAiSend(retry, "retry");
      assert.equal(
        await page.locator("textarea").first().inputValue(),
        "Keep this unsent follow-up draft",
      );
      assert.equal(
        await page.getByRole("button", { name: "Remove screenshot.png", exact: true }).count(),
        1,
      );
      await page.close();
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
