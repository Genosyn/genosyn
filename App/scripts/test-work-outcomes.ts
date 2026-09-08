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
// Keep every browser and API fixture on the same local calendar day, including
// when CI starts near midnight. Timers still run normally; only Date is fixed.
const fixtureNow = new Date("2026-09-08T12:00:00.000Z");
const today = "2026-09-08";
const yesterday = "2026-09-07";
const earliestDay = "2026-09-02";
const todaySince = "2026-09-07T23:00:00.000Z";
const todayUntil = "2026-09-08T23:00:00.000Z";
const yesterdaySince = "2026-09-06T23:00:00.000Z";
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
  .newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: "Europe/London" })
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
  const at = new Date(fixtureNow.getTime() - 3_600_000).toISOString();
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
function timeline(allEntries: WorkEntry[], query: URLSearchParams): WorkTimeline {
  const employeeId = query.get("employeeId");
  const since = query.get("since") ?? new Date(fixtureNow.getTime() - 86400000).toISOString();
  const until = query.get("until") ?? fixtureNow.toISOString();
  const entries = allEntries
    .filter(
      (entry) =>
        (!employeeId || employeeId === entry.employee.id) &&
        Date.parse(entry.at) >= Date.parse(since) &&
        Date.parse(entry.at) < Date.parse(until),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    since,
    until,
    employeeId,
    entries: entries.slice(0, Number(query.get("limit") ?? 200)),
    entryCount: entries.length,
    employeeSummaries: [...new Set(entries.map((row) => row.employee.id))].map((id) => {
      const own = entries.filter((entry) => entry.employee.id === id);
      return {
        employeeId: id,
        entryCount: own.length,
        latest: own[0],
        current: own.find((entry) => entry.active) ?? null,
        waiting: null,
      };
    }),
  };
}
async function open(
  fixture: WorkEntry | WorkEntry[] = entryFixture(),
  options: { dayError?: boolean; delayDay?: boolean; delaySince?: string } = {},
) {
  const page = await context.newPage();
  await page.clock.setFixedTime(fixtureNow);
  const entries = Array.isArray(fixture) ? fixture : [fixture];
  const reads: string[] = [];
  let dayError = options.dayError ?? false;
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
      if (employeeId && (options.delayDay || url.searchParams.get("since") === options.delaySince))
        await dayGate;
      if (employeeId && dayError)
        return route.fulfill({ status: 503, json: { error: "Work is temporarily unavailable." } });
      return route.fulfill({ json: timeline(entries, url.searchParams) });
    }
    const entry = entries.find((row) => row.run && url.pathname.includes(`/${row.run.id}/`));
    if (!entry) {
      unexpectedRequests.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
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
    .getByRole("group", { name: "Open an AI employee's day", exact: true })
    .waitFor({ timeout: 300000 });
  await page.waitForFunction(() => !document.querySelector('button[aria-label*="Loading work"]'));
  return {
    page,
    reads,
    releaseDay,
    recoverDay: () => {
      dayError = false;
    },
  };
}
async function openDay(page: Page) {
  await page.getByRole("button", { name: /Jamie Mallers, Revenue, .*Open their day/ }).click();
  const dialog = page.getByRole("dialog", { name: "Jamie Mallers's day", exact: true });
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
    "Home shows only right-side employee bubbles; opening a day reveals the concise outcome",
    async () => {
      const { page, reads } = await open();
      const rail = page.getByRole("complementary", { name: "AI employee work", exact: true });
      assert.equal(await rail.getByRole("button").count(), 2);
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.equal(await page.getByText(summary, { exact: true }).count(), 0);
      assert.equal(
        reads.some((url) => url.includes("employeeId=")),
        false,
      );
      const overviewBox = await page.getByRole("region", { name: "Home overview" }).boundingBox();
      const railBox = await rail.boundingBox();
      assert.ok(overviewBox && railBox);
      assert.ok(
        railBox.x >= overviewBox.x + overviewBox.width,
        "bubbles belong right of Home content",
      );
      const bubble = rail.getByRole("button", { name: /Jamie Mallers/ });
      assert.doesNotMatch(
        (await bubble.getAttribute("title")) ?? "",
        /Found 6|connection|list_issues|other changes/i,
      );
      await page.screenshot({
        path: path.join(output, "employee-bubbles-desktop.png"),
        fullPage: true,
      });
      const dialog = await openDay(page);
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
    "the employee day opens the actual Run log with its transcript and ledger only on request",
    async () => {
      const { page, reads } = await open();
      const dialog = await openDay(page);
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
      assert.equal(
        await page.getByRole("dialog").count(),
        1,
        "handoff must replace the employee day",
      );
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
    "opening a bubble fetches only that employee's calendar day and keeps the outcome visible",
    async () => {
      const { page, reads } = await open();
      const day = await openDay(page);
      await day.getByText(summary, { exact: true }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      const dayQueries = reads
        .map((url) => new URL(url, origin).searchParams)
        .filter((query) => query.has("employeeId"));
      assert.ok(dayQueries.length > 0);
      assert.equal(
        dayQueries.every(
          (query) =>
            query.get("employeeId") === "jamie" &&
            query.get("limit") === "200" &&
            query.get("since") === todaySince &&
            query.get("until") === todayUntil,
        ),
        true,
      );
      assert.equal(
        reads.some((url) => url.includes("employeeId=alex")),
        false,
      );
      assert.equal(await day.getByLabel("Work day", { exact: true }).inputValue(), today);
      assert.equal(
        await day
          .getByLabel("Jamie Mallers's hourly work timeline", { exact: true })
          .locator(":scope > section")
          .count(),
        24,
      );
      await cleanOverview(day);
      await page.close();
    },
  );
  await check(
    "Escape closes the employee day and restores focus before another employee is opened",
    async () => {
      const { page } = await open();
      await page.getByRole("button", { name: /Jamie Mallers, Revenue, .*Open their day/ }).click();
      await page.getByRole("dialog").getByText(summary, { exact: true }).waitFor();
      await cleanOverview(page.getByRole("dialog"));
      await page.keyboard.press("Escape");
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.equal(
        await page
          .getByRole("button", { name: /Jamie Mallers, Revenue/ })
          .evaluate((button) => button === document.activeElement),
        true,
      );
      await page.getByRole("button", { name: /Alex Rivera, Operations, .*Open their day/ }).click();
      await page.getByRole("dialog", { name: "Alex Rivera's day", exact: true }).waitFor();
      await page
        .getByRole("dialog")
        .getByText("No work recorded on this day", { exact: true })
        .waitFor();
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
        const dialog = await openDay(page);
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
      const dialog = await openDay(page);
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
    const dialog = await openDay(page);
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
      const dialog = await openDay(page);
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
  await check("narrow mobile bubbles and their employee day fit the viewport", async () => {
    const { page } = await open();
    await page.setViewportSize({ width: 390, height: 844 });
    const rail = page.getByRole("complementary", { name: "AI employee work", exact: true });
    const jamieBox = await rail.getByRole("button", { name: /Jamie Mallers/ }).boundingBox();
    const alexBox = await rail.getByRole("button", { name: /Alex Rivera/ }).boundingBox();
    assert.ok(jamieBox && alexBox);
    assert.equal(jamieBox.y, alexBox.y, "mobile bubbles form a compact horizontal row");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    const dialog = await openDay(page);
    await dialog.getByText(summary, { exact: true }).waitFor();
    await fitsViewport(page);
    await cleanOverview(dialog);
    await page.screenshot({
      path: path.join(output, "routine-outcome-day-mobile.png"),
      fullPage: true,
    });
    await page.close();
  });
  await check(
    "an employee day read failure is surfaced and Try again restores its outcomes",
    async () => {
      const { page, recoverDay } = await open(entryFixture(), { dayError: true });
      const day = await openDay(page);
      await day.getByText("Work is temporarily unavailable.", { exact: true }).waitFor();
      assert.equal(
        await day
          .getByText("No outcome summary is available for this run.", { exact: true })
          .count(),
        0,
      );
      assert.equal(await day.getByText(summary, { exact: true }).count(), 0);
      assert.equal(await day.getByText("No work recorded on this day", { exact: true }).count(), 0);
      recoverDay();
      await day.getByRole("button", { name: "Try again", exact: true }).click();
      await day.getByText(summary, { exact: true }).waitFor();
      assert.equal(
        await day.getByText("Work is temporarily unavailable.", { exact: true }).count(),
        0,
      );
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
      const dialog = await openDay(page);
      await dialog.getByText(reference, { exact: true }).waitFor();
      await fitsViewport(page);
      await page.close();
    },
  );
  await check("dark theme keeps the outcome and actions visible", async () => {
    const { page } = await open();
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    const dialog = await openDay(page);
    await dialog.getByText(summary, { exact: true }).waitFor();
    await cleanOverview(dialog);
    await fitsViewport(page);
    await page.screenshot({ path: path.join(output, "routine-outcome-dark.png"), fullPage: true });
    await page.close();
  });
  await check("an employee day has a loading state until its outcome read arrives", async () => {
    const { page, releaseDay } = await open(entryFixture(), { delayDay: true });
    const day = await openDay(page);
    await day.getByLabel("Loading work", { exact: true }).waitFor();
    assert.equal(await day.getByText(summary, { exact: true }).count(), 0);
    releaseDay();
    await day.getByText(summary, { exact: true }).waitFor();
    await page.close();
  });
  await check(
    "Previous day and Today switch calendar bounds and stay within seven local dates",
    async () => {
      const priorSummary = "Reviewed yesterday's customer replies and updated the follow-up list.";
      const prior = entryFixture(
        { id: "prior-run", summary: priorSummary },
        {
          id: "run:prior-run",
          at: "2026-09-07T10:00:00.000Z",
          endedAt: "2026-09-07T10:09:00.000Z",
        },
      );
      const { page, reads } = await open([entryFixture(), prior]);
      const day = await openDay(page);
      await day.getByText(summary, { exact: true }).waitFor();
      const date = day.getByLabel("Work day", { exact: true });
      assert.equal(await date.getAttribute("min"), earliestDay);
      assert.equal(await date.getAttribute("max"), today);
      assert.equal(
        await day.getByRole("button", { name: "Next day", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await day.getByRole("button", { name: "Today", exact: true }).isDisabled(),
        true,
      );
      await day.getByRole("button", { name: "Previous day", exact: true }).click();
      await day.getByText(priorSummary, { exact: true }).waitFor();
      assert.equal(await date.inputValue(), yesterday);
      assert.equal(await day.getByText(summary, { exact: true }).count(), 0);
      const previousQuery = reads
        .map((url) => new URL(url, origin).searchParams)
        .find(
          (query) => query.get("employeeId") === "jamie" && query.get("since") === yesterdaySince,
        );
      assert.ok(previousQuery);
      assert.equal(previousQuery.get("until"), todaySince);
      await day.getByRole("button", { name: "Today", exact: true }).click();
      await day.getByText(summary, { exact: true }).waitFor();
      assert.equal(await date.inputValue(), today);
      assert.equal(await day.getByText(priorSummary, { exact: true }).count(), 0);
      await date.fill(earliestDay);
      await day.getByText("No work recorded on this day", { exact: true }).waitFor();
      assert.equal(
        await day.getByRole("button", { name: "Previous day", exact: true }).isDisabled(),
        true,
      );
      await day.getByRole("button", { name: "Next day", exact: true }).click();
      assert.equal(await date.inputValue(), "2026-09-03");
      await day.getByRole("button", { name: "Today", exact: true }).click();
      await day.getByText(summary, { exact: true }).waitFor();
      assert.equal(await date.inputValue(), today);
      await page.close();
    },
  );
  await check(
    "overlapping work stays visible in chronological order instead of hiding behind a chart cap",
    async () => {
      const entries = Array.from({ length: 12 }, (_, index) =>
        entryFixture(
          {
            id: `overlap-${index}`,
            summary: `Completed overlapping work ${String(index + 1).padStart(2, "0")}.`,
          },
          {
            id: `run:overlap-${index}`,
            at: new Date(Date.parse("2026-09-08T10:00:00.000Z") + index * 60_000).toISOString(),
            endedAt: "2026-09-08T11:00:00.000Z",
          },
        ),
      );
      const { page } = await open(entries.reverse());
      const day = await openDay(page);
      await day.getByText("Completed overlapping work 12.", { exact: true }).waitFor();
      const shown = day.getByText(/^Completed overlapping work \d{2}\.$/);
      assert.deepEqual(
        await shown.allTextContents(),
        Array.from(
          { length: 12 },
          (_, index) => `Completed overlapping work ${String(index + 1).padStart(2, "0")}.`,
        ),
      );
      assert.equal(
        await day.getByRole("button", { name: "Open the run log", exact: true }).count(),
        12,
      );
      assert.doesNotMatch(await day.innerText(), /more overlapping|hidden work/i);
      await page.close();
    },
  );
  await check(
    "switching dates hides stale work and a slower previous-day response cannot replace Today",
    async () => {
      const { page, releaseDay } = await open(entryFixture(), { delaySince: yesterdaySince });
      const day = await openDay(page);
      await day.getByText(summary, { exact: true }).waitFor();
      await day.getByRole("button", { name: "Previous day", exact: true }).click();
      await day.getByLabel("Loading work", { exact: true }).waitFor();
      assert.equal(await day.getByText(summary, { exact: true }).count(), 0);
      await day.getByRole("button", { name: "Today", exact: true }).click();
      await day.getByText(summary, { exact: true }).waitFor();
      const previousResponse = page.waitForResponse((response) => {
        const query = new URL(response.url()).searchParams;
        return query.get("employeeId") === "jamie" && query.get("since") === yesterdaySince;
    });
    releaseDay();
    await (await previousResponse).finished();
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      assert.equal(await day.getByLabel("Work day", { exact: true }).inputValue(), today);
      await day.getByText(summary, { exact: true }).waitFor();
      assert.equal(await day.getByText("No work recorded on this day", { exact: true }).count(), 0);
      await page.close();
    },
  );
  assert.deepEqual(browserErrors, [], "no browser runtime errors");
  assert.deepEqual(unexpectedRequests, [], "only expected read-only local requests");
  console.log(`${checks} browser regression groups passed.`);
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
