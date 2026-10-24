/**
 * The visual system in real Chrome, against the real App and a seeded company
 * (scripts/visualSystemServer.ts): every key page renders in light and dark, on
 * a desktop and on a phone, with
 *
 *   - no sideways scroll, of the document or of the main pane;
 *   - no console errors or uncaught exceptions;
 *   - a visible focus indicator wherever the keyboard lands, distinct from the
 *     control's resting look and at least 3:1 against what surrounds it;
 *   - every visible piece of text at WCAG AA against what is painted behind it
 *     (4.5:1, or 3:1 for large text);
 *   - on a phone, everything a finger presses at least 32×32px — counting the
 *     label it sits in and a `touch-target` hit area (styles/index.css) — and
 *     every hit area taking presses: what is inside it stays pressable, and a
 *     press beside the control reaches the control.
 *
 *   npm run build:client && npm run test:visual-system
 *   npm run test:visual-system -- --shots=../output/visual   one PNG per page and mode
 *   npm run test:visual-system -- --client=/some/dist/client photograph another build
 *   npm run test:visual-system -- --report                   list problems, never fail
 *   npm run test:visual-system -- --only=finance,routines    pages whose name matches
 *   npm run test:visual-system -- --modes=phone              modes whose name matches
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import {
  aaMinimum,
  contrastRatio,
  flatten,
  formatRatio,
  parseColor,
  type Rgba,
} from "../client/lib/contrast";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(appRoot, "../output/playwright");
const flag = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
const shotsDir = flag("shots") ? path.resolve(flag("shots")!) : null;
const clientDir = flag("client") ? path.resolve(flag("client")!) : "";
const reportOnly = process.argv.includes("--report");
const only = (flag("only") ?? "")
  .split(",")
  .map((term) => term.trim())
  .filter(Boolean);
const modeFilter = flag("modes") ?? "";

type Mode = {
  name: string;
  width: number;
  height: number;
  scheme: "light" | "dark";
  phone: boolean;
};
const ALL_MODES: Mode[] = [
  { name: "desktop-light", width: 1440, height: 900, scheme: "light", phone: false },
  { name: "desktop-dark", width: 1440, height: 900, scheme: "dark", phone: false },
  { name: "phone-light", width: 390, height: 844, scheme: "light", phone: true },
  { name: "phone-dark", width: 390, height: 844, scheme: "dark", phone: true },
];
const MODES = ALL_MODES.filter((mode) => !modeFilter || mode.name.includes(modeFilter));

await fs.mkdir(output, { recursive: true });
if (shotsDir) await fs.mkdir(shotsDir, { recursive: true });
const serverLogPath = path.join(output, "visual-system-server.log");
await fs.writeFile(serverLogPath, "");

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-visual-system-"));
const child = spawn(
  process.execPath,
  ["--import", "tsx", "scripts/visualSystemServer.ts", testRoot, clientDir],
  {
    cwd: appRoot,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let serverLog = "";
child.stdout.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
});
child.stderr.on("data", (chunk) => {
  serverLog += String(chunk);
  appendFileSync(serverLogPath, chunk);
});

async function until<T>(read: () => T | undefined, what: string, timeout = 300_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (child.exitCode !== null) {
      throw new Error(`The App exited (${child.exitCode}) while ${what}:\n${serverLog.slice(-4000)}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out ${what}:\n${serverLog.slice(-4000)}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

const problems: string[] = [];
let passed = 0;
function problem(message: string) {
  problems.push(message);
  console.error(`  ✗ ${message}`);
}

let browser: Browser | undefined;
try {
  const [origin, email, password] = await until(() => {
    const match = /\[visual-server\] ready (\S+) (\S+) (\S+)/.exec(serverLog);
    return match ? [match[1], match[2], match[3]] : undefined;
  }, "starting the App");
  console.log(`Visual system — ${origin}${clientDir ? ` (client: ${clientDir})` : ""}`);

  browser = await chromium.launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  });

  const newContext = async (mode: Mode, storageState?: string): Promise<BrowserContext> => {
    const context = await browser!.newContext({
      viewport: { width: mode.width, height: mode.height },
      colorScheme: mode.scheme,
      reducedMotion: "reduce",
      hasTouch: mode.phone,
      isMobile: mode.phone,
      deviceScaleFactor: mode.phone ? 2 : 1,
      storageState,
    });
    context.setDefaultTimeout(30_000);
    // tsx compiles with esbuild's keepNames, which wraps the helpers declared
    // inside `page.evaluate` callbacks in a `__name()` call the page lacks.
    await context.addInitScript({ content: "window.__name = (fn) => fn;" });
    // Transitions off, so a focus ring is read at its final colour rather than
    // mid-fade, and screenshots never catch a panel halfway in.
    await context.addInitScript({
      content: `document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = "*, *::before, *::after { transition: none !important; animation-duration: 0s !important; animation-delay: 0s !important; caret-color: transparent !important; }";
        document.head.appendChild(style);
      });`,
    });
    // Only this App and the web font are reachable; anything else would be a
    // page reaching out of the install.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      const local = url.hostname === "127.0.0.1" || ["data:", "blob:"].includes(url.protocol);
      const font = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
      return local || font ? route.continue() : route.abort();
    });
    return context;
  };

  /* ── Sign in, then seed a company through the API ─────────────────────── */

  const signIn = await newContext(MODES[0]);
  const signInPage = await signIn.newPage();
  await signInPage.goto(`${origin}/login`, { waitUntil: "domcontentloaded" });
  await signInPage.getByLabel("Email", { exact: true }).fill(email);
  await signInPage.getByLabel("Password", { exact: true }).fill(password);
  await signInPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await signInPage.waitForURL((url) => url.pathname !== "/login");
  const storageState = path.join(testRoot, "storage.json");
  const http = signIn.request;
  const call = async <T>(
    method: "GET" | "POST" | "PUT",
    route: string,
    data?: unknown,
  ): Promise<T> => {
    const response = await http.fetch(`${origin}${route}`, { method, data });
    assert.ok(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`);
    return (await response.json()) as T;
  };

  const company = await call<{ id: string; slug: string }>("POST", "/api/companies", {
    name: "Northwind Provisions",
    mission: "Keep every independent grocer on our list fully stocked, every week.",
    vision: "A wholesaler small shops can trust like a neighbour.",
    goal: { title: "Reach 120 wholesale accounts by June", targetValue: 120, unit: "accounts" },
    timezone: "Europe/London",
  });
  const api = `/api/companies/${company.id}`;
  type Employee = { id: string; slug: string; name: string };
  const roster: Array<[string, string]> = [
    ["Ava Chen", "Operations Lead"],
    ["Leo Park", "Sales Associate"],
    ["Mira Patel", "Finance Analyst"],
    ["Sam Rivera", "Customer Support"],
  ];
  const employees: Employee[] = [];
  for (const [name, role] of roster) {
    employees.push(await call<Employee>("POST", `${api}/employees`, { name, role }));
  }
  type Routine = { id: string; slug: string };
  const routinePlan: Array<[number, string, string, string]> = [
    [0, "Morning inbox triage", "0 8 * * 1-5", "Sort overnight email, answer what is routine, file the rest."],
    [0, "Weekly stock review", "0 9 * * 1", "Compare stock levels with last month's orders and flag gaps."],
    [1, "Follow up on open quotes", "30 10 * * 1-5", "Chase every quote older than three days."],
    [1, "New lead research", "0 14 * * 2,4", "Research new grocers in our delivery area."],
    [2, "Reconcile yesterday's payments", "0 7 * * 1-5", "Match bank lines to invoices and report gaps."],
    [3, "Close resolved tickets", "0 17 * * 1-5", "Close tickets the customer confirmed are fixed."],
  ];
  const routines: Array<Routine & { employee: Employee }> = [];
  for (const [index, name, cronExpr, brief] of routinePlan) {
    const routine = await call<Routine>("POST", `${api}/employees/${employees[index].id}/routines`, {
      name,
      cronExpr,
      brief,
    });
    routines.push({ ...routine, employee: employees[index] });
  }
  for (const [index, name] of [
    [0, "Supplier escalation playbook"],
    [1, "Quote follow-up tone"],
  ] as const) {
    await call("POST", `${api}/employees/${employees[index].id}/skills`, { name });
  }

  const stages = await call<Array<{ id: string; name: string; kind?: string }>>(
    "GET",
    `${api}/revenue/stages`,
  );
  const contactPlan: Array<[string, string, string, string]> = [
    ["Priya Shah", "priya@cornerpantry.test", "Owner", "Corner Pantry"],
    ["Tomás García", "tomas@greenleafmarket.test", "Buyer", "Greenleaf Market"],
    ["Hannah Okafor", "hannah@thedailycrust.test", "Operations Manager", "The Daily Crust"],
    ["Ben Whitaker", "ben@harbourfoods.test", "Head of Purchasing", "Harbour Foods"],
    ["Yuki Tanaka", "yuki@oakandember.test", "Co-founder", "Oak & Ember Deli"],
    ["Carlos Mendes", "carlos@sunrisegrocers.test", "Store Manager", "Sunrise Grocers"],
  ];
  const contacts: Array<{ id: string }> = [];
  for (const [name, contactEmail, title, companyName] of contactPlan) {
    const created = await call<{ id: string } | { contact: { id: string } }>(
      "POST",
      `${api}/revenue/contacts`,
      { name, email: contactEmail, title, companyName, lifecycleStage: "lead" },
    );
    contacts.push("contact" in created ? created.contact : created);
  }
  const openStages = stages.filter((stage) => stage.kind !== "won" && stage.kind !== "lost");
  const dealPlan: Array<[string, number]> = [
    ["Corner Pantry — weekly produce", 1_850_000],
    ["Greenleaf Market — dry goods", 4_200_000],
    ["Harbour Foods — seafood line", 9_750_000],
    ["Oak & Ember — deli supplies", 1_240_000],
    ["Sunrise Grocers — expansion", 6_300_000],
  ];
  for (const [index, [title, amountCents]] of dealPlan.entries()) {
    await call("POST", `${api}/revenue/deals`, {
      title,
      amountCents,
      currency: "USD",
      primaryContactId: contacts[index % contacts.length].id,
      stageId: openStages.length ? openStages[index % openStages.length].id : null,
      nextStep: "Send the updated price list",
    });
  }

  const customers: Array<{ id: string }> = [];
  for (const [name, customerEmail] of [
    ["Corner Pantry", "accounts@cornerpantry.test"],
    ["Greenleaf Market", "billing@greenleafmarket.test"],
    ["Harbour Foods", "ap@harbourfoods.test"],
  ]) {
    customers.push(
      await call<{ id: string }>("POST", `${api}/customers`, {
        name,
        email: customerEmail,
        accountStatus: "customer",
        currency: "USD",
      }),
    );
  }
  for (const [index, customer] of customers.entries()) {
    const invoice = await call<{ slug: string }>("POST", `${api}/invoices`, {
      customerId: customer.id,
      currency: "USD",
      lines: [
        { description: "Weekly produce delivery", quantity: 4, unitPriceCents: 32_500 },
        { description: "Dry goods restock", quantity: 2, unitPriceCents: 18_900 + index * 1000 },
      ],
    });
    if (index < 2) await call("POST", `${api}/invoices/${invoice.slug}/issue`, {});
  }

  const notebook = await call<{ slug: string }>("POST", `${api}/notebooks`, { title: "Operations" });
  const notes: Array<{ slug: string }> = [];
  for (const [title, body] of [
    [
      "Supplier contacts",
      "# Supplier contacts\n\nWho to call when a delivery slips.\n\n- **Brightline Farms** — produce, ships Mon/Thu\n- **Acorn Supply** — dry goods, 48h lead time\n\n> Always confirm the cold-chain slot before promising a date.",
    ],
    ["Returns policy", "Customers can return unopened goods within 14 days for a full credit."],
    ["Delivery routes", "North loop on Mondays, harbour loop on Thursdays."],
  ]) {
    notes.push(
      await call<{ slug: string }>("POST", `${api}/notes`, {
        title,
        body,
        notebookSlug: notebook.slug,
      }),
    );
  }

  const channel = await call<{ id: string }>("POST", `${api}/workspace/channels`, {
    name: "operations",
    topic: "Day-to-day running of the warehouse",
    kind: "public",
  });
  for (const content of [
    "Morning all — the Brightline delivery is running about an hour late today.",
    "Thanks for the heads-up. I'll move the harbour loop to start at 11.",
    "Invoices for last week are out; two are already paid.",
  ]) {
    await call("POST", `${api}/workspace/channels/${channel.id}/messages`, { content });
  }

  const project = await call<{ slug: string }>("POST", `${api}/projects`, {
    name: "Spring launch",
    description: "New seasonal range and the price list that goes with it.",
    key: "SPR",
  });
  for (const [title, status, priority] of [
    ["Photograph the new range", "in_progress", "high"],
    ["Draft the spring price list", "todo", "medium"],
    ["Email the top 20 accounts", "backlog", "low"],
    ["Book the trade fair stand", "done", "medium"],
  ]) {
    await call("POST", `${api}/projects/${project.slug}/todos`, { title, status, priority });
  }

  const seeded = await call<Record<string, number>>("POST", "/__visual/seed", {
    companyId: company.id,
  });
  await signIn.storageState({ path: storageState });
  await signIn.close();
  console.log(
    `Seeded ${employees.length} AI Employees, ${routines.length} Routines, ${contacts.length} Contacts, ` +
      `${seeded.runs} Runs, ${seeded.decisions} Decisions`,
  );

  /* ── The pages ─────────────────────────────────────────────────────────── */

  const c = `/c/${company.slug}`;
  const [ava] = employees;
  const triage = routines[0];
  /** `scrollTo` names a heading to bring into view first, for content below the fold. */
  const PAGES: Array<{ name: string; path: string; signedOut?: boolean; scrollTo?: string }> = [
    { name: "login", path: "/login", signedOut: true },
    { name: "home", path: c },
    { name: "routines", path: `${c}/routines` },
    { name: "routine-detail", path: `${c}/routines/${triage.employee.slug}/${triage.slug}` },
    { name: "routines-running", path: `${c}/routines/running` },
    { name: "employees", path: `${c}/employees` },
    { name: "employee-chat", path: `${c}/employees/${ava.slug}/chat` },
    { name: "employee-model", path: `${c}/employees/${ava.slug}/settings/model` },
    { name: "workspace", path: `${c}/workspace/${channel.id}` },
    { name: "mail", path: `${c}/mail` },
    { name: "decisions", path: `${c}/decisions` },
    { name: "goals", path: `${c}/goals` },
    { name: "revenue-contacts", path: `${c}/revenue/contacts` },
    { name: "revenue-deals", path: `${c}/revenue/deals` },
    { name: "finance", path: `${c}/finance` },
    { name: "finance-invoices", path: `${c}/finance/invoices` },
    { name: "finance-invoice-new", path: `${c}/finance/invoices/new` },
    { name: "finance-invoice-form", path: `${c}/finance/invoices/new?kind=one-time` },
    {
      name: "finance-invoice-lines",
      path: `${c}/finance/invoices/new?kind=one-time`,
      scrollTo: "Line items",
    },
    { name: "finance-banking", path: `${c}/finance/banking` },
    { name: "notes", path: `${c}/notes/${notebook.slug}/${notes[0].slug}` },
    { name: "tasks", path: `${c}/tasks/p/${project.slug}` },
    { name: "settings-company", path: `${c}/settings/company` },
    { name: "settings-members", path: `${c}/settings/members` },
    { name: "settings-ai-models", path: `${c}/settings/ai-models` },
    { name: "admin", path: `${c}/admin/overview` },
  ].filter((page) => only.length === 0 || only.some((term) => page.name.includes(term)));

  for (const target of PAGES) {
    for (const mode of MODES) {
      const label = `${target.name} · ${mode.name}`;
      const context = await newContext(mode, target.signedOut ? undefined : storageState);
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const where = message.location().url;
        // A blocked or slow web font is the network, not the page.
        if (where && !where.startsWith(origin)) return;
        // Signed out, the App asks who is there and is told nobody: expected.
        if (target.signedOut && where.endsWith("/api/auth/me") && /\b401\b/.test(message.text())) {
          return;
        }
        consoleErrors.push(`${message.text()}${where ? ` (${where.replace(origin, "")})` : ""}`);
      });
      page.on("pageerror", (error) => consoleErrors.push(`uncaught: ${error.message}`));
      try {
        await page.goto(`${origin}${target.path}`, { waitUntil: "domcontentloaded" });
        await settle(page);
        if (target.scrollTo) {
          await page
            .getByRole("heading", { name: target.scrollTo, exact: true })
            .evaluate((el) => el.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(200);
        }
        if (shotsDir) {
          await page.screenshot({ path: path.join(shotsDir, `${target.name}--${mode.name}.png`) });
        }
        const before = problems.length;
        await checkOverflow(page, label);
        await checkContrast(page, label);
        if (mode.phone) await checkTargets(page, label);
        else await checkFocus(page, label);
        for (const error of consoleErrors) problem(`${label}: console error — ${error}`);
        if (problems.length === before) {
          passed += 1;
          console.log(`  ✓ ${label}`);
        }
      } catch (error) {
        problem(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        await page
          .screenshot({ path: path.join(output, `visual-failed-${target.name}-${mode.name}.png`) })
          .catch(() => undefined);
      } finally {
        await context.close();
      }
    }
  }
} catch (error) {
  problem(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  await browser?.close().catch(() => undefined);
  child.kill("SIGTERM");
  await fs.rm(testRoot, { recursive: true, force: true }).catch(() => undefined);
}

console.log(`\n${passed} page views clean, ${problems.length} problems`);
if (problems.length && !reportOnly) process.exit(1);
process.exit(0);

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/** Wait for the page to finish loading what it shows first. */
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const deadline = Date.now() + 12_000;
  for (;;) {
    const busy = await page.evaluate(() => {
      const root = document.getElementById("main-content") ?? document.body;
      const text = (root.textContent ?? "").trim();
      const splash = document.querySelector("[data-app-splash]");
      const spinner = root.querySelector(".animate-spin, [aria-busy='true']");
      return Boolean(splash) || text.length < 10 || Boolean(spinner);
    });
    if (!busy || Date.now() > deadline) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
}

/**
 * Nothing scrolls sideways, and nothing is cut off at the side either: an
 * `overflow-hidden` ancestor hides a too-wide card rather than scrolling it,
 * which `scrollWidth` cannot see. Content inside a deliberate horizontal
 * scroller (a wide table, a board) is fine — it can be scrolled to.
 */
async function checkOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const main = document.getElementById("main-content");
    const width = doc.clientWidth;
    const scrolls = (el: Element) => /(auto|scroll)/.test(getComputedStyle(el).overflowX);
    const offenders: Element[] = [];
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.right <= width + 1 && rect.left >= -1) continue;
      if (el.closest("[aria-hidden='true'], [inert], [hidden], svg")) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || style.position === "fixed") continue;
      if (style.clip === "rect(0px, 0px, 0px, 0px)") continue;
      let scrollable = false;
      for (let cur = el.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
        if (scrolls(cur) && cur !== main && cur.scrollWidth > cur.clientWidth + 1) {
          scrollable = true;
          break;
        }
      }
      if (!scrollable) offenders.push(el);
    }
    // Report where it starts: an offender inside another offender is the same cut.
    const outermost = offenders.filter(
      (el) => !offenders.some((other) => other !== el && other.contains(el)),
    );
    const describe = (el: Element) => {
      const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 4).join(".") : "";
      const text = (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 30);
      const rect = el.getBoundingClientRect();
      const past = Math.round(Math.max(rect.right - width, -rect.left));
      return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} "${text}" (${past}px past the edge)`;
    };
    // A pane that scrolls vertically scrolls sideways too once its content is
    // too wide (`overflow-y: auto` makes x auto as well). Unless the classes
    // ask for sideways scrolling, that is a page sliding left and right.
    const panes = Array.from(document.body.querySelectorAll("*")).filter((el) => {
      const s = getComputedStyle(el);
      if (!/(auto|scroll)/.test(s.overflowY) || !/(auto|scroll)/.test(s.overflowX)) return false;
      const cls = typeof el.className === "string" ? el.className : "";
      if (/(^|\s)overflow-(x-)?(auto|scroll)(\s|$)/.test(cls)) return false;
      return el.scrollWidth > el.clientWidth + 1 && el.getBoundingClientRect().width > 0;
    });
    return {
      document: doc.scrollWidth - doc.clientWidth,
      main: main ? main.scrollWidth - main.clientWidth : 0,
      clipped: outermost.slice(0, 3).map(describe),
      clippedCount: outermost.length,
      panes: panes.slice(0, 3).map((el) => `${describe(el)} scrolls ${el.scrollWidth - el.clientWidth}px sideways`),
    };
  });
  if (overflow.document > 0) problem(`${label}: the page scrolls sideways by ${overflow.document}px`);
  if (overflow.main > 1) problem(`${label}: the main pane scrolls sideways by ${overflow.main}px`);
  if (overflow.panes.length > 0) {
    problem(`${label}: a scrolling pane slides sideways`);
    for (const line of overflow.panes) console.error(`      ${line}`);
  }
  if (overflow.clippedCount > 0) {
    problem(`${label}: ${overflow.clippedCount} element(s) cut off at the side of the screen`);
    for (const line of overflow.clipped) console.error(`      ${line}`);
  }
}

type TextSample = {
  text: string;
  path: string;
  color: string;
  layers: string[];
  opacity: number;
  fontSize: number;
  fontWeight: number;
  unknownBackground: boolean;
};

/** Every visible run of text, with what is painted behind it. */
async function checkContrast(page: Page, label: string) {
  const samples: TextSample[] = await page.evaluate(() => {
    const describe = (el: Element): string => {
      const parts: string[] = [];
      let node: Element | null = el;
      while (node && parts.length < 4 && node !== document.body) {
        const id = node.id ? `#${node.id}` : "";
        const cls =
          typeof node.className === "string"
            ? node.className
                .split(/\s+/)
                .filter((name) => /^(text|bg|font)-/.test(name))
                .slice(0, 3)
                .map((name) => `.${name}`)
                .join("")
            : "";
        parts.unshift(`${node.tagName.toLowerCase()}${id}${cls}`);
        node = node.parentElement;
      }
      return parts.join(" > ");
    };
    const out: TextSample[] = [];
    const seen = new Set<Element>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const el = node.parentElement;
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (el.closest("[aria-hidden='true'], svg, [hidden], script, style, noscript, option")) continue;
      if (el.closest(":disabled, [aria-disabled='true'], [data-visual-ignore]")) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || style.display === "none") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      // Visually hidden (sr-only) text is for screen readers.
      if (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)") continue;
      let opacity = 1;
      for (let cur: Element | null = el; cur; cur = cur.parentElement) {
        opacity *= Number.parseFloat(getComputedStyle(cur).opacity || "1");
      }
      if (opacity < 0.05) continue;
      const layers: string[] = [];
      let unknownBackground = false;
      for (let cur: Element | null = el; cur; cur = cur.parentElement) {
        const s = getComputedStyle(cur);
        if (s.backgroundImage && s.backgroundImage !== "none") {
          unknownBackground = true;
          break;
        }
        const bg = s.backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
          layers.push(bg);
          if (!/rgba|\//.test(bg) || /,\s*1\)$/.test(bg)) break;
        }
      }
      out.push({
        text: text.slice(0, 60),
        path: describe(el),
        color: style.color,
        layers,
        opacity,
        fontSize: Number.parseFloat(style.fontSize),
        fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
        unknownBackground,
      });
    }
    return out;
  });
  const failures: string[] = [];
  for (const sample of samples) {
    if (sample.unknownBackground) continue;
    const fg = parseColor(sample.color);
    const layers = sample.layers.map(parseColor).filter((layer): layer is Rgba => Boolean(layer));
    if (!fg) continue;
    const bg = flatten(layers);
    const ratio = contrastRatio({ ...fg, a: fg.a * sample.opacity }, bg);
    const minimum = aaMinimum(sample.fontSize, sample.fontWeight);
    if (ratio + 1e-6 < minimum) {
      failures.push(
        `${formatRatio(ratio)} < ${minimum}:1 "${sample.text}" (${sample.color} on ${
          sample.layers[0] ?? "page"
        }, ${sample.fontSize}px) ${sample.path}`,
      );
    }
  }
  const unique = [...new Set(failures)];
  if (unique.length) {
    problem(`${label}: ${unique.length} text runs below WCAG AA`);
    for (const failure of unique.slice(0, reportOnly ? 40 : 12)) console.error(`      ${failure}`);
  }
}

/**
 * On a phone, everything a finger presses is at least 32×32px: buttons, links,
 * tabs, switches, fields. A link inside a sentence is exempt (WCAG's inline
 * exception), and a control inside its label is measured by the label, which
 * is what the finger actually hits.
 */
async function checkTargets(page: Page, label: string) {
  const small = await page.evaluate((minimum) => {
    const selector = [
      "button",
      "a[href]",
      "summary",
      "select",
      "textarea",
      "input:not([type='hidden'])",
      "[role='button']",
      "[role='tab']",
      "[role='switch']",
      "[role='checkbox']",
      "[role='menuitem']",
      "[role='option']",
      "[role='link']",
    ].join(", ");
    const clips = (s: CSSStyleDeclaration) => s.overflowX !== "visible" || s.overflowY !== "visible";
    // A box, grown by an absolutely positioned ::after on a positioned box
    // (`touch-target`) and cut back by anything that clips that.
    const hitArea = (node: Element) => {
      const own = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const after = getComputedStyle(node, "::after");
      if (
        after.content === "none" ||
        after.content === "normal" ||
        after.position !== "absolute" ||
        style.position === "static" ||
        clips(style)
      ) {
        return { width: own.width, height: own.height };
      }
      const cx = own.left + own.width / 2;
      const cy = own.top + own.height / 2;
      const w = Math.max(own.width, Number.parseFloat(after.minWidth) || 0);
      const h = Math.max(own.height, Number.parseFloat(after.minHeight) || 0);
      let area = { left: cx - w / 2, right: cx + w / 2, top: cy - h / 2, bottom: cy + h / 2 };
      // Hidden overflow cuts the area at that box. A scroller does not: the
      // area is part of what scrolls, and past a scroller on an axis, outer
      // boxes no longer decide what can be reached on that axis.
      const cuts = (value: string) => value === "hidden" || value === "clip";
      const scrolls = (value: string) => value === "auto" || value === "scroll";
      let freeX = false;
      let freeY = false;
      for (let cur = node.parentElement; cur && cur !== document.body; cur = cur.parentElement) {
        const s = getComputedStyle(cur);
        const box = cur.getBoundingClientRect();
        if (!freeX && cuts(s.overflowX)) {
          area = { ...area, left: Math.max(area.left, box.left), right: Math.min(area.right, box.right) };
        }
        if (!freeY && cuts(s.overflowY)) {
          area = { ...area, top: Math.max(area.top, box.top), bottom: Math.min(area.bottom, box.bottom) };
        }
        if (scrolls(s.overflowX)) freeX = true;
        if (scrolls(s.overflowY)) freeY = true;
        if (freeX && freeY) break;
      }
      return { width: area.right - area.left, height: area.bottom - area.top };
    };
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      if (el.closest("[aria-hidden='true'], [inert], [hidden]")) continue;
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || style.display === "none") continue;
      // Visually hidden: a skip link, or the real input behind a styled switch.
      if (style.clip === "rect(0px, 0px, 0px, 0px)" || style.clipPath === "inset(50%)") continue;
      const own = el.getBoundingClientRect();
      if (own.width < 1 || own.height < 1) continue;
      // What a finger can press: the control, the label it sits in, and a
      // `touch-target` wrapper that passes presses on to it — each with its
      // invisible hit area, if it has one.
      const presses = [el, el.closest("label"), el.parentElement?.closest(".touch-target")];
      let width = 0;
      let height = 0;
      for (const node of presses) {
        if (!node || (node !== el && !node.contains(el))) continue;
        const area = hitArea(node);
        width = Math.max(width, area.width);
        height = Math.max(height, area.height);
      }
      if (width >= minimum - 0.5 && height >= minimum - 0.5) continue;
      if (style.display === "inline") {
        const words = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        const sentence = (el.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim();
        if (sentence.length > words.length + 1) continue;
      }
      const name = (
        el.getAttribute("aria-label") ??
        el.getAttribute("title") ??
        (el.textContent ?? "").replace(/\s+/g, " ").trim()
      ).slice(0, 30);
      const cls =
        typeof el.className === "string"
          ? el.className
              .split(/\s+/)
              .filter((token) => /^(h|w|size|p|px|py|min-h|min-w)-/.test(token))
              .slice(0, 5)
              .join(".")
          : "";
      out.push(
        `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""} "${name}" ${Math.round(width)}×${Math.round(height)}`,
      );
    }
    return out;
  }, 32);
  const unique = [...new Set(small)];
  if (unique.length) {
    problem(`${label}: ${unique.length} touch targets under 32×32px`);
    for (const line of unique.slice(0, reportOnly ? 60 : 12)) console.error(`      ${line}`);
  }

  // A hit area works by being pressed: the control's own content stays on top
  // of it (a press on the box, the switch, the text reaches that element), and
  // a press beside the control, inside the area, reaches the control.
  const misses = await page.evaluate(() => {
    const describe = (el: Element | null) => {
      if (!el) return "nothing";
      const name = (el.getAttribute("aria-label") ?? (el.textContent ?? "").replace(/\s+/g, " ").trim()).slice(0, 30);
      return `${el.tagName.toLowerCase()} "${name}"`;
    };
    const pressable =
      "a[href], button, input, select, textarea, label, summary, [role='button'], [role='switch'], [role='checkbox'], [role='tab'], [role='menuitem'], [role='option']";
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(".touch-target"))) {
      if (el.closest("[aria-hidden='true'], [inert], [hidden]")) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || style.display === "none") continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) continue;
      if (box.top < 0 || box.left < 0 || box.bottom > innerHeight || box.right > innerWidth) continue;
      const cx = box.left + box.width / 2;
      // The control, and anything pressable inside it (the box in a
      // checkbox's target, the switch in a label), is pressed at its middle.
      const covered = [el, ...Array.from(el.querySelectorAll<HTMLElement>(pressable))].find((part) => {
        const r = part.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !hit || (hit !== part && !part.contains(hit));
      });
      if (covered) {
        const r = covered.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out.push(`${describe(covered)}: its middle reaches ${describe(hit)}`);
        continue;
      }
      const reach = (Number.parseFloat(getComputedStyle(el, "::after").minHeight) || 0) - box.height;
      if (reach < 4) continue;
      const points = [box.top - reach / 4, box.bottom + reach / 4].filter((y) => y > 0 && y < innerHeight);
      const hits = points.map((y) => document.elementFromPoint(cx, y));
      if (hits.length === 0 || hits.some((hit) => hit === el || (hit && el.contains(hit)))) continue;
      // Another control overlapping there is a shared edge, not a dead area.
      if (hits.some((hit) => hit?.closest(pressable) && !hit.closest(pressable)!.contains(el))) continue;
      out.push(`${describe(el)}: a press just beside it reaches ${describe(hits[0])}`);
    }
    return out;
  });
  if (misses.length) {
    problem(`${label}: ${misses.length} hit areas do not take presses as they should`);
    for (const line of misses.slice(0, reportOnly ? 60 : 12)) console.error(`      ${line}`);
  }
}

type FocusLook = {
  outlineStyle: string;
  outlineWidth: string;
  outlineColor: string;
  boxShadow: string;
  borderColor: string;
};

/**
 * Tab through the first stops and require a focus indicator on each: an
 * outline, ring or border that the control does not have at rest — on the
 * control itself, or on the container that marks focus for it
 * (`focus-within`, a composer's frame) — painted at 3:1 or better against the
 * surface around it.
 */
async function checkFocus(page: Page, label: string) {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
    (window as unknown as { __visualFocus: unknown[] }).__visualFocus = [];
  });
  const stops = 14;
  for (let index = 0; index < stops; index += 1) {
    await page.keyboard.press("Tab");
    await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return;
      const look = (node: Element) => {
        const s = getComputedStyle(node);
        return {
          outlineStyle: s.outlineStyle,
          outlineWidth: s.outlineWidth,
          outlineColor: s.outlineColor,
          boxShadow: s.boxShadow,
          borderColor: s.borderColor,
        };
      };
      // The control and the two containers nearest to it.
      const levels: Array<{ node: Element; focused: ReturnType<typeof look> }> = [];
      for (let node: Element | null = el, depth = 0; node && depth < 3; depth += 1) {
        levels.push({ node, focused: look(node) });
        node = node.parentElement;
      }
      (window as unknown as { __visualFocus: unknown[] }).__visualFocus.push({ el, levels });
    });
  }
  // Leave the controls, then compare each with its resting look.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape").catch(() => undefined);
  const results = await page.evaluate(() => {
    const surface = (el: Element | null): string[] => {
      const layers: string[] = [];
      for (let cur = el; cur; cur = cur.parentElement) {
        const bg = getComputedStyle(cur).backgroundColor;
        if (bg && bg !== "rgba(0, 0, 0, 0)") {
          layers.push(bg);
          if (!/rgba|\//.test(bg)) break;
        }
      }
      return layers;
    };
    type Entry = {
      el: Element;
      levels: Array<{ node: Element; focused: FocusLook }>;
    };
    const entries = (window as unknown as { __visualFocus: Entry[] }).__visualFocus;
    return entries
      .filter((entry) => entry.el.isConnected)
      .map((entry) => {
        const el = entry.el;
        const name =
          el.getAttribute("aria-label") ??
          (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40) ??
          "";
        return {
          name: `${el.tagName.toLowerCase()} "${name}"`,
          levels: entry.levels
            .filter((level) => level.node.isConnected)
            .map((level) => {
              const s = getComputedStyle(level.node);
              return {
                focused: level.focused,
                rest: {
                  outlineStyle: s.outlineStyle,
                  outlineWidth: s.outlineWidth,
                  outlineColor: s.outlineColor,
                  boxShadow: s.boxShadow,
                  borderColor: s.borderColor,
                },
                surface: surface(level.node.parentElement),
              };
            }),
        };
      });
  });
  for (const result of results) {
    let best = 0;
    let found = false;
    for (const level of result.levels) {
      const surface = flatten(
        level.surface.map(parseColor).filter((layer): layer is Rgba => Boolean(layer)),
      );
      const outline =
        level.focused.outlineStyle !== "none" &&
        Number.parseFloat(level.focused.outlineWidth) >= 1 &&
        (level.focused.outlineStyle !== level.rest.outlineStyle ||
          level.focused.outlineColor !== level.rest.outlineColor);
      const ring = level.focused.boxShadow !== "none" && level.focused.boxShadow !== level.rest.boxShadow;
      const border = level.focused.borderColor !== level.rest.borderColor;
      if (!outline && !ring && !border) continue;
      found = true;
      // Strongest indicator colour against the surface around it.
      const candidates: string[] = [];
      if (outline) candidates.push(level.focused.outlineColor);
      if (ring) {
        for (const match of level.focused.boxShadow.matchAll(/rgba?\([^)]*\)/g)) candidates.push(match[0]);
      }
      if (border) candidates.push(level.focused.borderColor.split(" rgb")[0]);
      for (const color of candidates) {
        const parsed = parseColor(color);
        if (parsed) best = Math.max(best, contrastRatio(parsed, surface));
      }
    }
    if (!found) {
      problem(`${label}: no visible focus indicator on ${result.name}`);
    } else if (best + 1e-6 < 3) {
      problem(`${label}: focus indicator on ${result.name} is only ${formatRatio(best)} against its surface`);
    }
  }
}
