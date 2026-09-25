/**
 * Focused browser regressions for email analysis in the employee work timeline.
 * Uses production React components with deterministic, read-only API fixtures.
 * Authorization, bounded result snapshots and redaction have server test coverage.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright-core";
import type { WorkEntry, WorkEntryAnalysis, WorkTimeline } from "../client/lib/api";
import { startBrowserFixture } from "./browserFixture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixtureNow = new Date("2026-09-25T12:00:00.000Z");
const purpose =
  "Read the incoming email, classify it, summarize it, and suggest next steps. " +
  "This analysis does not send email or carry out the suggestions.";
const subject = "Delivery dates for the autumn order";
const summary =
  "Jane asks when the autumn order will arrive and whether delivery can move to Friday.";
const suggestions = [
  "Check the expected delivery date",
  "Prepare a reply with the available options",
];
const failure = "The AI Model did not return a valid analysis. Try analyzing the email again.";
const destination = "/c/analysis/mail/t/thread-1?account=mailbox-1";

function analysisEntry(
  status: WorkEntryAnalysis["status"] = "completed",
  analysis: Partial<WorkEntryAnalysis> = {},
  changes: Partial<WorkEntry> = {},
): WorkEntry {
  return {
    id: `effect:analysis-${status}`,
    kind: "effect",
    at: "2026-09-25T09:05:00.000Z",
    endedAt: null,
    active: false,
    employee: { id: "jamie", name: "Jamie Mallers", slug: "jamie", avatarKey: null },
    title: subject,
    subject,
    detail: `mail.analysis.${status}`,
    source: {
      kind: "mail_thread",
      id: "thread-1",
      accountId: "mailbox-1",
      label: "Email from Jane <jane@example.test>",
      detail: "support@company.test · Incoming email analysis",
    },
    effects: [],
    effectCount: 0,
    run: null,
    analysis: {
      kind: "email",
      status,
      purpose,
      category: status === "completed" ? "customer_support" : null,
      summary: status === "completed" ? summary : null,
      suggestedActions: status === "completed" ? suggestions : [],
      error: status === "failed" ? failure : null,
      resultAvailable: status !== "started",
      durationMs: status !== "started" ? 65_000 : null,
      ...analysis,
    },
    ...changes,
  };
}

function timeline(entries: WorkEntry[], query: URLSearchParams): WorkTimeline {
  const employeeId = query.get("employeeId");
  const since = query.get("since") ?? "2026-09-24T12:00:00.000Z";
  const until = query.get("until") ?? fixtureNow.toISOString();
  const matching = entries
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
    entries: matching,
    entryCount: matching.length,
    employeeSummaries: [
      {
        employeeId: "jamie",
        entryCount: matching.length,
        latest: matching[0] ?? null,
        current: null,
        waiting: null,
      },
    ],
  };
}

const cases: {
  name: string;
  entries: WorkEntry[];
  width?: number;
  dark?: boolean;
  run: (page: Page, day: Locator) => Promise<void>;
}[] = [];
function add(
  name: string,
  run: (page: Page, day: Locator) => Promise<void>,
  options: { entries?: WorkEntry[]; width?: number; dark?: boolean } = {},
) {
  cases.push({ name, run, entries: options.entries ?? [analysisEntry()], ...options });
}

async function assertReadOnlyAnalysis(day: Locator) {
  assert.equal(await day.getByRole("button", { name: "Open the run log", exact: true }).count(), 0);
  assert.equal(await day.getByText("What changed", { exact: true }).count(), 0);
  assert.doesNotMatch(
    await day.innerText(),
    /mail\.analysis\.|happening now|finished without errors/,
  );
}

async function fitsViewport(page: Page, day: Locator) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    "The page must not scroll sideways",
  );
  assert.equal(
    await day.evaluate((dialog) => {
      const box = dialog.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && dialog.scrollWidth <= dialog.clientWidth;
    }),
    true,
    "The employee day must fit the viewport",
  );
  const overflowing = await day
    .locator("p,li,dd,a")
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => ({ tag: element.tagName, text: element.textContent?.slice(0, 120) })),
    );
  assert.deepEqual(overflowing, [], "Long content must wrap inside each card");
}

add(
  "completed analysis explains its purpose, source, category, summary, and suggested next steps",
  async (page, day) => {
    await day.getByText(/Jamie Mallers completed email analysis for/).waitFor();
    assert.equal(await day.getByText("Email analysis", { exact: true }).count(), 1);
    assert.equal(await day.getByText("Change", { exact: true }).count(), 0);
    assert.match(await day.innerText(), /Delivery dates for the autumn order/);
    await day.getByText(purpose, { exact: true }).waitFor();
    await day.getByText("AI summary", { exact: true }).waitFor();
    await day.getByText(summary, { exact: true }).waitFor();
    await day.getByText("Category", { exact: true }).waitFor();
    await day.getByText("Support", { exact: true }).waitFor();
    await day.getByText("Suggested next steps", { exact: true }).waitFor();
    for (const suggestion of suggestions)
      await day.getByText(suggestion, { exact: true }).waitFor();
    assert.match(await day.innerText(), /Jane <jane@example\.test>/);
    assert.match(await day.innerText(), /support@company\.test/);
    const link = day.getByRole("link", { name: "Open the email thread", exact: true });
    assert.equal(await link.getAttribute("href"), destination);
    await assertReadOnlyAnalysis(day);
    await page.screenshot({
      path: path.join(output, "work-analysis-completed-desktop.png"),
      fullPage: true,
    });
  },
);

add(
  "started analysis describes the review without inventing a result or claiming old work is active",
  async (page, day) => {
    await day.getByText(/Jamie Mallers started email analysis for/).waitFor();
    await day.getByText(purpose, { exact: true }).waitFor();
    assert.equal(await day.getByText("AI summary", { exact: true }).count(), 0);
    assert.equal(await day.getByText("Category", { exact: true }).count(), 0);
    assert.equal(await day.getByText("Suggested next steps", { exact: true }).count(), 0);
    assert.doesNotMatch(
      await day.innerText(),
      /Result details are unavailable|No next steps were suggested/,
    );
    await assertReadOnlyAnalysis(day);
    await page.screenshot({
      path: path.join(output, "work-analysis-started-desktop.png"),
      fullPage: true,
    });
  },
  { entries: [analysisEntry("started")] },
);

add(
  "failed analysis names the affected email and reports its failure without implying success",
  async (page, day) => {
    await day.getByText(/Jamie Mallers could not complete email analysis for/).waitFor();
    await day.getByText("Why it failed", { exact: true }).waitFor();
    await day.getByText(failure, { exact: true }).waitFor();
    await day.getByText(purpose, { exact: true }).waitFor();
    assert.equal(await day.getByText("AI summary", { exact: true }).count(), 0);
    assert.equal(await day.getByText("Suggested next steps", { exact: true }).count(), 0);
    assert.doesNotMatch(
      await day.innerText(),
      /completed email analysis|No next steps were suggested/,
    );
    await assertReadOnlyAnalysis(day);
    await page.screenshot({
      path: path.join(output, "work-analysis-failed-desktop.png"),
      fullPage: true,
    });
  },
  { entries: [analysisEntry("failed")] },
);

add(
  "completed analysis explicitly distinguishes an empty suggestion list from missing historical results",
  async (_page, day) => {
    await day.getByText("No next steps were suggested.", { exact: true }).waitFor();
    assert.equal(await day.getByText(summary, { exact: true }).count(), 1);
    assert.doesNotMatch(await day.innerText(), /Result details are unavailable/);
  },
  { entries: [analysisEntry("completed", { suggestedActions: [] })] },
);

for (const status of ["completed", "failed"] as const) {
  add(
    `legacy ${status} entry explains missing details without borrowing a newer result`,
    async (_page, day) => {
      await day
        .getByText(
          status === "completed"
            ? "Result details are unavailable for this analysis."
            : "The failure reason is unavailable for this analysis.",
          { exact: true },
        )
        .waitFor();
      await day.getByText(purpose, { exact: true }).waitFor();
      assert.equal(await day.getByText(summary, { exact: true }).count(), 0);
      assert.equal(await day.getByText(failure, { exact: true }).count(), 0);
      assert.equal(
        await day.getByText("No next steps were suggested.", { exact: true }).count(),
        0,
      );
    },
    {
      entries: [
        analysisEntry(status, {
          resultAvailable: false,
          category: null,
          summary: null,
          suggestedActions: [],
          error: null,
          durationMs: null,
        }),
      ],
    },
  );
}

add(
  "older API responses retain an explanatory analysis card when the optional detail field is absent",
  async (_page, day) => {
    await day.getByText(/Jamie Mallers completed email analysis for/).waitFor();
    await day.getByText("Email analysis", { exact: true }).waitFor();
    assert.match(await day.innerText(), /classif|summari|suggest/i);
    assert.equal(await day.getByText(summary, { exact: true }).count(), 0);
    assert.equal(
      await day.getByRole("link", { name: "Open the email thread", exact: true }).count(),
      1,
    );
  },
  { entries: [analysisEntry("completed", {}, { analysis: undefined })] },
);

add(
  "an inaccessible email exposes no source link or private analysis details",
  async (_page, day) => {
    await day.getByText("Email analysis", { exact: true }).waitFor();
    assert.match(await day.innerText(), /completed email analysis/);
    assert.equal(
      await day.getByRole("link", { name: "Open the email thread", exact: true }).count(),
      0,
    );
    assert.doesNotMatch(
      await day.innerText(),
      /Jane|support@|Delivery dates|autumn order|Customer enquiry/,
    );
    assert.equal(await day.getByText("AI summary", { exact: true }).count(), 0);
  },
  {
    entries: [
      analysisEntry(
        "completed",
        {},
        { title: "Email analysis", subject: "", source: null, analysis: null },
      ),
    ],
  },
);

add(
  "each historical attempt keeps its own result, status, and source in chronological order",
  async (_page, day) => {
    const first = day.locator("li").filter({ hasText: "The first message asks about a quote." });
    const second = day.locator("li").filter({ hasText: "The second message confirms the order." });
    assert.equal(await first.count(), 1);
    assert.equal(await second.count(), 1);
    assert.match(await first.innerText(), /Quote request/);
    assert.doesNotMatch(await first.innerText(), /confirms the order|Order confirmation/);
    assert.match(await second.innerText(), /Order confirmation/);
    assert.doesNotMatch(await second.innerText(), /asks about a quote|Quote request/);
    assert.equal(await first.getByRole("link").getAttribute("href"), destination);
    assert.equal(
      await second.getByRole("link").getAttribute("href"),
      "/c/analysis/mail/t/thread-2?account=mailbox-2",
    );
    const summaries = await day.getByText(/^The (?:first|second) message /).allTextContents();
    assert.deepEqual(summaries, [
      "The first message asks about a quote.",
      "The second message confirms the order.",
    ]);
  },
  {
    entries: [
      analysisEntry(
        "completed",
        { summary: "The second message confirms the order.", category: "Order confirmation" },
        {
          id: "effect:second",
          at: "2026-09-25T09:08:00.000Z",
          source: {
            kind: "mail_thread",
            id: "thread-2",
            accountId: "mailbox-2",
            label: "Email from Sue",
            detail: "sales@company.test",
          },
        },
      ),
      analysisEntry(
        "completed",
        { summary: "The first message asks about a quote.", category: "Quote request" },
        { id: "effect:first" },
      ),
    ],
  },
);

for (const method of ["mouse", "keyboard"] as const) {
  add(
    `the ${method} source link opens the exact email and closes the employee day`,
    async (page, day) => {
      const link = day.getByRole("link", { name: "Open the email thread", exact: true });
      if (method === "mouse") await link.click();
      else {
        await link.focus();
        await page.keyboard.press("Enter");
      }
      await page.getByLabel("Opened destination", { exact: true }).waitFor();
      assert.equal(
        await page.getByLabel("Opened destination", { exact: true }).innerText(),
        destination,
      );
      assert.equal(await page.getByRole("dialog").count(), 0);
    },
  );
}

add(
  "email and AI-generated markup remain literal text without creating executable content",
  async (page, day) => {
    await day
      .getByText('<img src=x onerror="window.analysisInjected=true">', { exact: true })
      .waitFor();
    await day.getByText("<script>window.analysisInjected=true</script>", { exact: true }).waitFor();
    assert.equal(await day.locator("script,img").count(), 0);
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { analysisInjected?: boolean }).analysisInjected,
      ),
      undefined,
    );
    assert.equal(
      await day.getByRole("link").count(),
      3,
      "Only the email source and normal employee footer links are present",
    );
  },
  {
    entries: [
      analysisEntry(
        "completed",
        {
          summary: '<img src=x onerror="window.analysisInjected=true">',
          category: "<b>Customer enquiry</b>",
          suggestedActions: [
            "<script>window.analysisInjected=true</script>",
            "[Open](javascript:alert(1))",
          ],
        },
        { subject: '<svg onload="window.analysisInjected=true">' },
      ),
    ],
  },
);

for (const [width, dark] of [
  [320, false],
  [390, true],
] as const) {
  add(
    `${width}px normal ${dark ? "dark" : "light"} analysis preserves readable details and reachable email navigation`,
    async (page, day) => {
      await day.getByText(summary, { exact: true }).waitFor();
      await fitsViewport(page, day);
      await page.screenshot({
        path: path.join(output, `work-analysis-normal-${width}-${dark ? "dark" : "light"}.png`),
        fullPage: true,
      });
      const link = day.getByRole("link", { name: "Open the email thread", exact: true });
      await link.scrollIntoViewIfNeeded();
      await fitsViewport(page, day);
      assert.equal(await link.getAttribute("href"), destination);
      await page.screenshot({
        path: path.join(output, `work-analysis-normal-${width}-results.png`),
        fullPage: true,
      });
    },
    { width, dark },
  );
}

for (const width of [320, 390]) {
  for (const dark of [false, true]) {
    add(
      `${width}px ${dark ? "dark" : "light"} cards wrap long subjects, source context, results, and suggestions`,
      async (page, day) => {
        assert.equal(await page.locator("html.dark").count(), dark ? 1 : 0);
        await day.getByText("AI summary", { exact: true }).waitFor();
        await fitsViewport(page, day);
        await day
          .getByRole("link", { name: "Open the email thread", exact: true })
          .scrollIntoViewIfNeeded();
        await fitsViewport(page, day);
        await page.screenshot({
          path: path.join(output, `work-analysis-${width}-${dark ? "dark" : "light"}.png`),
          fullPage: true,
        });
      },
      {
        width,
        dark,
        entries: [
          analysisEntry(
            "completed",
            {
              category: "InternationalCustomerCorrespondence".repeat(4),
              summary: "CustomerReferenceWithoutSpaces".repeat(16),
              suggestedActions: [
                "ReconcileCustomerReference".repeat(10),
                "Prepare a response after checking the revised delivery details with the operations team.",
              ],
            },
            {
              subject: "DeliveryConfirmationWithoutSpaces".repeat(8),
              source: {
                kind: "mail_thread",
                id: "thread-1",
                accountId: "mailbox-1",
                label: "Email from " + "InternationalCustomerName".repeat(6),
                detail:
                  "incoming-customer-correspondence".repeat(5) +
                  "@company.test · Incoming email analysis",
              },
            },
          ),
        ],
      },
    );
  }
}

add(
  "320px failed analysis wraps a long failure reason without losing its email link",
  async (page, day) => {
    await day.getByText("Why it failed", { exact: true }).waitFor();
    await fitsViewport(page, day);
    const link = day.getByRole("link", { name: "Open the email thread", exact: true });
    assert.equal(await link.getAttribute("href"), destination);
  },
  {
    width: 320,
    dark: true,
    entries: [analysisEntry("failed", { error: "UpstreamModelResponseWasNotValid".repeat(18) })],
  },
);

const filter = process.argv.slice(2).join(" ").toLowerCase();
const selected = cases.filter((item) => item.name.toLowerCase().includes(filter));
assert.ok(selected.length, `No browser cases match ${JSON.stringify(filter)}`);
const server = await startBrowserFixture("workAnalysisHarness.tsx", 18485);
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
  .catch(async (error) => {
    await server.close();
    throw error;
  });
let passed = 0;
try {
  await fs.mkdir(output, { recursive: true });
  for (const item of selected) {
    const context = await browser.newContext({
      viewport: { width: item.width ?? 1440, height: item.width ? 844 : 1100 },
      timezoneId: "Europe/London",
      colorScheme: item.dark ? "dark" : "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.clock.setFixedTime(fixtureNow);
    const errors: string[] = [];
    const unexpected: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== server.origin || request.method() !== "GET") {
        unexpected.push(`${request.method()} ${request.url()}`);
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (url.pathname === "/api/companies/company/work-timeline")
        return route.fulfill({ json: timeline(item.entries, url.searchParams) });
      if (url.pathname === "/api/companies/company/employees/jamie/work-queue")
        return route.fulfill({
          json: { employeeId: "jamie", current: null, pending: [], pendingCount: 0 },
        });
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
    });
    console.log(`RUN ${item.name}`);
    try {
      await page.goto(server.origin, { waitUntil: "commit" });
      await page.getByRole("button", { name: /Jamie Mallers, Revenue, .*Open their day/ }).click();
      const day = page.getByRole("dialog", { name: "Jamie Mallers's day", exact: true });
      await day.getByRole("button", { name: "Go to first work", exact: true }).click();
      await day
        .getByRole("region", { name: "Work queue", exact: true })
        .getByText("No Routines waiting.", { exact: true })
        .waitFor();
      await item.run(page, day);
      assert.deepEqual(errors, [], "Production components must not throw in the browser");
      assert.deepEqual(unexpected, [], "Every request must be expected, local, and read-only");
      passed++;
      console.log(`PASS ${item.name}`);
    } catch (error) {
      await page
        .screenshot({ path: path.join(output, "work-analysis-failure.png"), fullPage: true })
        .catch(() => {});
      console.error(`FAIL ${item.name}`);
      if (unexpected.length) console.error(unexpected);
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log(`${passed} employee email analysis browser cases passed.`);
} finally {
  await browser.close();
  await server.close();
}
