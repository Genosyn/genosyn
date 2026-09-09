/**
 * Real-browser regression coverage for saved mail draft attachments.
 * Run npm run test:mail-draft-attachments, optionally -- "case substring".
 * Only the API is a fixture; React, clicks, keyboard input and downloads are real.
 * No mailbox, model, external website or application database is contacted.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Locator, type Page } from "playwright-core";
import type { MailMessage, UpdateDraftInput } from "../client/lib/mail";
import { browserTestVite } from "./browserTestVite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const base = "/api/companies/company/mail";
type FileFixture = { filename: string; mimeType: string; bytes: Buffer };
const files: FileFixture[] = [
  {
    filename: "quotation.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from([37, 80, 68, 70, 0, 255, 10]),
  },
  { filename: "notes.txt", mimeType: "text/plain", bytes: Buffer.from("Original notes\n") },
  {
    filename: "quotation.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from("%PDF a second quotation\n"),
  },
];
type Call = { method: string; path: string; body?: UpdateDraftInput };
type State = {
  draft: MailMessage;
  files: FileFixture[];
  calls: Call[];
  saveError: boolean;
  sent: boolean;
};
function fixture(selected = files): State {
  return {
    files: [...selected],
    calls: [],
    saveError: false,
    sent: false,
    draft: {
      id: "draft",
      threadId: "thread",
      gmailMessageId: "remote-draft",
      isDraft: true,
      fromName: "",
      fromEmail: "mailbox@example.test",
      toEmails: "recipient@example.test",
      ccEmails: "cc@example.test",
      bccEmails: "",
      subject: "Quotation",
      snippet: "Please review these files.",
      bodyText: "Please review these files.",
      bodyHtml: "",
      labelIds: ["DRAFT"],
      sentAt: null,
      createdAt: null,
      createdByUserId: null,
      createdByEmployeeId: null,
      createdByRoutineId: null,
      createdByRunId: null,
      attachments: selected.map((file, index) => ({
        index,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.bytes.length,
      })),
    },
  };
}
let state = fixture();
const unexpected: string[] = [];
const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 0, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-mail-draft-attachments"),
  plugins: [
    {
      name: "mail-draft-attachment-fixture",
      configureServer(dev) {
        dev.middlewares.use(async (req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (url.pathname === "/__mail_draft_attachments") {
            const html = await dev.transformIndexHtml(
              url.pathname,
              '<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><div id="root"></div>' +
                '<script type="module" src="/@fs' +
                root +
                '/scripts/mailDraftAttachmentHarness.tsx"></script></html>',
            );
            res.setHeader("content-type", "text/html");
            res.end(html);
            return;
          }
          if (!url.pathname.startsWith("/api/")) return next();
          const json = (value: unknown, status = 200) => {
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(value));
          };
          const call: Call = { method: req.method ?? "GET", path: url.pathname };
          state.calls.push(call);
          if (call.method === "GET" && url.pathname === `${base}/threads/thread`) {
            return json({
              thread: {
                id: "thread",
                gmailThreadId: "remote-thread",
                accountId: "account",
                subject: "Quotation",
                snippet: "Please review these files.",
                participants: "recipient@example.test",
                labelIds: ["DRAFT"],
                unread: false,
                messageCount: 1,
                hasAttachments: state.files.length > 0,
                lastMessageAt: null,
              },
              account: { id: "account", address: "mailbox@example.test" },
              messages: state.sent ? [] : [state.draft],
              handovers: [],
              analyses: [],
            });
          }
          if (call.method === "GET" && url.pathname === `${base}/accounts/account/assistant`) {
            return json({ messages: [], roster: [], modelId: null });
          }
          const download = url.pathname.match(
            /^\/api\/companies\/company\/mail\/messages\/([^/]+)\/attachments\/(\d+)$/,
          );
          if (call.method === "GET" && download && download[1] === state.draft.id) {
            const file = state.files[Number(download[2])];
            if (!file) return json({ error: "Attachment not found" }, 404);
            res.setHeader("content-type", file.mimeType);
            res.setHeader("content-length", file.bytes.length);
            res.setHeader(
              "content-disposition",
              `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
            );
            res.end(file.bytes);
            return;
          }
          if (call.method === "PATCH" && url.pathname === `${base}/drafts/${state.draft.id}`) {
            let raw = "";
            for await (const chunk of req) raw += chunk.toString();
            const body = JSON.parse(raw) as UpdateDraftInput;
            call.body = body;
            if (state.saveError) return json({ error: "Mailbox temporarily unavailable" }, 503);
            assert.ok(
              Array.isArray(body.keepAttachmentIndexes),
              "The editor must submit the kept indexes",
            );
            state.files = body.keepAttachmentIndexes.map((index) => state.files[index]);
            assert.ok(
              state.files.every(Boolean),
              "A save must not reference a removed or renumbered file",
            );
            state.draft = {
              ...state.draft,
              id: "updated-draft",
              toEmails: body.to ?? state.draft.toEmails,
              ccEmails: body.cc ?? state.draft.ccEmails,
              bccEmails: body.bcc ?? state.draft.bccEmails,
              subject: body.subject ?? state.draft.subject,
              bodyText: body.bodyText ?? state.draft.bodyText,
              attachments: state.files.map((file, index) => ({
                index,
                filename: file.filename,
                mimeType: file.mimeType,
                size: file.bytes.length,
              })),
            };
            return json({ message: state.draft });
          }
          if (call.method === "POST" && url.pathname === `${base}/drafts/${state.draft.id}/send`) {
            state.sent = true;
            return json({ message: { ...state.draft, isDraft: false } });
          }
          unexpected.push(`${call.method} ${url.pathname}`);
          return json({ error: "Unexpected fixture request" }, 500);
        });
      },
    },
  ],
});
await server.listen();
const origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
const filter = process.argv.slice(2).join(" ").toLowerCase();
let passed = 0;
const cases: Array<{
  name: string;
  run: (page: Page) => Promise<void>;
  files?: FileFixture[];
  mobile?: boolean;
}> = [];
const main = (page: Page) => page.getByRole("main");
const link = (page: Page, index: number, mid = "draft") =>
  main(page).locator(`a[href="${base}/messages/${mid}/attachments/${index}"]`);
const writes = () => state.calls.filter((call) => call.method !== "GET");
const downloads = () => state.calls.filter((call) => call.path.includes("/attachments/"));
async function edit(page: Page) {
  await main(page).getByRole("button", { name: "Edit", exact: true }).click();
  await main(page).getByRole("textbox", { name: "Message", exact: true }).waitFor();
}
async function download(
  page: Page,
  target: Locator,
  expected: FileFixture,
  action = () => target.click(),
) {
  const pending = page.waitForEvent("download");
  await action();
  const result = await pending;
  assert.equal(result.suggestedFilename(), expected.filename);
  assert.equal(await result.failure(), null);
  const stream = await result.createReadStream();
  assert.ok(stream, "Download must expose actual bytes");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), expected.bytes);
  assert.equal(
    page.url(),
    `${origin}/__mail_draft_attachments`,
    "Downloading must not leave the editor",
  );
}
function add(
  name: string,
  run: (page: Page) => Promise<void>,
  options: { files?: FileFixture[]; mobile?: boolean } = {},
) {
  cases.push({ name, run, ...options });
}

add("read-only saved draft downloads exact binary bytes and filename", async (page) => {
  await download(page, link(page, 0), files[0]);
  assert.equal(downloads().length, 1);
  assert.deepEqual(writes(), []);
});
add(
  "paperclip, filename and size download in edit mode without dirtying the draft",
  async (page) => {
    await edit(page);
    const file = link(page, 0);
    for (const target of [
      file.locator("svg"),
      file.locator("span").first(),
      file.locator("span").last(),
    ]) {
      await download(page, file, files[0], () => target.click());
      assert.equal(
        await main(page).getByRole("button", { name: "Save", exact: true }).isDisabled(),
        true,
      );
    }
    assert.equal(downloads().length, 3);
    assert.equal(
      await main(page)
        .getByRole("button", { name: /^Remove / })
        .count(),
      3,
    );
    assert.deepEqual(writes(), []);
  },
);
add("keyboard Tab reaches an accessible download link and Enter downloads", async (page) => {
  await edit(page);
  await main(page).getByRole("textbox", { name: "Message", exact: true }).focus();
  await page.keyboard.press("Tab");
  const file = link(page, 0);
  assert.equal(await file.evaluate((element) => element === document.activeElement), true);
  assert.equal(await file.getAttribute("aria-label"), `Download ${files[0].filename}`);
  assert.equal(await file.getAttribute("title"), `Download ${files[0].filename}`);
  await download(page, file, files[0], () => page.keyboard.press("Enter"));
  assert.deepEqual(writes(), []);
});
add("repeated downloads preserve unsaved recipient, subject and message", async (page) => {
  await edit(page);
  const edits = {
    To: "changed@example.test",
    Subject: "Updated quotation",
    Message: "Unsaved draft text\nSecond line.",
  };
  for (const [label, value] of Object.entries(edits))
    await main(page).getByRole("textbox", { name: label, exact: true }).fill(value);
  await download(page, link(page, 1), files[1]);
  await download(page, link(page, 0), files[0]);
  for (const [label, value] of Object.entries(edits))
    assert.equal(
      await main(page).getByRole("textbox", { name: label, exact: true }).inputValue(),
      value,
    );
  assert.equal(
    await main(page).getByRole("button", { name: "Save", exact: true }).isEnabled(),
    true,
  );
  assert.deepEqual(writes(), []);
});
add(
  "removing a preceding file never downloads and preserves original duplicate-file indexes",
  async (page) => {
    await edit(page);
    await main(page)
      .getByRole("button", { name: "Remove quotation.pdf", exact: true })
      .first()
      .click();
    assert.equal(await link(page, 0).count(), 0);
    assert.deepEqual(downloads(), []);
    await download(page, link(page, 2), files[2]);
    await download(page, link(page, 1), files[1]);
    assert.deepEqual(
      downloads().map((call) => call.path),
      [2, 1].map((index) => `${base}/messages/draft/attachments/${index}`),
    );
    assert.deepEqual(writes(), []);
  },
);
add("duplicate filenames download distinct contents in either order", async (page) => {
  await edit(page);
  assert.equal(
    await main(page).getByRole("link", { name: "Download quotation.pdf", exact: true }).count(),
    2,
  );
  for (const index of [2, 0, 2]) await download(page, link(page, index), files[index]);
  assert.deepEqual(writes(), []);
});
add("removing every file and cancelling restores all saved downloads", async (page) => {
  await edit(page);
  for (let index = 0; index < files.length; index++)
    await main(page)
      .getByRole("button", { name: /^Remove / })
      .first()
      .click();
  assert.equal(await main(page).getByRole("link").count(), 0);
  assert.equal(
    await main(page).getByRole("button", { name: "Save", exact: true }).isEnabled(),
    true,
  );
  await main(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await edit(page);
  for (let index = 0; index < files.length; index++)
    await download(page, link(page, index), files[index]);
  assert.deepEqual(writes(), []);
});
add(
  "saving keeps original indexes and replaces links with the new draft id and indexes",
  async (page) => {
    await edit(page);
    await main(page)
      .getByRole("button", { name: "Remove quotation.pdf", exact: true })
      .first()
      .click();
    await main(page).getByRole("textbox", { name: "Message", exact: true }).fill("Saved revision");
    await main(page).getByRole("button", { name: "Save", exact: true }).click();
    await link(page, 0, "updated-draft").waitFor();
    assert.deepEqual(
      writes().map((call) => [call.method, call.path]),
      [["PATCH", `${base}/drafts/draft`]],
    );
    assert.deepEqual(writes()[0].body?.keepAttachmentIndexes, [1, 2]);
    assert.equal(writes()[0].body?.bodyText, "Saved revision");
    await edit(page);
    assert.equal(await link(page, 2).count(), 0);
    await download(page, link(page, 0, "updated-draft"), files[1]);
    await download(page, link(page, 1, "updated-draft"), files[2]);
    assert.equal(
      await main(page).getByRole("button", { name: "Save", exact: true }).isDisabled(),
      true,
    );
  },
);
add("failed save preserves edits, removals and usable download links for retry", async (page) => {
  await edit(page);
  state.saveError = true;
  await main(page).getByRole("button", { name: "Remove notes.txt", exact: true }).click();
  await main(page)
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Keep this unsaved text");
  await main(page).getByRole("button", { name: "Save", exact: true }).click();
  await main(page).getByText("Mailbox temporarily unavailable", { exact: true }).waitFor();
  assert.equal(
    await main(page).getByRole("textbox", { name: "Message", exact: true }).inputValue(),
    "Keep this unsaved text",
  );
  assert.equal(await link(page, 1).count(), 0);
  await download(page, link(page, 2), files[2]);
  state.saveError = false;
  await main(page).getByRole("button", { name: "Save", exact: true }).click();
  await link(page, 0, "updated-draft").waitFor();
  assert.deepEqual(
    writes().map((call) => call.body?.keepAttachmentIndexes),
    [
      [0, 2],
      [0, 2],
    ],
  );
});
add("downloading a pristine draft before Send does not rewrite the draft", async (page) => {
  await edit(page);
  await download(page, link(page, 0), files[0]);
  const sent = page.waitForResponse((response) => response.url().endsWith("/drafts/draft/send"));
  await main(page).getByRole("button", { name: "Send", exact: true }).click();
  await sent;
  assert.deepEqual(
    writes().map((call) => [call.method, call.path]),
    [["POST", `${base}/drafts/draft/send`]],
  );
});
const unicodeFile = {
  filename: "見積書-更新版-長いファイル名-2026-September.pdf",
  mimeType: "application/pdf",
  bytes: Buffer.from("%PDF Unicode filename fixture"),
};
add(
  "long Unicode filename fits mobile dark mode and downloads with its complete name",
  async (page) => {
    await edit(page);
    assert.equal(
      await page.locator("html").evaluate((element) => element.classList.contains("dark")),
      true,
    );
    const file = link(page, 0);
    assert.equal(await file.getAttribute("title"), `Download ${unicodeFile.filename}`);
    assert.equal(await file.getAttribute("download"), unicodeFile.filename);
    const box = await file.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await download(page, file, unicodeFile);
    await page.screenshot({
      path: path.join(output, "mail-draft-attachment-mobile.png"),
      fullPage: true,
    });
  },
  { files: [unicodeFile], mobile: true },
);
add(
  "draft without attachments remains editable without broken download or removal controls",
  async (page) => {
    await edit(page);
    assert.equal(await main(page).getByRole("link").count(), 0);
    assert.equal(
      await main(page)
        .getByRole("button", { name: /^Remove / })
        .count(),
      0,
    );
    assert.equal(
      await main(page).getByRole("button", { name: "Attach", exact: true }).isEnabled(),
      true,
    );
    assert.equal(
      await main(page).getByRole("button", { name: "Save", exact: true }).isDisabled(),
      true,
    );
    assert.deepEqual(writes(), []);
  },
  { files: [] },
);

try {
  await fs.mkdir(output, { recursive: true });
  const selected = cases.filter((item) => item.name.toLowerCase().includes(filter));
  assert.ok(selected.length, `No browser cases match ${JSON.stringify(filter)}`);
  for (const item of selected) {
    state = fixture(item.files);
    unexpected.length = 0;
    const errors: string[] = [];
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: item.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
      colorScheme: item.mobile ? "dark" : "light",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => {
      if (new URL(route.request().url()).origin === origin) return route.continue();
      unexpected.push(`External request: ${route.request().url()}`);
      return route.abort();
    });
    console.log(`RUN ${item.name}`);
    try {
      await page.goto(`${origin}/__mail_draft_attachments`, { waitUntil: "commit" });
      await main(page)
        .getByRole("button", { name: "Edit", exact: true })
        .waitFor({ timeout: 60_000 });
      await item.run(page);
      assert.deepEqual(errors, [], "Browser must not throw");
      assert.deepEqual(unexpected, [], "All requests must be expected and local");
      console.log(`PASS ${item.name}`);
      passed++;
    } catch (error) {
      await page
        .screenshot({
          path: path.join(output, "mail-draft-attachment-failure.png"),
          fullPage: true,
        })
        .catch(() => {});
      console.error(`FAIL ${item.name}`);
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`${passed} saved-draft attachment browser cases passed.`);
} finally {
  await browser.close();
  await server.close();
}
