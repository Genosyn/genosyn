/**
 * Real Chrome over a real group discussion: a Member opens a group chat with
 * three AI Employees, watches them take turns live ("round 1 of 3 · Ada is
 * thinking…"), reads the outcome card, starts the work and sees each owner
 * report back; stops a second discussion mid-turn; uses Workspace at phone
 * width; and starts a group chat from an employee's page.
 *
 * Everything but the model call is real: the Workspace page and its
 * components, the workspace and discussion routers, the discussion driver,
 * the chat seam with its read-only tool scope, the WebSocket hub, and a
 * private in-memory database. `agentRuntime.run` — the one boundary every
 * employee turn crosses on its way to a provider — is replaced by a script,
 * so no model is called and no credential is needed.
 *
 * Run with `npm run test:group-chats` (local Chrome, or GENOSYN_TEST_BROWSER).
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
import { chromium, type Page } from "playwright-core";
import { build } from "vite";

import { config } from "../config";
import { AppDataSource } from "../server/db/datasource";
import { AIEmployee } from "../server/db/entities/AIEmployee";
import { AIModel } from "../server/db/entities/AIModel";
import { ChannelMessage } from "../server/db/entities/ChannelMessage";
import { Company } from "../server/db/entities/Company";
import { GroupDiscussion } from "../server/db/entities/GroupDiscussion";
import { Membership } from "../server/db/entities/Membership";
import { User } from "../server/db/entities/User";
import { errorHandler } from "../server/middleware/error";
import { workspaceRouter } from "../server/routes/workspace";
import { workspaceDiscussionsRouter } from "../server/routes/workspaceDiscussions";
import { agentRuntime } from "../server/services/agent/runtime";
import { settleGroupDiscussionsForTests } from "../server/services/groupDiscussions";
import { attachRealtime } from "../server/services/realtime";
import { closeTestDb, initTestDb, insert } from "../server/test/dbHarness";
import { persistTestSession } from "../server/test/userSession";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "../output/playwright");
const TIMEOUT = Number(process.env.GROUP_CHATS_TIMEOUT ?? 120_000);

// ---------- A private database and data directory ----------

const mutable = config as unknown as {
  sessionSecret: string;
  dataDir: string;
  security: { encryptionSecret: string };
};
mutable.sessionSecret = "group-chats-browser-session-secret-0123456789abcdef";
mutable.security.encryptionSecret = "group-chats-browser-encryption-secret-0123456789ab";
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-group-chats-"));
mutable.dataDir = dataDir;
await initTestDb();

const owner = await insert(User, {
  email: "ruth@example.test",
  name: "Ruth",
  passwordHash: "x",
  emailVerifiedAt: new Date(),
  sessionVersion: 0,
});
const company = await insert(Company, { name: "Acme", slug: "acme", ownerId: owner.id });
await insert(Membership, { companyId: company.id, userId: owner.id, role: "owner" });

async function hire(name: string, slug: string, role: string): Promise<AIEmployee> {
  const employee = await insert(AIEmployee, {
    companyId: company.id,
    name,
    slug,
    role,
    soulBody: `You are ${name}.`,
  });
  await insert(AIModel, {
    employeeId: employee.id,
    provider: "anthropic",
    model: "claude-opus-5-5",
    authMode: "apikey",
    configJson: "{}",
    isActive: true,
  });
  return employee;
}
await hire("Ada", "ada", "Head of Product");
const ben = await hire("Ben", "ben", "CFO");
await hire("Cy", "cy", "Sales lead");

// ---------- The model, scripted ----------

const ROUND_ONE: Record<string, string> = {
  Ada: "Raise Pro to $49 — usage doubled since the last change. @ben can finance carry it?",
  Ben: "Yes: gross margin goes from 62% to 71%. Churn would have to triple before we lose money.",
  Cy: "Sales can live with it if annual plans are grandfathered for six months.",
};
const FOLLOW_THROUGH: Record<string, string> = {
  Ben: "Modelled it: grandfathering annual plans costs $12k over six months.",
  Cy: "Drafted the customer announcement; it is waiting in the Decision stack for review.",
};
const OUTCOME = {
  summary: "Raise the Pro plan to $49; margins carry it and churn risk is low.",
  recommendation: "Announce the new price on Monday and grandfather annual plans for six months.",
  openQuestions: ["Should students keep the old price?"],
  actionItems: [
    { owner: "@ben", action: "Model the grandfathering cost." },
    { owner: "@cy", action: "Draft the customer announcement." },
    { owner: "Ruth", action: "Approve the announcement." },
  ],
};

/** Hold one employee's next turn until the test lets it go. */
let holdNext: { name: string; release: Promise<void> } | null = null;
/** Make the next turn for this name wait until it is stopped. */
let waitForStop: string | null = null;
const turnsSeen: Array<{ who: string; tools: string[]; kind: "turn" | "outcome" | "work" }> = [];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type RunParams = Parameters<typeof agentRuntime.run>[0];

function lastUserText(params: RunParams): string {
  const last = [...params.messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  return last.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

agentRuntime.run = (async (params: RunParams) => {
  const who = /^You are (\w+),/.exec(params.system)?.[1] ?? "?";
  const tools = [...params.registry.all.keys()];
  const submit = params.registry.resolve("submit_discussion_outcome");
  if (submit) {
    turnsSeen.push({ who, tools, kind: "outcome" });
    await delay(300);
    await submit.run(OUTCOME);
    return { finalText: "Submitted.", steps: 2, stopReason: "end_turn" };
  }
  const prompt = lastUserText(params);
  if (/asked everyone to start the work/.test(prompt)) {
    turnsSeen.push({ who, tools, kind: "work" });
    await delay(300);
    return { finalText: FOLLOW_THROUGH[who] ?? "Done.", steps: 1, stopReason: "end_turn" };
  }
  turnsSeen.push({ who, tools, kind: "turn" });
  if (waitForStop === who) {
    waitForStop = null;
    await new Promise<void>((_resolve, reject) => {
      params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
  if (holdNext?.name === who) {
    const { release } = holdNext;
    holdNext = null;
    await release;
  }
  await delay(250);
  const round = Number(/Round (\d+) of/.exec(prompt)?.[1] ?? "1");
  return { finalText: round === 1 ? (ROUND_ONE[who] ?? "PASS") : "PASS", steps: 1, stopReason: "end_turn" };
}) as typeof agentRuntime.run;

// ---------- The page, built and served beside the API ----------

console.log("Group chats: building the Workspace page.");
await fs.mkdir(path.join(root, ".tmp"), { recursive: true });
const fixtureRoot = await fs.mkdtemp(path.join(root, ".tmp/group-chats-fixture-"));
await fs.writeFile(
  path.join(fixtureRoot, "index.html"),
  '<html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' +
    '<script type="module" src="../../scripts/groupChatHarness.tsx"></script></html>',
);
const distDir = path.join(fixtureRoot, "dist");
await build({
  configFile: path.join(root, "vite.config.ts"),
  root: fixtureRoot,
  logLevel: "warn",
  build: { outDir: distDir, minify: false, reportCompressedSize: false },
});

const app = express();
app.use(express.json());
app.use(async (req, _res, next) => {
  const userId = req.header("x-test-user");
  (req as unknown as { session: Record<string, unknown> | null }).session = userId
    ? { userId, sessionVersion: 0, authenticatedAt: Date.now() }
    : null;
  await persistTestSession(req);
  next();
});
app.use("/api/companies/:cid/workspace", workspaceRouter);
app.use("/api/companies/:cid/workspace", workspaceDiscussionsRouter);
// Anything else the page reaches for (avatars, the bell) is outside this fixture.
app.use("/api", (_req, res) => res.status(404).json({ error: "Not in this fixture" }));
app.use(express.static(distDir));
app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
app.use(errorHandler);
const server: Server = await new Promise((resolve) => {
  const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
});
attachRealtime(server);
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const signedIn = new URLSearchParams({
  cid: company.id,
  uid: owner.id,
  name: owner.name,
  email: owner.email,
}).toString();

// ---------- Chrome ----------

const browser = await chromium.launch({
  channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  extraHTTPHeaders: { "x-test-user": owner.id },
});
context.setDefaultTimeout(TIMEOUT);
const pageErrors: string[] = [];

async function open(pathname: string, width = 1280): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${origin}${pathname}?${signedIn}`, { waitUntil: "commit", timeout: TIMEOUT });
  return page;
}

const bar = (page: Page) => page.getByRole("region", { name: "Group discussion" });
const outcomeCard = (page: Page) => page.getByRole("article", { name: "Discussion outcome" });

async function pick(page: Page, names: string[]) {
  const list = page.getByRole("list", { name: "AI Employees" });
  for (const name of names) {
    await list.getByRole("button", { name: new RegExp(`^${name}\\b`) }).click();
  }
}

let checks = 0;
try {
  await fs.mkdir(artifacts, { recursive: true });

  // 1. Start a group chat from Workspace, in a couple of clicks.
  const page = await open("/c/acme/workspace");
  await page.getByRole("button", { name: "Start a group chat" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Start a group chat" });
  await dialog.waitFor();
  await pick(page, ["Ada", "Ben", "Cy"]);
  const order = dialog.getByRole("list", { name: "Taking part, in speaking order" });
  assert.match(await order.innerText(), /Ada\s*Leads[\s\S]*Ben[\s\S]*Cy/i, "the first picked leads");
  await dialog
    .getByLabel("What should they work out?")
    .fill("Should we raise the Pro plan to $49?\nWeigh churn against margin and tell me what to do.");
  let release!: () => void;
  holdNext = { name: "Ada", release: new Promise<void>((resolve) => (release = resolve)) };
  await dialog.getByRole("button", { name: "Start discussion" }).click();
  await dialog.waitFor({ state: "detached" });
  checks++;

  // 2. The discussion runs live: who is thinking, which round.
  await page.getByRole("heading", { name: "Should we raise the Pro plan to $49?" }).waitFor();
  await bar(page).getByText("Discussing · round 1 of 3 · Ada is thinking…").waitFor();
  assert.equal(
    await bar(page).locator('[data-participant-state="speaking"]').getAttribute("aria-label"),
    "Ada — thinking (leads)",
  );
  assert.match(await bar(page).innerText(), /Turn 1 of \d+/, "the turn budget is visible");
  await page.screenshot({ path: path.join(artifacts, "group-chats-live.png"), fullPage: true });
  release();
  checks++;

  // 3. They build on each other, then hand back one outcome.
  // "@ben" renders as a mention pill, so match the words after it.
  await page.getByText("can finance carry it?", { exact: false }).waitFor();
  await page.getByText("gross margin goes from 62% to 71%", { exact: false }).waitFor();
  await page.getByText("grandfathered for six months", { exact: false }).waitFor();
  await outcomeCard(page).waitFor();
  await bar(page).waitFor({ state: "detached" });
  const card = outcomeCard(page);
  assert.match(await card.innerText(), /Written by Ada/);
  assert.match(await card.innerText(), /everyone agreed/);
  assert.match(await card.innerText(), /Announce the new price on Monday/);
  assert.match(await card.innerText(), /Should students keep the old price\?/);
  const who = card.getByRole("list", { name: "Who does what" });
  assert.match(await who.innerText(), /Ben\s*Model the grandfathering cost\./);
  assert.match(await who.innerText(), /Cy\s*Draft the customer announcement\./);
  assert.match(await who.innerText(), /Ruth\s*Approve the announcement\./);
  checks++;

  // Every turn talked read-only: no writer, sender or delegator was handed over.
  for (const turn of turnsSeen.filter((t) => t.kind === "turn")) {
    for (const forbidden of ["send_mail", "send_workspace_message", "create_routine", "ask_colleague"]) {
      assert.equal(turn.tools.includes(forbidden), false, `${turn.who} held ${forbidden}`);
    }
  }
  assert.deepEqual(
    turnsSeen.filter((t) => t.kind === "outcome").map((t) => t.tools),
    [["submit_discussion_outcome"]],
    "the outcome is written with one tool and nothing else",
  );
  checks++;

  // 4. Start the work: each owner does its share and reports back.
  await card.getByRole("button", { name: "Start the work" }).click();
  await page.getByText(FOLLOW_THROUGH.Ben).waitFor();
  await page.getByText(FOLLOW_THROUGH.Cy).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[aria-label="Who does what"] li').length === 3 &&
      [...document.querySelectorAll('[aria-label="Who does what"] li')].filter((li) =>
        /Done/.test(li.textContent ?? ""),
      ).length === 2,
    undefined,
    { timeout: TIMEOUT },
  );
  assert.equal(await card.getByRole("button", { name: "Start the work" }).count(), 0, "only once");
  assert.match(await card.innerText(), /The work has started/);
  // The transcript reads in the order it was written: the note, then the reports.
  const positions = await page.evaluate(() => {
    const text = document.body.innerText;
    return [
      text.indexOf("Ruth started the work for Ben and Cy."),
      text.indexOf("Modelled it: grandfathering"),
      text.indexOf("Drafted the customer announcement"),
    ];
  });
  assert.ok(
    positions[0] >= 0 && positions[0] < positions[1] && positions[0] < positions[2],
    JSON.stringify(positions),
  );
  const work = turnsSeen.filter((t) => t.kind === "work");
  assert.deepEqual(work.map((t) => t.who).sort(), ["Ben", "Cy"]);
  await page.screenshot({ path: path.join(artifacts, "group-chats-outcome.png"), fullPage: true });
  checks++;

  // 5. A second discussion, set to two rounds under Advanced, stopped mid-turn.
  await page.getByRole("button", { name: "Start group chat" }).click();
  const second = page.getByRole("dialog", { name: "Start a group chat" });
  await pick(page, ["Ada", "Ben"]);
  await second.getByLabel("What should they work out?").fill("Should we open a Berlin office?");
  await second.getByRole("button", { name: /^Advanced/ }).click();
  await second.getByRole("combobox", { name: "Rounds" }).click();
  await page.getByRole("option", { name: "2 rounds" }).click();
  waitForStop = "Ada";
  await second.getByRole("button", { name: "Start discussion" }).click();
  await second.waitFor({ state: "detached" });
  await bar(page).getByText("Discussing · round 1 of 2 · Ada is thinking…").waitFor();
  await bar(page).getByRole("button", { name: "Stop" }).click();
  await bar(page).waitFor({ state: "detached" });
  await page.getByRole("note").filter({ hasText: "Stopped by Ruth." }).waitFor();
  assert.equal(await outcomeCard(page).count(), 0, "a stopped discussion writes no outcome");
  checks++;

  // 6. The sidebar lists both group chats.
  const sidebar = page.getByRole("complementary", { name: "Workspace conversations" });
  await sidebar.getByRole("button", { name: /^Should we open a Berlin office\?/ }).waitFor();
  await sidebar.getByRole("button", { name: /^Should we raise the Pro plan to \$49\?/ }).waitFor();
  checks++;

  // 7. At phone width: the list, then the conversation, then back.
  const phone = await open("/c/acme/workspace", 390);
  const phoneList = phone.getByRole("complementary", { name: "Workspace conversations" });
  await phoneList.getByRole("button", { name: /^Should we raise the Pro plan to \$49\?/ }).click();
  await outcomeCard(phone).waitFor();
  const overflow = await phone.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `the page scrolls sideways by ${overflow}px`);
  await phone.screenshot({ path: path.join(artifacts, "group-chats-mobile.png"), fullPage: true });
  await phone.getByRole("button", { name: "All conversations" }).click();
  await phoneList.waitFor();
  assert.equal(await outcomeCard(phone).count(), 0, "the list replaces the conversation");
  await phone.close();
  checks++;

  // 8. From an employee's page: Ben is already picked to lead.
  const employeePage = await open(`/c/acme/employees/${ben.id}`);
  await employeePage.getByRole("button", { name: "Start a group chat" }).click();
  const fromEmployee = employeePage.getByRole("dialog", { name: "Start a group chat" });
  await fromEmployee.waitFor();
  assert.match(
    await fromEmployee.getByRole("list", { name: "Taking part, in speaking order" }).innerText(),
    /Ben\s*Leads/i,
  );
  await pick(employeePage, ["Cy"]);
  await fromEmployee.getByLabel("What should they work out?").fill("How do we cut support costs?");
  await fromEmployee.getByRole("button", { name: "Start discussion" }).click();
  await employeePage.waitForURL(/\/c\/acme\/workspace\/[0-9a-f-]{36}/);
  await outcomeCard(employeePage).waitFor();
  assert.match(await outcomeCard(employeePage).innerText(), /Written by Ben/);
  await employeePage.close();
  checks++;

  // What the database says about all of it.
  await settleGroupDiscussionsForTests();
  const rows = await AppDataSource.getRepository(GroupDiscussion).find({ order: { createdAt: "ASC" } });
  assert.deepEqual(
    rows.map((d) => [d.status, d.endReason]),
    [
      ["concluded", "converged"],
      ["stopped", "stopped"],
      ["concluded", "converged"],
    ],
  );
  assert.deepEqual(
    rows.map((d) => d.maxRounds),
    [3, 2, 3],
    "the rounds picked under Advanced",
  );
  const stoppedTurns = await AppDataSource.getRepository(ChannelMessage).count({
    where: { discussionId: rows[1].id, discussionRole: "turn" },
  });
  assert.equal(stoppedTurns, 0, "the abandoned turn was never posted");
  assert.deepEqual(pageErrors, []);
  checks++;

  console.log(`Group chats: ${checks} browser checks passed.`);
} catch (error) {
  // Leave what the browser saw beside the failure.
  for (const [index, page] of context.pages().entries()) {
    await page
      .screenshot({ path: path.join(artifacts, `group-chats-failure-${index}.png`), fullPage: true })
      .catch(() => undefined);
  }
  console.error(`Group chats: failed after ${checks} checks.`, pageErrors);
  throw error;
} finally {
  await context.close();
  await browser.close();
  await settleGroupDiscussionsForTests().catch(() => undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeTestDb();
  await fs.rm(fixtureRoot, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
}
