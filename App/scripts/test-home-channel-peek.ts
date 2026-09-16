/**
 * Run with `npx tsx scripts/test-home-channel-peek.ts`; local Chrome or
 * GENOSYN_TEST_BROWSER. The production channel peek is mounted with
 * deterministic HTTP fixtures. Geometry assertions use the browser's real
 * layout engine, and every API request outside the fixture fails the suite.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Locator, type Page } from "playwright-core";
import { createServer } from "vite";

import type {
  Mentionable,
  WorkspaceAuthor,
  WorkspaceChannel,
  WorkspaceMessage,
} from "../client/lib/workspace";
import { browserTestVite } from "./browserTestVite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(root, "../output/playwright");
const fixtureNow = new Date("2026-09-16T10:00:00.000Z");
const shortLabel = "#release-coordination";
const longLabel = "#international-customer-success-release-coordination-and-search-visibility";
const longTopic =
  "Coordinate the September customer migration, search visibility review, release notes, support handoff, and every follow-up required before the rollout is announced.";
const browserErrors: string[] = [];
const unexpectedRequests: string[] = [];

type Scenario = "short" | "long" | "loading" | "error" | "empty" | "archived" | "long-header";
type SentBody = { content: string; attachmentIds?: string[] };

const server = await createServer({
  ...browserTestVite,
  configFile: path.join(root, "vite.config.ts"),
  server: { host: "127.0.0.1", port: 18491, strictPort: false, hmr: false },
  cacheDir: path.join(root, "node_modules/.vite-home-channel-peek"),
  plugins: [
    {
      name: "home-channel-peek-browser-fixture",
      configureServer(dev) {
        dev.middlewares.use("/__channel_peek", async (_request, response) => {
          const html = await dev.transformIndexHtml(
            "/__channel_peek",
            '<html><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' +
              `<script type="module" src="/@fs${root}/scripts/channelPeekHarness.tsx"></script></html>`,
          );
          response.setHeader("Content-Type", "text/html");
          response.end(html);
        });
      },
    },
  ],
});
await server.listen().catch(async (error) => {
  await server.close();
  throw error;
});
const origin = server.resolvedUrls!.local[0].replace(/\/$/, "");
const browser = await chromium
  .launch({ channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome", headless: true })
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
context.setDefaultTimeout(30000);

function scenarioFromChannel(channelId: string): Scenario {
  const value = channelId.split("--", 1)[0];
  assert.ok(
    ["short", "long", "loading", "error", "empty", "archived", "long-header"].includes(value),
    `unknown fixture scenario ${value}`,
  );
  return value as Scenario;
}

function labelFor(scenario: Scenario): string {
  return scenario === "long-header" ? longLabel : shortLabel;
}

function message(
  id: string,
  content: string,
  minute: number,
  author: WorkspaceAuthor = {
    kind: "user",
    id: "teammate",
    name: "Jamie Chen",
    email: "jamie@example.test",
  },
): WorkspaceMessage {
  return {
    id,
    channelId: "fixture-channel",
    authorKind: author.kind === "ai" ? "ai" : author.kind === "system" ? "system" : "user",
    author,
    content,
    parentMessageId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: new Date(Date.parse("2026-09-16T09:00:00.000Z") + minute * 60_000).toISOString(),
    attachments: [],
    reactions: [],
  };
}

function messagesFor(scenario: Scenario): WorkspaceMessage[] {
  if (scenario === "empty") return [];
  if (scenario === "long") {
    return Array.from({ length: 30 }, (_, index) =>
      message(
        `long-message-${index + 1}`,
        `Update ${index + 1}: the release checklist, customer handoff, search review, and owner notes are ready for the next review.`,
        index,
        index % 2 === 0
          ? {
              kind: "user",
              id: "teammate",
              name: "Jamie Chen",
              email: "jamie@example.test",
            }
          : {
              kind: "ai",
              id: "employee",
              name: "Riley",
              slug: "riley",
              role: "Release coordinator",
            },
      ),
    );
  }
  if (scenario === "archived") {
    return [message("archived-message", "The final archive summary is ready.", 1)];
  }
  if (scenario === "long-header") {
    return [message("header-message", "The long-header review is ready.", 1)];
  }
  return [message("short-message", "Short handoff complete.", 1)];
}

const mentionables: Mentionable[] = [
  {
    kind: "user",
    handle: "@jamie",
    label: "Jamie Chen",
    sublabel: "jamie@example.test",
    href: "/c/company/members/teammate",
  },
  {
    kind: "ai",
    handle: "@riley",
    label: "Riley",
    sublabel: "Release coordinator",
    href: "/c/company/employees/riley",
  },
];

function channelDetail(channelId: string, scenario: Scenario): WorkspaceChannel {
  return {
    id: channelId,
    companyId: "company",
    kind: "public",
    name: labelFor(scenario).slice(1),
    slug: labelFor(scenario).slice(1),
    topic: scenario === "long-header" ? longTopic : "Release notes and customer handoffs.",
    archivedAt: scenario === "archived" ? "2026-09-16T09:30:00.000Z" : null,
    createdByUserId: "member",
    createdAt: "2026-09-01T09:00:00.000Z",
    lastMessageAt: "2026-09-16T09:30:00.000Z",
    members: [
      {
        kind: "user",
        id: "member",
        name: "Morgan Lee",
        email: "morgan@example.test",
      },
      {
        kind: "user",
        id: "teammate",
        name: "Jamie Chen",
        email: "jamie@example.test",
      },
      {
        kind: "ai",
        id: "employee",
        name: "Riley",
        slug: "riley",
        role: "Release coordinator",
      },
    ],
    unreadCount: scenario === "long" ? 5 : 1,
    lastReadAt: scenario === "long" ? "2026-09-16T09:24:00.000Z" : "2026-09-16T08:59:00.000Z",
  };
}

type FixtureOptions = {
  scenario?: Scenario;
  width?: number;
  height?: number;
  dark?: boolean;
  instance?: string;
  waitForReady?: boolean;
};

async function openFixture(options: FixtureOptions = {}) {
  const scenario = options.scenario ?? "short";
  const label = labelFor(scenario);
  const page = await context.newPage();
  await page.setViewportSize({ width: options.width ?? 1440, height: options.height ?? 1000 });
  await page.emulateMedia({
    colorScheme: options.dark ? "dark" : "light",
    reducedMotion: "reduce",
  });
  await page.clock.setFixedTime(fixtureNow);

  let releaseLoading: () => void = () => {};
  const loadingGate = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  let messageAttempts = 0;
  const sent: SentBody[] = [];
  const reads: string[] = [];

  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) {
      unexpectedRequests.push(`${request.method()} ${url.href}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();

    const messagesMatch = url.pathname.match(
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)\/messages$/,
    );
    if (messagesMatch) {
      const channelId = decodeURIComponent(messagesMatch[1]);
      const requestScenario = scenarioFromChannel(channelId);
      if (request.method() === "GET") {
        messageAttempts += 1;
        if (requestScenario === "loading") await loadingGate;
        if (requestScenario === "error" && messageAttempts === 1) {
          return route.fulfill({
            status: 503,
            json: { error: "Channel fixture unavailable." },
          });
        }
        return route.fulfill({ json: messagesFor(requestScenario) });
      }
      if (request.method() === "POST") {
        const body = request.postDataJSON() as SentBody;
        sent.push(body);
        return route.fulfill({
          json: message(`sent-message-${sent.length}`, body.content, 120 + sent.length, {
            kind: "user",
            id: "member",
            name: "Morgan Lee",
            email: "morgan@example.test",
          }),
        });
      }
    }

    const readMatch = url.pathname.match(
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)\/read$/,
    );
    if (request.method() === "POST" && readMatch) {
      reads.push(decodeURIComponent(readMatch[1]));
      return route.fulfill({ json: { ok: true } });
    }
    if (
      request.method() === "GET" &&
      url.pathname === "/api/companies/company/workspace/mentionables"
    ) {
      return route.fulfill({ json: mentionables });
    }
    if (request.method() === "GET" && url.pathname === "/api/companies/company/search") {
      return route.fulfill({
        json: {
          results: [
            {
              kind: "project",
              id: "launch-plan",
              label: "Launch plan",
              sublabel: "Customer rollout",
              path: "/projects/launch-plan",
            },
          ],
        },
      });
    }

    const channelMatch = url.pathname.match(
      /^\/api\/companies\/company\/workspace\/channels\/([^/]+)$/,
    );
    if (request.method() === "GET" && channelMatch) {
      const channelId = decodeURIComponent(channelMatch[1]);
      return route.fulfill({ json: channelDetail(channelId, scenarioFromChannel(channelId)) });
    }

    unexpectedRequests.push(`${request.method()} ${url.pathname}${url.search}`);
    return route.fulfill({ status: 500, json: { error: "Unexpected fixture request" } });
  });

  const query = new URLSearchParams({
    case: scenario,
    instance: options.instance ?? `${scenario}-${Date.now()}`,
  });
  if (options.dark) query.set("theme", "dark");
  await page.goto(`${origin}/__channel_peek?${query}`, { waitUntil: "commit", timeout: 60000 });
  const opener = page.getByRole("button", { name: "Open channel peek", exact: true });
  await opener.waitFor({ timeout: 300000 });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: label, exact: true });
  await dialog.waitFor();

  const waitForReady = options.waitForReady ?? (scenario !== "loading" && scenario !== "error");
  if (waitForReady) {
    if (scenario === "archived") {
      await dialog.getByText("This channel has been archived.", { exact: false }).waitFor();
    } else {
      await dialog.getByRole("textbox", { name: `Message ${label}`, exact: true }).waitFor();
    }
  }

  return {
    page,
    dialog,
    label,
    reads,
    sent,
    releaseLoading,
    messageAttempts: () => messageAttempts,
  };
}

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, "element must be visible");
  return bounds;
}

async function outputValue(page: Page, name: string): Promise<string> {
  return (await page.getByLabel(name, { exact: true }).textContent())?.trim() ?? "";
}

async function waitForOutput(page: Page, name: string, value: string) {
  await page.waitForFunction(
    ({ label, expected }) =>
      document.querySelector(`output[aria-label="${label}"]`)?.textContent?.trim() === expected,
    { label: name, expected: value },
  );
}

async function assertNoHorizontalOverflow(page: Page, dialog: Locator) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    true,
    "the document must not scroll horizontally",
  );
  assert.equal(
    await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    "the modal panel must not hide horizontal overflow",
  );
  const panel = await box(dialog);
  for (const surface of [
    dialog.getByRole("log"),
    dialog.getByRole("button", { name: "Mark read & close", exact: true }).locator(".."),
  ]) {
    const bounds = await box(surface);
    assert.ok(
      bounds.x >= panel.x - 1 && bounds.x + bounds.width <= panel.x + panel.width + 1,
      `the transcript and footer must remain inside the panel: panel=${JSON.stringify(panel)} surface=${JSON.stringify(bounds)}`,
    );
  }
}

async function assertContainedBy(outer: Locator, inner: Locator, message: string) {
  const outerBox = await box(outer);
  const innerBox = await box(inner);
  assert.ok(
    innerBox.x >= outerBox.x - 1 &&
      innerBox.x + innerBox.width <= outerBox.x + outerBox.width + 1 &&
      innerBox.y >= outerBox.y - 1 &&
      innerBox.y + innerBox.height <= outerBox.y + outerBox.height + 1,
    `${message}: outer=${JSON.stringify(outerBox)} inner=${JSON.stringify(innerBox)}`,
  );
}

async function assertTranscriptIsOnlyScroller(dialog: Locator) {
  const log = dialog.getByRole("log");
  const scrollingAncestors = await log.evaluate((element) => {
    const result: Array<{ role: string | null; overflowY: string }> = [];
    let current: HTMLElement | null = element;
    for (;;) {
      const style = getComputedStyle(current);
      if (style.overflowY === "auto" || style.overflowY === "scroll") {
        result.push({ role: current.getAttribute("role"), overflowY: style.overflowY });
      }
      if (current.getAttribute("role") === "dialog" || !current.parentElement) break;
      current = current.parentElement;
    }
    return result;
  });
  assert.deepEqual(scrollingAncestors, [{ role: "log", overflowY: "auto" }]);
  assert.equal(
    await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1),
    true,
    "the panel itself must not scroll",
  );
}

let checks = 0;
async function check(name: string, run: () => Promise<void>) {
  console.log(`RUN ${name}`);
  try {
    await run();
  } catch (error) {
    const page = context.pages().at(-1);
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(output, "channel-peek-failure.png") });
    }
    if (browserErrors.length > 0) console.error("Browser errors:", browserErrors);
    throw error;
  }
  checks += 1;
  console.log(`PASS ${name}`);
}

try {
  await fs.mkdir(output, { recursive: true });

  await check(
    "compact panel has one scroller, an anchored short transcript, and split actions",
    async () => {
      const fixture = await openFixture({ instance: "desktop-geometry" });
      const { page, dialog } = fixture;
      const panel = await box(dialog);
      assert.ok(
        panel.height >= 607 && panel.height <= 609,
        `expected 38rem panel, got ${panel.height}`,
      );
      assert.ok(panel.width <= 672, "large peek keeps the established compact modal width");
      await assertTranscriptIsOnlyScroller(dialog);
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.body).overflow),
        "hidden",
        "the page behind the modal must remain locked",
      );

      const log = dialog.getByRole("log");
      const logBox = await box(log);
      const messageBox = await box(dialog.getByText("Short handoff complete.", { exact: true }));
      assert.ok(
        logBox.y + logBox.height - (messageBox.y + messageBox.height) < 32,
        "a short conversation sits immediately above the composer",
      );

      const open = dialog.getByRole("link", { name: "Open in Workspace", exact: true });
      const keep = dialog.getByRole("button", { name: "Keep unread", exact: true });
      const mark = dialog.getByRole("button", { name: "Mark read & close", exact: true });
      const openBox = await box(open);
      const keepBox = await box(keep);
      const markBox = await box(mark);
      assert.ok(Math.abs(openBox.y - keepBox.y) < 1 && Math.abs(keepBox.y - markBox.y) < 1);
      assert.ok(
        keepBox.x - (openBox.x + openBox.width) > 100,
        "desktop actions split left and right",
      );
      assert.ok(markBox.x > keepBox.x + keepBox.width, "the primary action remains last");
      await page.screenshot({ path: path.join(output, "channel-peek-short-desktop.png") });
      await page.close();
    },
  );

  await check(
    "long transcript scrolls independently while composer and footer stay fixed",
    async () => {
      const fixture = await openFixture({ scenario: "long", instance: "long-scroll" });
      const { page, dialog, label } = fixture;
      const log = dialog.getByRole("log");
      assert.equal(
        await log.evaluate((element) => element.scrollHeight > element.clientHeight),
        true,
        "the transcript must have real overflow",
      );
      const divider = dialog.locator("[data-unread-divider]");
      await divider.waitFor();
      const dividerBox = await box(divider);
      const initialLogBox = await box(log);
      assert.ok(
        dividerBox.y >= initialLogBox.y - 1 &&
          dividerBox.y + dividerBox.height <= initialLogBox.y + initialLogBox.height + 1,
        "the initial landing keeps the New messages divider visible",
      );
      await assertTranscriptIsOnlyScroller(dialog);
      const composer = dialog.getByRole("textbox", { name: `Message ${label}`, exact: true });
      const footer = dialog
        .getByRole("button", { name: "Mark read & close", exact: true })
        .locator("..");
      const beforeComposer = await box(composer);
      const beforeFooter = await box(footer);
      await log.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page.waitForTimeout(50);
      await log.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(50);
      const afterComposer = await box(composer);
      const afterFooter = await box(footer);
      assert.ok(
        Math.abs(beforeComposer.y - afterComposer.y) < 1,
        "composer does not move with history",
      );
      assert.ok(Math.abs(beforeFooter.y - afterFooter.y) < 1, "footer does not move with history");
      assert.ok(await log.evaluate((element) => element.scrollTop > 0));
      await page.screenshot({ path: path.join(output, "channel-peek-long-desktop.png") });
      await page.close();
    },
  );

  for (const width of [390, 320]) {
    await check(`mobile ${width}px fits and stacks every footer action`, async () => {
      const fixture = await openFixture({
        width,
        height: 700,
        instance: `mobile-${width}`,
      });
      const { page, dialog } = fixture;
      const panel = await box(dialog);
      assert.ok(panel.x >= 15 && panel.x + panel.width <= width - 15);
      assert.ok(panel.y >= 15 && panel.y + panel.height <= 685);
      assert.ok(panel.height <= 608, "mobile panel remains bounded by 38rem");

      const actions = [
        dialog.getByRole("link", { name: "Open in Workspace", exact: true }),
        dialog.getByRole("button", { name: "Keep unread", exact: true }),
        dialog.getByRole("button", { name: "Mark read & close", exact: true }),
      ];
      const actionBoxes = await Promise.all(actions.map(box));
      assert.equal(new Set(actionBoxes.map((bounds) => Math.round(bounds.y))).size, 3);
      assert.ok(
        actionBoxes.every((bounds) => Math.abs(bounds.width - actionBoxes[0].width) < 1),
        "stacked mobile actions share the available width",
      );
      const composer = dialog.getByRole("textbox", {
        name: `Message ${fixture.label}`,
        exact: true,
      });
      assert.ok((await box(composer)).height <= 32, "the empty compact composer stays one row");

      if (width === 320) {
        await composer.fill("@");
        const people = dialog.getByText("People", { exact: true });
        await people.waitFor();
        await assertContainedBy(
          dialog,
          people.locator(".."),
          "the people picker stays in the modal",
        );
        await composer.press("ArrowDown");
        await composer.press("Enter");
        assert.equal(await composer.inputValue(), "@riley ");

        await composer.fill("#pr");
        const resources = dialog.getByRole("listbox", {
          name: "Product areas and company resources",
          exact: true,
        });
        await resources.waitFor();
        await assertContainedBy(dialog, resources, "the resource picker stays in the modal");
        await resources.getByRole("option", { name: /Launch plan/ }).click();
        assert.match(await composer.inputValue(), /^\[#Launch plan\]\(/);

        await composer.fill("");
        await dialog.getByRole("button", { name: "Emoji", exact: true }).click();
        const emojiSearch = dialog.getByPlaceholder("Filter by category", { exact: true });
        await emojiSearch.waitFor();
        await assertContainedBy(
          dialog,
          emojiSearch.locator("..").locator(".."),
          "the emoji picker stays in the modal",
        );
        await page.keyboard.press("Escape");
        await emojiSearch.waitFor({ state: "detached" });
        assert.equal(await dialog.count(), 1, "closing the picker leaves the channel open");
      }
      await assertNoHorizontalOverflow(page, dialog);
      await page.screenshot({ path: path.join(output, `channel-peek-mobile-${width}.png`) });
      await page.close();
    });
  }

  await check("dark long header keeps title and topic clear of the close control", async () => {
    const fixture = await openFixture({
      scenario: "long-header",
      width: 390,
      height: 700,
      dark: true,
      instance: "dark-long-header",
    });
    const { page, dialog } = fixture;
    assert.equal(
      await page.locator("html").evaluate((element) => element.classList.contains("dark")),
      true,
    );
    const heading = dialog.getByRole("heading", { name: longLabel, exact: true });
    assert.equal(
      await heading.getAttribute("title"),
      longLabel,
      "the full truncated title is exposed",
    );
    assert.equal(
      await heading.evaluate((element) => element.scrollWidth > element.clientWidth),
      true,
      "the stress fixture genuinely truncates the visible title",
    );
    const topic = dialog.getByTitle(longTopic, { exact: true });
    const composer = dialog.getByRole("textbox", { name: `Message ${longLabel}`, exact: true });
    const close = dialog.getByRole("button", { name: "Close", exact: true });
    const headingBox = await box(heading);
    const topicBox = await box(topic);
    const closeBox = await box(close);
    assert.ok(headingBox.x + headingBox.width <= closeBox.x - 8);
    assert.ok(topicBox.x + topicBox.width <= closeBox.x - 8);
    assert.ok(topicBox.height <= 33, "topic stays clamped to two compact lines");
    assert.ok((await box(composer)).height <= 32, "a long channel name cannot grow an empty reply");
    assert.equal(
      await topic.getAttribute("title"),
      longTopic,
      "the complete topic remains available",
    );
    await assertNoHorizontalOverflow(page, dialog);
    await page.screenshot({ path: path.join(output, "channel-peek-long-header-dark.png") });
    await page.close();
  });

  await check("loading, inline retry, empty, and archived states remain actionable", async () => {
    const loading = await openFixture({
      scenario: "loading",
      instance: "loading-state",
      waitForReady: false,
    });
    await loading.dialog.getByText("Loading messages…", { exact: true }).waitFor();
    assert.equal(
      await loading.dialog
        .getByRole("button", { name: "Mark read & close", exact: true })
        .isDisabled(),
      true,
    );
    await loading.dialog.getByText("Loading the conversation…", { exact: true }).waitFor();
    loading.releaseLoading();
    await loading.dialog
      .getByRole("textbox", { name: `Message ${loading.label}`, exact: true })
      .waitFor();
    await loading.page.close();

    const retry = await openFixture({
      scenario: "error",
      instance: "error-retry",
      waitForReady: false,
    });
    await retry.dialog.getByRole("alert").getByText("Channel fixture unavailable.").waitFor();
    await retry.dialog.getByText("Reload the conversation to reply.", { exact: true }).waitFor();
    assert.equal(
      await retry.dialog
        .getByRole("button", { name: "Mark read & close", exact: true })
        .isDisabled(),
      true,
    );
    await retry.page.screenshot({ path: path.join(output, "channel-peek-error.png") });
    await retry.dialog.getByRole("button", { name: "Try again", exact: true }).click();
    await retry.dialog
      .getByRole("textbox", { name: `Message ${retry.label}`, exact: true })
      .waitFor();
    assert.equal(retry.messageAttempts(), 2, "retry performs exactly one replacement read");
    assert.equal(await retry.dialog.getByRole("alert").count(), 0);
    await retry.page.close();

    const empty = await openFixture({ scenario: "empty", instance: "empty-state" });
    await empty.dialog.getByText("Nothing to catch up on here.", { exact: true }).waitFor();
    await empty.dialog.getByText("Say something to start it off.", { exact: true }).waitFor();
    assert.equal(
      await empty.dialog.getByRole("button", { name: "Send", exact: true }).isDisabled(),
      true,
    );
    await empty.page.screenshot({ path: path.join(output, "channel-peek-empty.png") });
    await empty.page.close();

    const archived = await openFixture({ scenario: "archived", instance: "archived-state" });
    await archived.dialog
      .getByText("This channel has been archived. You can still read it in the Workspace.", {
        exact: true,
      })
      .waitFor();
    assert.equal(await archived.dialog.getByRole("textbox").count(), 0);
    assert.equal(await archived.dialog.getByRole("button", { name: "Send" }).count(), 0);
    await archived.page.close();
  });

  await check("composer preserves Shift+Enter, sends on Enter, and restores focus", async () => {
    const fixture = await openFixture({ instance: "composer-keys" });
    const { page, dialog, label } = fixture;
    const composer = dialog.getByRole("textbox", { name: `Message ${label}`, exact: true });
    const send = dialog.getByRole("button", { name: "Send", exact: true });
    assert.equal(await send.isDisabled(), true, "an empty message cannot be sent");
    await composer.fill("First line");
    await composer.press("Shift+Enter");
    assert.equal(await composer.inputValue(), "First line\n");
    assert.deepEqual(fixture.sent, [], "Shift+Enter only inserts a newline");
    await composer.type("Second line");
    const posted = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith(`/channels/short--composer-keys/messages`),
    );
    await composer.press("Enter");
    await posted;
    await page.waitForFunction(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message #release-coordination"]',
      );
      return textarea?.value === "" && document.activeElement === textarea;
    });
    assert.deepEqual(fixture.sent, [{ content: "First line\nSecond line", attachmentIds: [] }]);
    assert.equal(await send.isDisabled(), true, "the cleared composer cannot send twice");
    assert.equal(
      await composer.evaluate((element) => document.activeElement === element),
      true,
      "focus returns to the composer after the round trip",
    );
    await page.close();
  });

  await check(
    "Keep unread and Workspace preserve unread state; Mark, X, and Escape spend it",
    async () => {
      const keep = await openFixture({ instance: "close-keep" });
      await keep.dialog.getByRole("button", { name: "Keep unread", exact: true }).click();
      await keep.dialog.waitFor({ state: "detached" });
      assert.deepEqual(keep.reads, []);
      assert.equal(await outputValue(keep.page, "Marked-read callbacks"), "0");
      assert.equal(await outputValue(keep.page, "Current route"), "/c/company");
      await keep.page.close();

      const mark = await openFixture({ instance: "close-mark" });
      await mark.dialog.getByRole("button", { name: "Mark read & close", exact: true }).click();
      await waitForOutput(mark.page, "Marked-read callbacks", "1");
      assert.deepEqual(mark.reads, ["short--close-mark"]);
      await mark.page.close();

      const close = await openFixture({ instance: "close-x" });
      await close.dialog.getByRole("button", { name: "Close", exact: true }).click();
      await waitForOutput(close.page, "Marked-read callbacks", "1");
      assert.deepEqual(close.reads, ["short--close-x"]);
      await close.page.close();

      const escape = await openFixture({ instance: "close-escape" });
      await escape.page.keyboard.press("Escape");
      await waitForOutput(escape.page, "Marked-read callbacks", "1");
      assert.deepEqual(escape.reads, ["short--close-escape"]);
      await escape.page.close();

      const workspace = await openFixture({ instance: "close-workspace" });
      await workspace.dialog.getByRole("link", { name: "Open in Workspace", exact: true }).click();
      await waitForOutput(
        workspace.page,
        "Current route",
        "/c/company/workspace/short--close-workspace",
      );
      assert.deepEqual(workspace.reads, []);
      assert.equal(await outputValue(workspace.page, "Marked-read callbacks"), "0");
      await workspace.page.close();
    },
  );

  await check(
    "unsent replies require confirmation and can be kept without losing text",
    async () => {
      const fixture = await openFixture({ instance: "draft-confirmation" });
      const composer = fixture.dialog.getByRole("textbox", {
        name: `Message ${fixture.label}`,
        exact: true,
      });
      await composer.fill("Keep this careful reply");
      await fixture.dialog.getByRole("button", { name: "Keep unread", exact: true }).click();
      const confirm = fixture.page.getByRole("dialog", {
        name: "Discard your reply?",
        exact: true,
      });
      await confirm.waitFor();
      assert.deepEqual(fixture.reads, []);
      await confirm.getByRole("button", { name: "Keep writing", exact: true }).click();
      await confirm.waitFor({ state: "detached" });
      assert.equal(await composer.inputValue(), "Keep this careful reply");
      assert.equal(await fixture.dialog.count(), 1);
      await fixture.dialog.getByRole("button", { name: "Keep unread", exact: true }).click();
      const discard = fixture.page.getByRole("dialog", {
        name: "Discard your reply?",
        exact: true,
      });
      await discard.getByRole("button", { name: "Discard", exact: true }).click();
      await fixture.dialog.waitFor({ state: "detached" });
      assert.deepEqual(
        fixture.reads,
        [],
        "discarding through Keep unread still preserves the badge",
      );
      await fixture.page.close();
    },
  );

  await check(
    "first Escape dismisses the @ popup without closing or marking the channel",
    async () => {
      const fixture = await openFixture({ instance: "mention-escape" });
      const composer = fixture.dialog.getByRole("textbox", {
        name: `Message ${fixture.label}`,
        exact: true,
      });
      await composer.fill("@");
      const people = fixture.dialog.getByText("People", { exact: true });
      await people.waitFor();
      await composer.press("Escape");
      await people.waitFor({ state: "detached" });
      assert.equal(await fixture.dialog.count(), 1);
      assert.equal(await composer.inputValue(), "@");
      assert.deepEqual(fixture.reads, []);
      await composer.fill("");
      await composer.press("Escape");
      await waitForOutput(fixture.page, "Marked-read callbacks", "1");
      assert.deepEqual(fixture.reads, ["short--mention-escape"]);
      await fixture.page.close();
    },
  );

  assert.deepEqual(browserErrors, [], "browser must have no uncaught errors");
  assert.deepEqual(unexpectedRequests, [], "browser must only make expected fixture requests");
  console.log(`PASS ${checks} channel peek browser regressions`);
} finally {
  for (const page of context.pages()) {
    if (!page.isClosed()) await page.close();
  }
  await context.close();
  await browser.close();
  await server.close();
}
