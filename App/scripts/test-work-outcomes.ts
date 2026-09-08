/**
 * Run with `npm run test:work-outcomes`; local Chrome or GENOSYN_TEST_BROWSER.
 * Exercises production React views in a real browser. All API reads are
 * deterministic fixtures; unexpected requests and every write fail the suite.
 * Server and wording unit tests cover persistence, authorization and extraction.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium, type Locator, type Page } from "playwright-core";
import type { WorkEntry, WorkEntryRun, WorkTimeline } from "../client/lib/api";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://127.0.0.1:18473";
const output = path.resolve(root, "../output/playwright");
const summary =
  "Found 6 relevant GitHub contacts and drafted 3 outreach emails. No emails were sent.";
const routine = "Daily GitHub Lead Capture & Outreach";
const browserErrors: string[] = [];
const unexpectedRequests: string[] = [];
const server = await createServer({
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 18473, strictPort: true, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-work-outcomes"),
  optimizeDeps: { entries: [path.join(root, "scripts/workOutcomeHarness.tsx")] },
  plugins: [
    {
      name: "work-outcome-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__work_outcomes", async (_req, res) => {
          const html = await dev.transformIndexHtml(
            "/__work_outcomes",
            '<html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' +
              '<script type="module" src="/@fs' +
              root +
              '/scripts/workOutcomeHarness.tsx"></script></html>',
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
  .launch({
    channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
    headless: true,
  })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
const context = await browser
  .newContext({ viewport: { width: 1440, height: 1000 } })
  .catch(async (error) => {
    await browser.close();
    await server.close();
    throw error;
  });
context.setDefaultTimeout(15000);

function entryFixture(
  runChanges: Partial<WorkEntryRun> = {},
  changes: Partial<WorkEntry> = {},
): WorkEntry {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: "run:outcome-run",
    kind: "run",
    at,
    endedAt: new Date(new Date(at).getTime() + 9 * 60_000).toISOString(),
    active: false,
    employee: { id: "jamie", name: "Jamie Mallers", slug: "jamie", avatarKey: null },
    title: `Ran ${routine}`,
    subject: routine,
    detail: "completed",
    // Match the reported regression: the API caps 17 ledger rows at eight,
    // all of which are Connection reads carrying raw tool names.
    effects: [
      "list_issues",
      "list_pull_requests",
      "list_issues",
      "list_pull_requests",
      "list_commits",
      "list_issues",
      "list_commits",
      "list_issues",
    ].map((tool, index) => ({
      action: "connection.use",
      targetType: "connection",
      targetId: `connection-${index}`,
      targetLabel: `GitHub · ${tool}`,
      at,
    })),
    effectCount: 17,
    run: {
      id: "outcome-run",
      routineId: "outreach",
      routineName: routine,
      status: "completed",
      exitCode: 0,
      triggerKind: "schedule",
      attempt: 1,
      outcomeVerdict: "achieved",
      outcomeNote: "Six contacts and three drafts were recorded.",
      checksVerdict: "passed",
      summary,
      ...runChanges,
    },
    ...changes,
  };
}
function timeline(entry: WorkEntry, employeeId: string | null): WorkTimeline {
  const entries = employeeId && employeeId !== entry.employee.id ? [] : [entry];
  return {
    since: new Date(Date.now() - 86400000).toISOString(),
    until: new Date().toISOString(),
    employeeId,
    entries,
    entryCount: entries.length,
    employeeSummaries: entries.map((row) => ({
      employeeId: row.employee.id,
      entryCount: 1,
      latest: row,
      current: row.active ? row : null,
      waiting: null,
    })),
  };
}
async function open(
  entry = entryFixture(),
  options: { dayError?: boolean; delayDay?: boolean } = {},
) {
  const page = await context.newPage();
  const reads: string[] = [];
  let releaseDay: () => void = () => {};
  const dayGate = new Promise<void>((resolve) => {
    releaseDay = resolve;
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin || request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    reads.push(url.pathname + url.search);
    if (url.pathname === "/api/companies/company/work-timeline") {
      const employeeId = url.searchParams.get("employeeId");
      if (employeeId && options.delayDay) await dayGate;
      if (employeeId && options.dayError)
        return route.fulfill({ status: 503, json: { error: "Work is temporarily unavailable." } });
      return route.fulfill({ json: timeline(entry, employeeId) });
    }
    if (url.pathname === `/api/companies/company/runs/${entry.run?.id}/log`)
      return route.fulfill({
        json: {
          ...entry.run,
          content: "Detailed transcript fixture: connection.use GitHub list_issues",
          startedAt: entry.at,
          finishedAt: entry.endedAt,
          live: false,
          browserRecordings: [],
        },
      });
    if (url.pathname === `/api/companies/company/routines/runs/${entry.run?.id}/effects`)
      return route.fulfill({ json: { effects: entry.effects, total: entry.effectCount } });
    if (url.pathname === `/api/companies/company/routines/runs/${entry.run?.id}/checks`)
      return route.fulfill({ json: { results: [] } });
    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });
  await page.goto(`${origin}/__work_outcomes`, { waitUntil: "commit", timeout: 60000 });
  // The cold visit compiles actual views and Tailwind; later actions stay bounded.
  await page
    .getByRole("heading", { name: "AI employee work", exact: true })
    .waitFor({ timeout: 300000 });
  await page.locator("button[title][aria-label]").filter({ hasText: "" }).last().waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading work"]'));
  return {
    page,
    reads,
    releaseDay,
  };
}
async function openPopup(page: Page) {
  // Only chart tiles use the identical title and accessible narrative.
  const tile = page.locator("button[title][aria-label]").filter({ hasText: /^$/ }).first();
  await tile.click();
  const dialog = page.getByRole("dialog", { name: "Jamie Mallers", exact: true });
  await dialog.waitFor();
  return dialog;
}
async function cleanOverview(dialog: Locator) {
  const text = await dialog.innerText();
  assert.doesNotMatch(
    text,
    /What changed|connection\.use|list_issues|list_pull_requests|list_commits|Used connection|\b8 connections\b|9 (?:more|other) changes|No changes were recorded|finished without errors/i,
  );
}
async function fitsViewport(page: Page) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "page must not scroll sideways",
  );
  assert.equal(
    await page.getByRole("dialog").evaluate((dialog) => {
      const box = dialog.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
    }),
    true,
    "dialog must fit the phone viewport",
  );
  assert.equal(
    await page
      .getByRole("dialog")
      .locator("p")
      .evaluateAll((paragraphs) =>
        paragraphs.every((paragraph) => paragraph.scrollWidth <= paragraph.clientWidth),
      ),
    true,
    "outcome and context text must wrap instead of overflowing inside the dialog",
  );
}
let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  console.log(`RUN ${name}`);
  await run();
  checks++;
  console.log(`PASS ${name}`);
}
try {
  await fs.mkdir(output, { recursive: true });
  await check(
    "chart tooltip and popup lead with the work outcome, hiding all eight tool rows",
    async () => {
      const { page } = await open();
      const tile = page.locator("button[title][aria-label]").filter({ hasText: /^$/ }).first();
      assert.match(
        (await tile.getAttribute("aria-label")) ?? "",
        /Found 6 relevant GitHub contacts/,
      );
      assert.doesNotMatch(
        (await tile.getAttribute("title")) ?? "",
        /connection|list_issues|other changes/i,
      );
      const dialog = await openPopup(page);
      await dialog.getByText(summary, { exact: true }).waitFor();
      assert.equal(await dialog.getByText(summary, { exact: true }).count(), 1);
      assert.equal(
        await dialog
          .getByText(summary, { exact: true })
          .evaluate(
            (paragraph) =>
              paragraph.getBoundingClientRect().height <=
              2 * parseFloat(getComputedStyle(paragraph).lineHeight),
          ),
        true,
        "the representative outcome should fit in two desktop lines",
      );
      await dialog.getByText("achieved", { exact: true }).waitFor();
      await dialog.getByText("checks passed", { exact: true }).waitFor();
      assert.match(await dialog.innerText(), /Daily GitHub Lead Capture & Outreach/);
      await cleanOverview(dialog);
      await page.screenshot({
        path: path.join(output, "routine-outcome-desktop.png"),
        fullPage: true,
      });
      await page.close();
    },
  );
  await check(
    "popup opens the actual Run log with its transcript and ledger only on request",
    async () => {
      const { page, reads } = await open();
      const dialog = await openPopup(page);
      assert.equal(
        reads.some((url) => url.endsWith("/log") || url.endsWith("/effects")),
        false,
      );
      await dialog.getByRole("button", { name: "Open the run log", exact: true }).click();
      const log = page.getByRole("dialog", { name: `Run: ${routine}`, exact: true });
      await log
        .getByText("Detailed transcript fixture: connection.use GitHub list_issues", {
          exact: true,
        })
        .waitFor();
      await log
        .getByRole("region", { name: "Effects", exact: true })
        .getByText("17 recorded", { exact: true })
        .waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1, "handoff must replace the popup");
      assert.equal(
        reads.some((url) => url === "/api/companies/company/runs/outcome-run/log"),
        true,
      );
      await log.getByRole("button", { name: "Close", exact: true }).last().click();
      assert.equal(await page.getByRole("dialog").count(), 0);
      await page.close();
    },
  );
  await check(
    "See the whole day stays on the same employee and preserves the concise outcome",
    async () => {
      const { page, reads } = await open();
      const dialog = await openPopup(page);
      await dialog.getByRole("button", { name: "See the whole day", exact: true }).click();
      const day = page.getByRole("dialog", { name: "Jamie Mallers's day", exact: true });
      await day.getByText(summary, { exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      assert.equal(
        reads.some((url) => url.includes("employeeId=jamie&limit=200")),
        true,
      );
      assert.equal(
        reads.some((url) => url.includes("employeeId=alex")),
        false,
      );
      await cleanOverview(day);
      await day.getByRole("button", { name: "Open the run log", exact: true }).click();
      await page.getByRole("dialog", { name: `Run: ${routine}`, exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      await page.close();
    },
  );
  await check(
    "employee circle opens their day directly and Escape returns to the chart",
    async () => {
      const { page } = await open();
      await page.getByRole("button", { name: /Jamie Mallers, Revenue, .*Open their day/ }).click();
      await page.getByRole("dialog").getByText(summary, { exact: true }).waitFor();
      await cleanOverview(page.getByRole("dialog"));
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("dialog").count(), 0);
      await page.getByRole("button", { name: /Alex Rivera, Operations, .*Open their day/ }).click();
      await page.getByRole("dialog", { name: "Alex Rivera's day", exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").getByText(summary, { exact: true }).count(), 0);
      await page.close();
    },
  );
  for (const [name, changes, expected] of [
    ["legacy missing summary", { summary: null }, "No outcome summary is available for this run."],
    ["empty summary", { summary: "" }, "No outcome summary is available for this run."],
    ["whitespace summary", { summary: " \n\t " }, "No outcome summary is available for this run."],
    [
      "failed run",
      { status: "failed", exitCode: 1 },
      "This run failed. Open the run log for details.",
    ],
    ["timeout", { status: "timeout" }, "This run ran out of time before it finished."],
    [
      "skipped",
      { status: "skipped" },
      "This routine did not run because no AI Model was assigned.",
    ],
    ["interrupted", { status: "interrupted" }, "This run was interrupted before it finished."],
  ] as Array<[string, Partial<WorkEntryRun>, string]>) {
    await check(
      `${name} gives an honest short fallback without tool counts or stale success`,
      async () => {
        const { page } = await open(entryFixture(changes));
        const dialog = await openPopup(page);
        await dialog.getByText(expected, { exact: true }).waitFor();
        assert.equal(await dialog.getByText(summary, { exact: true }).count(), 0);
        await cleanOverview(dialog);
        await page.close();
      },
    );
  }
  for (const [name, changes, expected, chip] of [
    [
      "off goal",
      { outcomeVerdict: "off_goal" },
      "The result did not meet the routine's acceptance criteria.",
      "off goal",
    ],
    [
      "unclear",
      { outcomeVerdict: "unclear" },
      "A grader could not confirm whether the goal was met.",
      "unclear",
    ],
    [
      "unverified",
      { outcomeVerdict: "unverified" },
      "The outcome has not been verified.",
      "unverified",
    ],
    ["failed Check", { checksVerdict: "failed" }, "A required Check failed.", "checks failed"],
    [
      "off goal and failed Check",
      { outcomeVerdict: "off_goal", checksVerdict: "failed" },
      "The result did not meet the routine's acceptance criteria; a required Check failed.",
      "checks failed",
    ],
  ] as Array<[string, Partial<WorkEntryRun>, string, string | null]>) {
    await check(`${name} remains visible beside the employee's claimed outcome`, async () => {
      const { page } = await open(entryFixture(changes));
      const dialog = await openPopup(page);
      await dialog.getByText(summary, { exact: true }).waitFor();
      await dialog.getByText(expected, { exact: true }).waitFor();
      if (chip) await dialog.getByText(chip, { exact: true }).waitFor();
      await cleanOverview(dialog);
      await page.close();
    });
  }
  await check("a routine without grading criteria does not invent a verdict", async () => {
    const { page } = await open(
      entryFixture({ outcomeVerdict: null, outcomeNote: null, checksVerdict: "not_run" }),
    );
    const dialog = await openPopup(page);
    await dialog.getByText(summary, { exact: true }).waitFor();
    assert.equal(await dialog.getByText("unverified", { exact: true }).count(), 0);
    assert.equal(
      await dialog.getByText("The outcome has not been verified.", { exact: true }).count(),
      0,
    );
    assert.equal(await dialog.getByText("checks passed", { exact: true }).count(), 0);
    await cleanOverview(dialog);
    await page.close();
  });
  await check("live source state suppresses stale outcome summaries", async () => {
    for (const status of ["running", "completed"] as const) {
      const { page } = await open(entryFixture({ status }, { active: true, endedAt: null }));
      const dialog = await openPopup(page);
      await dialog
        .getByText("This routine is still running. Its outcome will appear when it finishes.", {
          exact: true,
        })
        .waitFor();
      assert.equal(await dialog.getByText(summary, { exact: true }).count(), 0);
      await dialog.getByText("happening now", { exact: true }).waitFor();
      await dialog.getByText(status, { exact: true }).waitFor();
      await cleanOverview(dialog);
      await page.close();
    }
  });
  await check(
    "desktop and narrow mobile outcomes remain readable in popup and employee day",
    async () => {
      const { page } = await open();
      await page.setViewportSize({ width: 390, height: 844 });
      const dialog = await openPopup(page);
      await dialog.getByText(summary, { exact: true }).waitFor();
      await fitsViewport(page);
      await page.screenshot({
        path: path.join(output, "routine-outcome-mobile.png"),
        fullPage: true,
      });
      await dialog.getByRole("button", { name: "See the whole day", exact: true }).click();
      const day = page.getByRole("dialog", { name: "Jamie Mallers's day", exact: true });
      await day.getByText(summary, { exact: true }).waitFor();
      await fitsViewport(page);
      await cleanOverview(day);
      await page.screenshot({
        path: path.join(output, "routine-outcome-day-mobile.png"),
        fullPage: true,
      });
      await page.close();
    },
  );
  await check(
    "an employee day read failure is surfaced rather than shown as no outcome",
    async () => {
      const { page } = await open(entryFixture(), { dayError: true });
      const dialog = await openPopup(page);
      await dialog.getByRole("button", { name: "See the whole day", exact: true }).click();
      const day = page.getByRole("dialog", { name: "Jamie Mallers's day", exact: true });
      await day.getByText("Work is temporarily unavailable.", { exact: true }).waitFor();
      assert.equal(
        await day
          .getByText("No outcome summary is available for this run.", { exact: true })
          .count(),
        0,
      );
      assert.equal(await day.getByText(summary, { exact: true }).count(), 0);
      await page.close();
    },
  );
  await check(
    "long outcome references and Routine names wrap on the smallest phone width",
    async () => {
      const reference = `Saved the draft report as report-${"x".repeat(160)}.`;
      const { page } = await open(
        entryFixture({ summary: reference }, { subject: "Routine".repeat(30) }),
      );
      await page.setViewportSize({ width: 320, height: 740 });
      const dialog = await openPopup(page);
      await dialog.getByText(reference, { exact: true }).waitFor();
      await fitsViewport(page);
      await dialog.getByRole("button", { name: "See the whole day", exact: true }).click();
      await page.getByRole("dialog").getByText(reference, { exact: true }).waitFor();
      await fitsViewport(page);
      await page.close();
    },
  );
  await check("dark theme keeps the outcome and actions visible", async () => {
    const { page } = await open();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    const dialog = await openPopup(page);
    await dialog.getByText(summary, { exact: true }).waitFor();
    await cleanOverview(dialog);
    await fitsViewport(page);
    await page.screenshot({ path: path.join(output, "routine-outcome-dark.png"), fullPage: true });
    await page.close();
  });
  await check("an employee day has a loading state until its outcome read arrives", async () => {
    const { page, releaseDay } = await open(entryFixture(), { delayDay: true });
    const dialog = await openPopup(page);
    await dialog.getByRole("button", { name: "See the whole day", exact: true }).click();
    const day = page.getByRole("dialog", { name: "Jamie Mallers's day", exact: true });
    await day.getByLabel("Loading work", { exact: true }).waitFor();
    assert.equal(await day.getByText(summary, { exact: true }).count(), 0);
    releaseDay();
    await day.getByText(summary, { exact: true }).waitFor();
    await page.close();
  });
  assert.deepEqual(browserErrors, [], "no browser runtime errors");
  assert.deepEqual(unexpectedRequests, [], "only expected read-only local requests");
  console.log(`${checks} browser regression groups passed.`);
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
