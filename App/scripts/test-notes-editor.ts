/**
 * Real Chrome over the real Notes API: the whole App shell (`appHarness.tsx`)
 * with every `/notes` and `/notebooks` request answered by the actual routers
 * on an in-memory database, so what the editor saves is what a reload reads.
 *
 * Covers creating a page, typing, Markdown shortcuts, the slash menu, inline
 * formatting, to-dos, toggles, nesting with Tab, undo, dragging a block by its
 * handle, pasting HTML, autosave, a reload that shows everything saved, an AI
 * Employee's Markdown surviving an edit untouched, the sidebar tree, and a
 * phone-width layout.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import type { Locator, Page } from "playwright-core";
import {
  API,
  COMPANY,
  ME,
  noSidewaysScroll,
  Reply,
  startApp,
  waitForFocus,
  type ApiHandler,
  type ApiRoute,
} from "./appFixture";

const { initTestDb, insert } = await import("../server/test/dbHarness.js");
const { AppDataSource } = await import("../server/db/datasource.js");
const { Company } = await import("../server/db/entities/Company.js");
const { Membership } = await import("../server/db/entities/Membership.js");
const { User } = await import("../server/db/entities/User.js");
const { Note } = await import("../server/db/entities/Note.js");
const { Notebook } = await import("../server/db/entities/Notebook.js");
const { notesRouter } = await import("../server/routes/notes.js");
const { notebooksRouter } = await import("../server/routes/notebooks.js");
const { persistTestSession } = await import("../server/test/userSession.js");

// ───────────────────────── The real API ─────────────────────────────────────

await initTestDb();
const user = await insert(User, { id: ME.id, email: ME.email, name: ME.name, passwordHash: "x", sessionVersion: 0 });
await insert(Company, { id: COMPANY.id, name: COMPANY.name, slug: COMPANY.slug, ownerId: user.id });
await insert(Membership, { companyId: COMPANY.id, userId: user.id, role: "owner" });

const api = express();
api.use(express.json({ limit: "1mb" }));
api.use(async (req, _res, next) => {
  (req as unknown as { session: unknown }).session = { userId: user.id, sessionVersion: 0 };
  await persistTestSession(req);
  next();
});
api.use("/api/companies/:cid", notesRouter);
api.use("/api/companies/:cid", notebooksRouter);
const server: Server = await new Promise((resolve) => {
  const listening = api.listen(0, "127.0.0.1", () => resolve(listening));
});
const apiOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const forward: ApiHandler = async ({ method, url, body }) => {
  const res = await fetch(`${apiOrigin}${url.pathname}${url.search}`, {
    method,
    headers: method === "GET" ? {} : { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return new Reply(res.status, text ? JSON.parse(text) : null);
};
const NOTES_API = /^\/api\/companies\/company\/(?:notes|notebooks)(?:\/|$)/;
const routes: ApiRoute[] = [
  ["GET", NOTES_API, forward],
  ["POST", NOTES_API, forward],
  ["PATCH", NOTES_API, forward],
  ["DELETE", NOTES_API, forward],
  ["GET", `${API}/tags`, () => []],
  ["GET", /\/tags\/resources\//, () => []],
  ["GET", /\/history\/(?:note|notebook)\//, () => ({ items: [], nextCursor: null })],
];

async function storedNote(slug: string) {
  return AppDataSource.getRepository(Note).findOneByOrFail({ companyId: COMPANY.id, slug });
}

/** Wait until the server holds a body `check` accepts — autosave is debounced. */
async function waitForBody(slug: string, check: (body: string) => boolean, message: string): Promise<string> {
  const deadline = Date.now() + 10_000;
  let body = "";
  for (;;) {
    body = (await storedNote(slug)).body;
    if (check(body)) return body;
    if (Date.now() > deadline) throw new assert.AssertionError({ message: `${message}; server has:\n${body}` });
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ───────────────────────── Helpers ──────────────────────────────────────────

const editor = (page: Page) => page.locator("[data-block-editor]");
const rows = (page: Page) => editor(page).locator("[data-block-row]");
const rowTypes = async (page: Page) =>
  rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-block-type") ?? ""));
const rowTexts = async (page: Page) =>
  rows(page).evaluateAll((els) =>
    els.map((el) => (el.querySelector("[data-block-id]") as HTMLElement | null)?.innerText.trim() ?? ""),
  );

/** The editable the caret is in. */
const activeBlock = (page: Page) => page.locator("[data-block-id]:focus");

async function typeSlowly(page: Page, text: string) {
  await page.keyboard.type(text, { delay: 12 });
}

async function expectTypes(page: Page, expected: string[], message: string) {
  const deadline = Date.now() + 5_000;
  let actual: string[] = [];
  for (;;) {
    actual = await rowTypes(page);
    if (JSON.stringify(actual) === JSON.stringify(expected)) return;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(50);
  }
  assert.deepEqual(actual, expected, message);
}

async function saved(page: Page) {
  await page.getByText("Saved", { exact: true }).waitFor({ timeout: 10_000 });
}

async function dragBlock(page: Page, from: Locator, to: Locator, position: "above" | "below") {
  await from.hover();
  const grip = from.locator("[data-block-grip]");
  const gripBox = await grip.boundingBox();
  const target = await to.boundingBox();
  assert.ok(gripBox && target, "the handle and the target are laid out");
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  const y = position === "above" ? target.y + 3 : target.y + target.height - 3;
  await page.mouse.move(gripBox.x + 20, gripBox.y + 20, { steps: 4 });
  await page.mouse.move(target.x + 40, y, { steps: 10 });
  await page.mouse.up();
}

const app = await startApp("Notes — a Notion-like editor over the real Notes API");

let pageSlug = "";

try {
  await app.check("An empty Notes home teaches, and makes the first page", async () => {
    const view = await app.open({ path: "/c/acme/notes", routes });
    const { page } = view;
    await page.getByRole("heading", { name: "Write it down once, for everyone" }).waitFor();
    await page.getByText("Type /").first().waitFor();
    await view.click(page.getByRole("button", { name: "Create your first page" }));
    await view.landedOn(/^\/c\/acme\/notes\/general\/untitled$/);
    pageSlug = "untitled";
    const title = page.getByRole("textbox", { name: "Page title" });
    await title.waitFor();
    assert.equal(await title.inputValue(), "", "a new page opens with an empty title, showing Untitled as a hint");
    assert.equal(await title.evaluate((el) => el === document.activeElement), true, "the caret starts in the title");
    await page.getByText("Start writing — it saves as you go.").waitFor();
    await app.shot(page, "notes-new-page");
    await page.close();
  });

  await app.check("Typing with Markdown shortcuts, inline formatting, slash menu, toggles and nesting", async () => {
    const view = await app.open({ path: `/c/acme/notes/general/${pageSlug}`, routes });
    const { page } = view;
    const title = page.getByRole("textbox", { name: "Page title" });
    await title.click();
    await typeSlowly(page, "Launch plan");
    await page.keyboard.press("Enter");
    await activeBlock(page).waitFor();

    // # → heading
    await typeSlowly(page, "# Goals");
    await expectTypes(page, ["heading"], "typing '# ' makes a heading");
    await page.keyboard.press("Enter");

    // **bold** → bold, and typing continues unformatted
    await typeSlowly(page, "Ship the **new** editor");
    const bold = editor(page).locator("strong");
    await bold.waitFor();
    assert.equal(await bold.first().innerText(), "new");
    await page.keyboard.press("Enter");

    // - → bullets; Enter continues the list; Tab nests; Enter on an empty item steps out
    await typeSlowly(page, "- first");
    await page.keyboard.press("Enter");
    await typeSlowly(page, "second");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expectTypes(page, ["heading", "paragraph", "bulleted", "bulleted", "paragraph"], "lists continue, and an empty item steps out to text");

    // [] → to-do, checked by clicking its box
    await typeSlowly(page, "[] call Ada");
    await page.getByRole("checkbox", { name: "Mark as done" }).click();
    await page.getByRole("checkbox", { name: "Mark as not done" }).waitFor();
    await editor(page).locator('[data-block-type="todo"] [data-block-id]').click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    // ``` → code; Mod+Enter leaves it
    await typeSlowly(page, "```");
    await expectTypes(page, ["heading", "paragraph", "bulleted", "bulleted", "todo", "code"], "``` makes a code block");
    await typeSlowly(page, "npm ci");
    await page.keyboard.press("ControlOrMeta+Enter");

    // The slash menu filters as you type and inserts with Enter
    await typeSlowly(page, "/call");
    const menu = page.getByRole("listbox", { name: "Insert a block" });
    await menu.waitFor();
    assert.equal(await menu.getByRole("option").first().innerText().then((t) => t.split("\n")[0]), "Callout");
    await app.shot(page, "notes-slash-menu");
    await page.keyboard.press("Enter");
    await menu.waitFor({ state: "hidden" });
    await typeSlowly(page, "Remember the budget");
    await page.keyboard.press("Enter");

    // Arrow keys move through the slash menu
    await typeSlowly(page, "/tog");
    await menu.waitFor();
    await page.keyboard.press("Enter");
    await typeSlowly(page, "More details");
    // Enter at the end of an open toggle writes inside it; Enter on an empty line steps back out.
    await page.keyboard.press("Enter");
    await typeSlowly(page, "Hidden inside");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    // --- → divider
    await typeSlowly(page, "---");
    await typeSlowly(page, "> Quoted line");
    await expectTypes(
      page,
      ["heading", "paragraph", "bulleted", "bulleted", "todo", "code", "callout", "toggle", "paragraph", "divider", "quote"],
      "every shortcut and slash command made its block",
    );

    // Undo takes back the last typing
    await typeSlowly(page, " oops");
    await page.keyboard.press("ControlOrMeta+z");
    const texts = await rowTexts(page);
    assert.equal(texts[texts.length - 1], "Quoted line", "undo removes the typing");

    await saved(page);
    const body = await waitForBody(
      pageSlug,
      (b) => b.includes("> Quoted line") && b.includes("Hidden inside"),
      "the page saved everything typed",
    );
    assert.equal(
      body,
      [
        "# Goals",
        "",
        "Ship the **new** editor",
        "",
        "- first",
        "  - second",
        "- [x] call Ada",
        "",
        "```",
        "npm ci",
        "```",
        "",
        "> [!TIP]",
        "> Remember the budget",
        "",
        "<details>",
        "<summary>More details</summary>",
        "",
        "Hidden inside",
        "",
        "</details>",
        "",
        "---",
        "",
        "> Quoted line",
      ].join("\n"),
      "the Markdown AI Employees read is clean and conventional",
    );
    assert.equal((await storedNote(pageSlug)).title, "Launch plan");
    await app.shot(page, "notes-editor-desktop");
    await page.close();
  });

  await app.check("A reload shows everything that was saved", async () => {
    const view = await app.open({ path: `/c/acme/notes/general/${pageSlug}`, routes });
    const { page } = view;
    await editor(page).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Page title" }).inputValue(), "Launch plan");
    await expectTypes(
      page,
      ["heading", "paragraph", "bulleted", "bulleted", "todo", "code", "callout", "toggle", "divider", "quote"],
      "the reloaded page has the same blocks (the closed toggle hides its child)",
    );
    assert.equal(await editor(page).locator("strong").first().innerText(), "new");
    await page.getByRole("checkbox", { name: "Mark as not done" }).waitFor();
    // Opening the toggle shows what's inside it.
    await editor(page).getByRole("button", { name: "Expand", exact: true }).click();
    await page.getByText("Hidden inside").waitFor();
    await page.reload();
    await editor(page).waitFor();
    assert.equal(await page.getByRole("textbox", { name: "Page title" }).inputValue(), "Launch plan");

    // Selecting text shows the formatting bar; Italic formats the selection.
    await editor(page).evaluate((root) => {
      const block = Array.from(root.querySelectorAll<HTMLElement>("[data-block-id]")).find(
        (el) => el.textContent === "Ship the new editor",
      );
      if (!block) throw new Error("no 'Ship the new editor' block");
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.nodeValue ?? "").indexOf("editor");
        if (at < 0) continue;
        block.focus();
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + "editor".length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
    });
    const toolbar = page.getByRole("toolbar", { name: "Format text" });
    await toolbar.waitFor();
    await app.shot(page, "notes-format-toolbar");
    await toolbar.getByRole("button", { name: /^Italic/ }).click();
    await editor(page).locator("em").first().waitFor();
    await waitForBody(pageSlug, (b) => /Ship the \*\*new\*\* \*editor\*/.test(b), "italic from the toolbar was saved");
    await page.close();
  });

  await app.check("Dragging a block by its handle reorders it", async () => {
    const view = await app.open({ path: `/c/acme/notes/general/${pageSlug}`, routes });
    const { page } = view;
    await editor(page).waitFor();
    const quote = editor(page).locator('[data-block-type="quote"]');
    const heading = editor(page).locator('[data-block-type="heading"]');
    await dragBlock(page, quote, heading, "above");
    await expectTypes(
      page,
      ["quote", "heading", "paragraph", "bulleted", "bulleted", "todo", "code", "callout", "toggle", "divider"],
      "the quote moved to the top",
    );
    const body = await waitForBody(pageSlug, (b) => b.startsWith("> Quoted line"), "the move was saved");
    assert.ok(body.includes("# Goals"));
    await page.close();
  });

  await app.check("Pasting HTML lands as proper blocks", async () => {
    const view = await app.open({ path: `/c/acme/notes/general/${pageSlug}`, routes });
    const { page } = view;
    await editor(page).waitFor();
    const before = (await rowTypes(page)).length;
    // Click below the last block: a fresh paragraph to paste into.
    const box = await editor(page).boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + 40, box.y + box.height + 40);
    await activeBlock(page).waitFor();
    await activeBlock(page).evaluate((el) => {
      const data = new DataTransfer();
      data.setData("text/html", "<h2>Pasted heading</h2><ul><li>alpha</li><li><b>beta</b></li></ul>");
      data.setData("text/plain", "Pasted heading\nalpha\nbeta");
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const deadline = Date.now() + 5_000;
    while ((await rowTypes(page)).length < before + 3 && Date.now() < deadline) await page.waitForTimeout(50);
    const types = await rowTypes(page);
    assert.deepEqual(types.slice(before), ["heading", "bulleted", "bulleted"], "a heading and two bullets were pasted");
    await waitForBody(pageSlug, (b) => b.includes("## Pasted heading\n\n- alpha\n- **beta**"), "the paste was saved as Markdown");
    await page.close();
  });

  await app.check("An AI Employee's Markdown survives a Member's edit untouched", async () => {
    const general = await AppDataSource.getRepository(Notebook).findOneByOrFail({ companyId: COMPANY.id, slug: "general" });
    const aiBody = [
      "## Q3 summary",
      "",
      "| Metric | Q2 | Q3 |",
      "|--------|----|----|",
      "| ARR | $1.2M | $1.5M |",
      "",
      "*   Odd bullet marker",
      "*   Another",
      "",
      "<div align=\"center\">raw html</div>",
      "",
      "Closing line  ",
      "",
    ].join("\n");
    await insert(Note, {
      companyId: COMPANY.id,
      notebookId: general.id,
      title: "Q3 summary",
      slug: "q3-summary",
      body: aiBody,
      icon: "",
      parentId: null,
      sortOrder: 5000,
      archivedAt: null,
    });
    const view = await app.open({ path: "/c/acme/notes/general/q3-summary", routes });
    const { page } = view;
    await editor(page).waitFor();
    await editor(page).locator("table").waitFor();
    const closing = editor(page).getByText("Closing line", { exact: true });
    await closing.click();
    await page.keyboard.press("End");
    await typeSlowly(page, " — reviewed");
    await saved(page);
    const body = await waitForBody("q3-summary", (b) => b.includes("reviewed"), "the edit was saved");
    assert.equal(body, aiBody.replace("Closing line  ", "Closing line — reviewed"), "only the edited line changed");
    await page.close();
  });

  await app.check("The sidebar shows the tree, makes sub-pages, and searches", async () => {
    const view = await app.open({ path: `/c/acme/notes/general/${pageSlug}`, routes });
    const { page } = view;
    const nav = page.getByRole("navigation", { name: "Notes" });
    await nav.getByRole("link", { name: "Launch plan" }).waitFor();
    await nav.getByRole("link", { name: "Q3 summary" }).waitFor();
    await nav.getByRole("link", { name: "Launch plan" }).hover();
    await view.click(nav.getByRole("button", { name: "Add a page inside Launch plan" }));
    await view.landedOn(/^\/c\/acme\/notes\/general\/untitled-2$/);
    await waitForFocus(page.getByRole("textbox", { name: "Page title" }), "a new sub-page opens with the caret in its title");
    await typeSlowly(page, "Sub-page");
    await saved(page);
    const child = await storedNote("untitled-2");
    const parent = await storedNote(pageSlug);
    assert.equal(child.parentId, parent.id, "the sub-page sits under its parent");
    await nav.getByRole("link", { name: "Sub-page" }).waitFor();
    // Quick find matches titles at once and page text from the server.
    await page.getByRole("textbox", { name: "Search pages" }).fill("budget");
    await page.getByRole("option").filter({ hasText: "Launch plan" }).waitFor();
    await page.getByRole("textbox", { name: "Search pages" }).press("Enter");
    await view.landedOn(`/c/acme/notes/general/${pageSlug}`);
    await page.getByRole("region", { name: "Pages inside" }).getByRole("link", { name: "Sub-page" }).waitFor();
    await page.close();
  });

  await app.check("Trash takes sub-pages along and restores them", async () => {
    const view = await app.open({ path: `/c/acme/notes/general/${pageSlug}`, routes });
    const { page } = view;
    await editor(page).waitFor();
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "Move to trash" }).click();
    await view.landedOn("/c/acme/notes/general");
    const deadline = Date.now() + 5_000;
    while (!(await storedNote("untitled-2")).archivedAt && Date.now() < deadline) await page.waitForTimeout(50);
    assert.ok((await storedNote(pageSlug)).archivedAt, "the page is in the trash");
    assert.ok((await storedNote("untitled-2")).archivedAt, "and so is its sub-page");
    await page.getByRole("button", { name: "Trash", exact: true }).click();
    await page.getByRole("button", { name: "Restore Launch plan" }).click();
    await view.landedOn(`/c/acme/notes/general/${pageSlug}`);
    assert.equal((await storedNote("untitled-2")).archivedAt, null, "restoring brings the sub-page back");
    await page.close();
  });

  await app.check("On a phone the page fits and typing still works", async () => {
    const view = await app.open({ path: `/c/acme/notes/general/${pageSlug}`, routes, touch: true });
    const { page } = view;
    await editor(page).waitFor();
    await noSidewaysScroll(page, "a note on a phone");
    const last = editor(page).locator('[data-block-type="paragraph"] [data-block-id]').last();
    await last.click();
    await page.keyboard.press("End");
    await typeSlowly(page, " (from my phone)");
    await waitForBody(pageSlug, (b) => b.includes("(from my phone)"), "a phone edit saves");
    await app.shot(page, "notes-editor-mobile");
    await page.close();
  });

  await app.check("A code block's language comes from a searchable list", async () => {
    const view = await app.open({ path: `/c/acme/notes/general/${pageSlug}`, routes });
    const { page } = view;
    await editor(page).waitFor();
    await editor(page).getByRole("combobox", { name: "Code language" }).click();
    await page.keyboard.type("type");
    const options = page.getByRole("listbox").getByRole("option");
    assert.deepEqual(await options.allInnerTexts(), ["TypeScript"], "typing narrows the languages");
    await app.shot(page, "notes-code-language");
    await options.first().click();
    await waitForBody(pageSlug, (b) => b.includes("```typescript\nnpm ci\n```"), "the chosen language saves");
    await page.close();
  });
} finally {
  await app.finish();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
