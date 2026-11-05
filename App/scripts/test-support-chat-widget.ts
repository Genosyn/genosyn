/**
 * Real Chrome over the real App and the real server: a company's owner turns on the
 * Chat widget, a page on another origin embeds it with the snippet they were given,
 * and a visitor starts a conversation and gets a reply. Every part of it that a unit
 * test cannot see runs here: the loader on someone else's page, the frame's own
 * bundle under its real `Content-Security-Policy`, `frame-ancestors` actually
 * refusing a site not on the list, storage the page around the frame can't read, and
 * the Member's side showing where the ticket came from.
 *
 * Everything goes to `createApp()` on a private in-memory database, with a real
 * session cookie. The model and the mailbox are stand-ins, so nothing leaves the
 * machine. Run with `npm run test:support-chat-widget`.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { build } from "vite";

import { DEFAULT_SUPPORT_AI_DISCLOSURE } from "../shared/support";
import { createApp } from "../server/app";
import { AppDataSource } from "../server/db/datasource";
import { AIEmployee } from "../server/db/entities/AIEmployee";
import { Company } from "../server/db/entities/Company";
import { MailAccount } from "../server/db/entities/MailAccount";
import { Membership } from "../server/db/entities/Membership";
import { SupportChatVisitor } from "../server/db/entities/SupportChatVisitor";
import { SupportChatWidget } from "../server/db/entities/SupportChatWidget";
import { SupportInbox } from "../server/db/entities/SupportInbox";
import { SupportJob } from "../server/db/entities/SupportJob";
import { SupportTicket } from "../server/db/entities/SupportTicket";
import { User } from "../server/db/entities/User";
import { errorHandler } from "../server/middleware/error";
import { setPublicUrl } from "../server/services/publicUrl";
import { appShellFallback } from "../server/routes/careersSite";
import { supportChatPagesRouter } from "../server/routes/supportChatPages";
import { setSupportSubmissionRunnerForTests } from "../server/services/support/ai";
import { createArticle } from "../server/services/support/knowledge";
import { runSupportQueueOnce, setSupportQueueAutoKickForTests } from "../server/services/support/queue";
import { setSupportMailboxForTests } from "../server/services/support/replies";
import { updateSupportSettings } from "../server/services/support/settings";
import { sessionCookieFor, withTestInstanceSecrets } from "../server/test/apiAccess";
import { closeTestDb, initTestDb, insert } from "../server/test/dbHarness";
import { FakeMailbox } from "../server/test/fakeMailbox";
import { insertEmployeeModel } from "../server/test/modelFixtures.js";
import { noSidewaysScroll } from "./appFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "../output/playwright");
const TIMEOUT = 45_000;
const ARTICLE =
  "To reset your password, open the sign-in page and press Forgot password. A link arrives by email within a minute.";

// ───────────────────── the real server, on a private database ─────────────────────

const restoreSecrets = withTestInstanceSecrets();
await initTestDb();
setSupportQueueAutoKickForTests(false);
const mailbox = new FakeMailbox();
setSupportMailboxForTests(async () => mailbox);

const owner = await insert(User, {
  email: "owner@acme.example.test",
  name: "Morgan Lee",
  handle: "morgan",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });
const ava = await insert(AIEmployee, {
  companyId: company.id,
  name: "Ava",
  slug: "ava",
  role: "Support Lead",
  soulBody: "",
});
await insertEmployeeModel({
  employeeId: ava.id,
  provider: "anthropic",
  model: "claude-test-model",
  authMode: "apikey",
  isActive: true,
  configJson: JSON.stringify({ apiKeyEncrypted: "sealed-test-key" }),
});
const account = await insert(MailAccount, {
  companyId: company.id,
  connectionId: "never",
  provider: "imap",
  address: "team@acme.example.test",
  status: "active",
  backfilledAt: new Date(),
});
const inbox = await insert(SupportInbox, {
  companyId: company.id,
  accountId: account.id,
  name: "Customer support",
  addressesJson: JSON.stringify(["support@acme.example.test"]),
  aiMode: "auto",
  aiEmployeeId: ava.id,
  watchFrom: new Date(Date.now() - 60_000),
  importStatus: "done",
});
await updateSupportSettings(company.id, { aiEmployeeId: ava.id }, { kind: "system" });
const article = await createArticle({
  companyId: company.id,
  title: "How do I reset my password?",
  body: ARTICLE,
  status: "published",
  actor: { kind: "system" },
});
setSupportSubmissionRunnerForTests(async () => ({
  summary: "A visitor asks how to reset their password.",
  nextStep: "Send the reset steps.",
  topicKey: "how_to",
  priority: "normal",
  sentiment: "neutral",
  language: "en",
  spam: false,
  spamReason: "",
  needsHuman: false,
  needsHumanReason: "",
  injectionDetected: false,
  conversationFinished: false,
  reply: {
    answerable: true,
    body: "Open the sign-in page and press Forgot password. A link arrives by email within a minute.",
    citations: [{ articleId: article.id, quote: "press Forgot password" }],
    confidence: "high",
    note: "",
    translation: "",
    gapQuestion: "",
  },
}));

async function drainQueue() {
  await AppDataSource.getRepository(SupportJob).update(
    { status: "queued" },
    { runAfter: new Date(0) },
  );
  return runSupportQueueOnce();
}

console.log("Chat widget: building the App, its frame and its loader.");
await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
const clientDir = await fs.mkdtemp(path.join(root, ".tmp/support-chat-client-"));
await build({
  configFile: path.join(root, "vite.config.ts"),
  root: path.join(root, "client"),
  logLevel: "warn",
  build: { outDir: clientDir, emptyOutDir: true, reportCompressedSize: false, minify: false },
});
const loaderSource = await fs.readFile(path.join(clientDir, "support-chat-loader.js"), "utf8");
assert.ok(!/^\s*(import|export)\s/m.test(loaderSource), "the built loader must run as a plain script");

const app = createApp();
app.use(
  supportChatPagesRouter({
    isDev: false,
    loadPage: () => fs.readFile(path.join(clientDir, "chat-widget.html"), "utf8"),
    loadLoader: () => fs.readFile(path.join(clientDir, "support-chat-loader.js"), "utf8"),
  }),
);
app.use(express.static(clientDir));
app.get(/^\/(?!api).*/, appShellFallback(path.join(clientDir, "index.html")));
app.use(errorHandler);

function listen(handler: express.Express): Promise<{ server: Server; origin: string }> {
  return new Promise((resolve) => {
    const server = handler.listen(0, "127.0.0.1", () => {
      resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` });
    });
  });
}

const install = await listen(app);
await setPublicUrl(install.origin);
const cookie = await sessionCookieFor(owner);
const sessionCookies = cookie.split(/;\s*/).map((pair) => {
  const [name, ...value] = pair.split("=");
  return { name, value: value.join("="), url: install.origin };
});

/** A company's own site: a plain page with the snippet, on another origin entirely. */
function companySite(snippet: () => string) {
  const site = express();
  site.use((_req, res) => {
    res
      .type("html")
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme</title><body style="font-family:sans-serif"><h1>Welcome to Acme</h1><p>We make things.</p>${snippet()}</body>`,
      );
  });
  return site;
}
let snippet = "";
// `localhost` is another site from the install's `127.0.0.1`, as a real customer's is.
const siteServer = await listen(companySite(() => snippet));
const siteOrigin = siteServer.origin.replace("127.0.0.1", "localhost");
const otherServer = await listen(companySite(() => snippet));
const otherOrigin = otherServer.origin.replace("127.0.0.1", "localhost");

// ─────────────────────────────── Chrome ───────────────────────────────

await fs.mkdir(artifacts, { recursive: true });
const browser: Browser = await chromium.launch({
  channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
  headless: true,
});
const pageErrors: string[] = [];

function watch(page: Page, label: string) {
  page.setDefaultTimeout(TIMEOUT);
  page.on("pageerror", (error) => pageErrors.push(`${label}: ${error.message}`));
}

async function check(name: string, run: () => Promise<void>) {
  process.stdout.write(`  ${name} … `);
  await run();
  process.stdout.write("ok\n");
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(artifacts, `support-chat-${name}.png`) });

const memberContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await memberContext.addCookies(sessionCookies);
await memberContext.addInitScript(() => {
  localStorage.setItem("genosyn.pushPromptDismissed", "1");
});
const memberPage = await memberContext.newPage();
watch(memberPage, "member");

let visitorContext: BrowserContext | null = null;
let failed = false;
try {
  await check("an owner turns it on and gets a snippet", async () => {
    await memberPage.goto(`${install.origin}/c/acme/support/settings`);
    const section = memberPage.locator("section", { hasText: "Chat widget" }).first();
    await section.getByText("Customer support").first().waitFor();
    await section.getByRole("checkbox").first().check();
    await section.getByLabel("Sites it may appear on").fill(siteOrigin);
    await section.getByLabel("Greeting").fill("Hi, this is Acme. What can we help with?");
    await section.getByRole("button", { name: "Save" }).first().click();
    await section.getByText("data-widget-key").waitFor();
    await section.getByText("On", { exact: true }).first().waitFor();
    await section.scrollIntoViewIfNeeded();
    await shot(memberPage, "1-settings");
    const widget = await AppDataSource.getRepository(SupportChatWidget).findOneByOrFail({
      inboxId: inbox.id,
    });
    assert.equal(widget.enabled, true);
    assert.deepEqual(JSON.parse(widget.allowedOriginsJson), [siteOrigin]);
    snippet = (await section.locator("pre code").first().textContent()) ?? "";
    assert.match(snippet, /^<script src=".*\/support-chat\/loader\.js" data-widget-key="/);
    assert.ok(snippet.includes(install.origin));
  });

  visitorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const visitor = await visitorContext.newPage();
  watch(visitor, "visitor");
  const chat = visitor.frameLocator('iframe[title="Chat"]');
  const launcher = () => visitor.locator("[data-genosyn-support-chat] button");

  await check("the page with the snippet gets a launcher, and loads no frame until asked", async () => {
    await visitor.goto(siteOrigin);
    await visitor.getByRole("button", { name: "Open chat" }).waitFor();
    assert.equal(await visitor.locator('iframe[title="Chat"]').count(), 0);
  });

  await check("a visitor starts a conversation", async () => {
    await launcher().click();
    await chat.getByText("Hi, this is Acme. What can we help with?").waitFor();
    await chat.getByLabel("Your message").fill("How do I reset my password?");
    await chat.getByLabel("Your message").press("Enter");
    await chat.getByText("How do I reset my password?").waitFor();
    await chat.getByText("Get replies by email").waitFor();
    await shot(visitor, "2-visitor-writes");
    const ticket = await AppDataSource.getRepository(SupportTicket).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(ticket.source, "chat");
    assert.equal(ticket.subject, "How do I reset my password?");
    assert.equal(ticket.requesterEmail, "");
  });

  await check("the page around the frame holds nothing that opens the conversation", async () => {
    const stored = await visitor.evaluate(() => ({ ...localStorage }));
    for (const [key, value] of Object.entries(stored)) {
      assert.ok(!/^[A-Za-z0-9_-]{43}$/.test(value), `${key} looks like a token`);
    }
    const reachable = await visitor.evaluate(() => {
      const shadow = document.querySelector("[data-genosyn-support-chat]")?.shadowRoot;
      const frame = shadow?.querySelector("iframe");
      try {
        return Boolean(frame?.contentWindow?.localStorage);
      } catch {
        return false;
      }
    });
    assert.equal(reachable, false, "the page must not reach the frame's storage");
    const [{ tokenHash }] = await AppDataSource.getRepository(SupportChatVisitor).find();
    assert.ok(tokenHash);
  });

  await check("the Ticket is in the queue with its source", async () => {
    await memberPage.goto(`${install.origin}/c/acme/support`);
    const row = memberPage.getByRole("link", { name: "How do I reset my password?" });
    await row.waitFor();
    await memberPage.getByText("Chat", { exact: true }).first().waitFor();
    await shot(memberPage, "3-queue");
    await memberPage.goto(`${install.origin}/c/acme/support?source=email`);
    await memberPage.getByText("No tickets match").waitFor();
    await memberPage.goto(`${install.origin}/c/acme/support?source=chat`);
    await row.waitFor();
  });

  await check("the AI Employee's reply reaches the visitor, disclosure and all", async () => {
    await drainQueue();
    await chat.getByText(DEFAULT_SUPPORT_AI_DISCLOSURE, { exact: false }).waitFor();
    await chat.getByText("AI Employee").first().waitFor();
    await shot(visitor, "4-ai-reply");
    assert.equal(
      mailbox.calls.filter((call) => call.method === "sendMessage").length,
      0,
      "nothing went by mail",
    );
  });

  await check("coming back to the page resumes the conversation", async () => {
    await visitor.reload();
    await launcher().click();
    await chat.getByText("How do I reset my password?").waitFor();
    await chat.getByText(DEFAULT_SUPPORT_AI_DISCLOSURE, { exact: false }).waitFor();
  });

  await check("a person's reply reaches them, and the launcher says so while it is closed", async () => {
    await launcher().click();
    const ticket = await AppDataSource.getRepository(SupportTicket).findOneByOrFail({
      companyId: company.id,
    });
    await memberPage.goto(`${install.origin}/c/acme/support/tickets/${ticket.id}`);
    await memberPage.getByText("Chat widget").first().waitFor();
    await memberPage.getByText("In the chat, if they come back").waitFor();
    await memberPage.getByLabel("Reply", { exact: true }).fill("A person here. Did that work for you?");
    await shot(memberPage, "5-member-ticket");
    await memberPage.getByRole("button", { name: "Send", exact: true }).click();
    await memberPage.getByText("A person here. Did that work for you?").first().waitFor();
    await visitor.getByRole("button", { name: "Open chat, 1 unread" }).waitFor({ timeout: 60_000 });
    await launcher().click();
    await chat.getByText("A person here. Did that work for you?").waitFor();
    const last = chat.locator('[role="log"]');
    assert.ok(!(await last.textContent())?.includes("Morgan"), "a Member's name stays inside");
    await shot(visitor, "6-team-reply");
  });

  await check("leaving an email takes a click on a link before anything goes there", async () => {
    await chat.getByText("Get replies by email").click();
    await chat.getByLabel("Your email address").fill("ada@customer.example.test");
    await chat.getByLabel("Your name (optional)").fill("Ada");
    await shot(visitor, "7-email-form");
    await chat.getByRole("button", { name: "Send link" }).click();
    await chat.getByText("Check your inbox", { exact: false }).waitFor();
    await drainQueue();
    const sends = mailbox.calls.filter((call) => call.method === "sendMessage");
    assert.equal(sends.length, 1);
    const mail = sends[0].args[0] as { to: string; bodyText: string };
    assert.equal(mail.to, "ada@customer.example.test");
    const link = /https?:\/\/\S+\/support-chat\/confirm\/[A-Za-z0-9_-]{43}/.exec(mail.bodyText)?.[0];
    assert.ok(link);
    const before = await AppDataSource.getRepository(SupportTicket).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(before.requesterEmail, "");

    const confirmPage = await visitorContext!.newPage();
    watch(confirmPage, "confirm");
    await confirmPage.goto(link);
    await confirmPage.getByRole("button", { name: "Confirm" }).waitFor();
    const stillNot = await AppDataSource.getRepository(SupportTicket).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(stillNot.requesterEmail, "", "opening the link confirms nothing");
    await shot(confirmPage, "8-confirm");
    await confirmPage.getByRole("button", { name: "Confirm" }).click();
    await confirmPage.getByText("Thank you").waitFor();
    await confirmPage.close();
    const after = await AppDataSource.getRepository(SupportTicket).findOneByOrFail({
      companyId: company.id,
    });
    assert.equal(after.requesterEmail, "ada@customer.example.test");
    await chat.getByText("Replies you miss here go to", { exact: false }).waitFor({ timeout: 15_000 });
  });

  await check("it fits a phone", async () => {
    await visitor.setViewportSize({ width: 390, height: 800 });
    await chat.getByLabel("Your message").waitFor();
    // The loader hears its media query on the page's next rendering step, before that
    // step paints, so a visitor never sees the old panel. A box read sooner is still
    // the desktop panel at the new width.
    await visitor.waitForFunction(() => {
      const frame = document
        .querySelector("[data-genosyn-support-chat]")
        ?.shadowRoot?.querySelector("iframe");
      return frame?.getBoundingClientRect().width === window.innerWidth;
    });
    const frameBox = await visitor.locator('iframe[title="Chat"]').boundingBox();
    assert.deepEqual(
      [frameBox?.x, frameBox?.y, frameBox?.width, frameBox?.height],
      [0, 0, 390, 800],
      "the panel fills the phone",
    );
    await shot(visitor, "9-phone");
    await chat.getByRole("button", { name: "Close chat" }).click();
    await launcher().waitFor();
    await noSidewaysScroll(visitor, "the company's site on a phone");
    await visitor.setViewportSize({ width: 1280, height: 800 });
    await launcher().click();
  });

  await check("a site not on the list cannot frame it", async () => {
    const refusals: string[] = [];
    const elsewhere = await visitorContext!.newPage();
    watch(elsewhere, "elsewhere");
    elsewhere.on("console", (message) => {
      if (/frame-ancestors|Content Security Policy/i.test(message.text())) {
        refusals.push(message.text());
      }
    });
    await elsewhere.goto(otherOrigin);
    await elsewhere.locator("[data-genosyn-support-chat] button").click();
    await elsewhere.waitForTimeout(2_000);
    assert.ok(refusals.length > 0, "Chrome should refuse the frame");
    const texts = await Promise.all(
      elsewhere
        .frames()
        .filter((frame) => frame !== elsewhere.mainFrame())
        .map((frame) => frame.evaluate(() => document.body?.innerText ?? "").catch(() => "")),
    );
    assert.ok(!texts.some((text) => text.includes("What can we help with")));
    await elsewhere.close();
  });

  await check("nothing opens it as a page of its own", async () => {
    const key = (
      await AppDataSource.getRepository(SupportChatWidget).findOneByOrFail({ inboxId: inbox.id })
    ).publicKey;
    const direct = await visitorContext!.newPage();
    const response = await direct.goto(`${install.origin}/support-chat/${key}`);
    assert.equal(response?.status(), 404);
    await direct.close();
  });

  await check("ending the chat means it never opens again, and the Ticket stays", async () => {
    await chat.getByRole("button", { name: "End chat" }).click();
    await chat.getByRole("button", { name: "End chat" }).last().click();
    await chat.getByLabel("Your message").waitFor();
    await chat.getByText("How do I reset my password?").waitFor({ state: "detached" });
    const [row] = await AppDataSource.getRepository(SupportChatVisitor).find();
    assert.equal(row.tokenHash, null);
    assert.ok(
      await AppDataSource.getRepository(SupportTicket).findOneBy({ companyId: company.id }),
    );
  });

  assert.deepEqual(pageErrors, [], "no page should have thrown");
  console.log("Chat widget: all good.");
} catch (error) {
  failed = true;
  console.error(error);
  console.error(`Screenshots are in ${artifacts}`);
} finally {
  setSupportSubmissionRunnerForTests(null);
  setSupportMailboxForTests(null);
  await visitorContext?.close();
  await browser.close();
  for (const { server } of [install, siteServer, otherServer]) {
    server.closeAllConnections();
    server.close();
  }
  await closeTestDb();
  restoreSecrets();
  await fs.rm(clientDir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
