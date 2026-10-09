/**
 * Shared plumbing for browser suites that drive the real App (`appHarness.tsx`)
 * against a deterministic API: build the fixture and start Chrome once, open
 * the App at a path with the suite's own endpoint table, record every write
 * the page makes, and count the clicks a flow takes — the number those suites
 * exist to pin.
 *
 *   const app = await startApp("Fewer clicks — Routines");
 *   await app.check("Pause from the header", async () => {
 *     const view = await app.open({ path: "/c/acme/routines/alex/daily", routes });
 *     await view.click(view.page.getByRole("switch", { name: "Pause this routine" }));
 *     assert.equal(view.clicks(), 1);
 *   });
 *   await app.finish();
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import type { Company, Me } from "../client/lib/api";
import { startBrowserFixture } from "./browserFixture";

export const NOW = new Date("2026-10-09T09:00:00.000Z");
export const hoursAgo = (hours: number) =>
  new Date(NOW.getTime() - hours * 3_600_000).toISOString();

export const COMPANY: Company = {
  id: "company",
  slug: "acme",
  name: "Acme",
  mission: "Answer every customer within the hour.",
  vision: "A company that runs itself and still feels personal.",
  role: "owner",
  financeAccess: "full",
  requireTwoFactor: false,
};

export const ME: Me = {
  id: "viewer",
  email: "morgan@example.test",
  name: "Morgan Lee",
  handle: "morgan",
  avatarKey: null,
  isMasterAdmin: false,
  emailVerified: true,
  emailVerificationRequired: false,
};

/** Every company endpoint in these suites lives under this prefix. */
export const API = `/api/companies/${COMPANY.id}`;

export type ApiRequest = {
  method: string;
  path: string;
  url: URL;
  body: Record<string, unknown>;
  /** The route pattern's match, for ids captured from the path. */
  match: RegExpMatchArray;
};

/** An answer other than 200 JSON. */
export class Reply {
  constructor(
    readonly status: number,
    readonly json: unknown,
    readonly raw?: { body: string; contentType: string },
  ) {}
}
export const status = (code: number, json: unknown = { error: `HTTP ${code}` }) =>
  new Reply(code, json);
/** A server-sent event stream, the way the chat endpoints answer. */
export const sse = (events: Array<[event: string, data: unknown]>) =>
  new Reply(200, null, {
    contentType: "text/event-stream",
    body: events
      .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      .join(""),
  });

/** A promise a route can wait on until the suite lets it answer. */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

export type ApiHandler = (request: ApiRequest) => unknown;
export type ApiRoute = [
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string | RegExp,
  handler: ApiHandler,
];

export type Write = { method: string; path: string; body: Record<string, unknown> };

export type OpenOptions = {
  path: string;
  routes?: ApiRoute[];
  role?: NonNullable<Company["role"]>;
  company?: Partial<Company>;
  me?: Partial<Me>;
  /** `/api/auth/me` answers 401, as for someone not signed in. */
  signedOut?: boolean;
  width?: number;
  height?: number;
  scheme?: "light" | "dark";
  /** A touch-first phone: coarse pointer, touch events, a phone viewport. */
  touch?: boolean;
  /** localStorage seeded once, before the first load (reloads keep it). */
  storage?: Record<string, string>;
};

export type AppView = {
  page: Page;
  writes: Write[];
  /** Requests no route answered, as "METHOD /path". */
  unrouted: string[];
  /** Click `target`, counting it toward this flow. */
  click: (target: Locator) => Promise<void>;
  /** Clicks counted so far. */
  clicks: () => number;
  /** Where the router is: pathname, search and hash. */
  location: () => Promise<string>;
  /** Wait until the router reaches `expected` (exact, or a pattern). */
  landedOn: (expected: string | RegExp) => Promise<void>;
  /** Wait until the page has made a write `match` accepts, and return it. */
  waitForWrite: (match: (write: Write) => boolean, message?: string) => Promise<Write>;
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function matches(pattern: string | RegExp, pathname: string): RegExpMatchArray | null {
  if (typeof pattern === "string") {
    return pattern === pathname
      ? (Object.assign([pathname], { index: 0 }) as RegExpMatchArray)
      : null;
  }
  return pathname.match(pattern);
}

export async function startApp(title: string) {
  const output = path.resolve(root, "../output/playwright");
  await fs.mkdir(output, { recursive: true });
  const fixture = await startBrowserFixture("appHarness.tsx", 0);
  let browser: Browser;
  try {
    browser = await chromium.launch({
      channel: process.env.GENOSYN_TEST_BROWSER ?? "chrome",
      headless: true,
    });
  } catch (error) {
    await fixture.close();
    throw error;
  }
  const pageErrors: string[] = [];
  /** Views opened by the check that is running, to explain a failure. */
  let checkViews: AppView[] = [];
  let passed = 0;
  const failures: string[] = [];
  console.log(title);

  async function open(options: OpenOptions): Promise<AppView> {
    const company: Company = { ...COMPANY, role: options.role ?? "owner", ...options.company };
    const me: Me = { ...ME, ...options.me };
    const writes: Write[] = [];
    const unrouted: string[] = [];
    let clickCount = 0;
    const context = await browser.newContext({
      viewport: options.touch
        ? { width: options.width ?? 390, height: options.height ?? 844 }
        : { width: options.width ?? 1280, height: options.height ?? 900 },
      colorScheme: options.scheme ?? "light",
      hasTouch: options.touch ?? false,
      isMobile: options.touch ?? false,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => pageErrors.push(`${options.path}: ${error.message}`));
    page.on("close", () => void context.close());
    await page.clock.setFixedTime(NOW);
    await page.addInitScript((seed) => {
      // Seed once per context, so a reload keeps whatever the page saved.
      if (sessionStorage.getItem("app-fixture-seeded")) return;
      sessionStorage.setItem("app-fixture-seeded", "1");
      localStorage.setItem("genosyn.pushPromptDismissed", "1");
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
    }, options.storage ?? {});
    const defaults: ApiRoute[] = [
      [
        "GET",
        "/api/auth/me",
        () => (options.signedOut ? status(401, { error: "Not signed in" }) : me),
      ],
      ["GET", "/api/companies", () => [company]],
      ["GET", `${API}/notifications/unread-count`, () => ({ count: 0 })],
      ["GET", `${API}/notifications`, () => ({ notifications: [] })],
      // The live socket has no server here; a token lets it try and back off quietly.
      ["POST", `${API}/workspace/ws-token`, () => ({ token: "fixture" })],
    ];
    const routes = [...(options.routes ?? []), ...defaults];
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      let body: Record<string, unknown> = {};
      if (method !== "GET") {
        try {
          body = (request.postDataJSON() ?? {}) as Record<string, unknown>;
        } catch {
          body = {};
        }
        // The socket's token is plumbing, not something a flow wrote.
        if (url.pathname !== `${API}/workspace/ws-token`) {
          writes.push({ method, path: url.pathname, body });
        }
      }
      for (const [routeMethod, pattern, handle] of routes) {
        if (routeMethod !== method) continue;
        const match = matches(pattern, url.pathname);
        if (!match) continue;
        try {
          const result = await handle({ method, path: url.pathname, url, body, match });
          if (result instanceof Reply) {
            return result.raw
              ? route.fulfill({
                  status: result.status,
                  contentType: result.raw.contentType,
                  body: result.raw.body,
                })
              : route.fulfill({ status: result.status, json: result.json });
          }
          return route.fulfill({ json: result ?? null });
        } catch (error) {
          return route.fulfill({
            status: 500,
            json: { error: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      unrouted.push(`${method} ${url.pathname}`);
      return route.fulfill({
        status: method === "GET" ? 404 : 500,
        json: { error: `Not in this fixture: ${method} ${url.pathname}` },
      });
    });
    if (options.signedOut) {
      // Signed out, the App reads the document's own path to tell a sign-in
      // page from a protected one, so the document is served at the path too.
      const url = new URL(options.path, fixture.origin);
      url.searchParams.set("path", options.path);
      await page.goto(url.toString());
    } else {
      await page.goto(`${fixture.origin}/?path=${encodeURIComponent(options.path)}`);
    }
    const location = async () => ((await page.getByTestId("location").textContent()) ?? "").trim();
    const view: AppView = {
      page,
      writes,
      unrouted,
      click: async (target) => {
        clickCount += 1;
        await target.click();
      },
      clicks: () => clickCount,
      location,
      landedOn: async (expected) => {
        await page.waitForFunction(
          ({ source, flags, exact }) => {
            const text = document.querySelector('[data-testid="location"]')?.textContent?.trim();
            if (text == null) return false;
            return exact !== null ? text === exact : new RegExp(source, flags).test(text);
          },
          typeof expected === "string"
            ? { source: "", flags: "", exact: expected }
            : { source: expected.source, flags: expected.flags, exact: null },
        );
      },
      waitForWrite: async (match, message) => {
        const deadline = Date.now() + 5_000;
        for (;;) {
          const found = writes.find(match);
          if (found) return found;
          if (Date.now() > deadline) {
            throw new assert.AssertionError({
              message: `${message ?? "the expected write never happened"} (writes: ${
                writes.map((w) => `${w.method} ${w.path}`).join(", ") || "none"
              })`,
            });
          }
          await page.waitForTimeout(50);
        }
      },
    };
    checkViews.push(view);
    return view;
  }

  async function check(name: string, run: () => Promise<void>) {
    checkViews = [];
    try {
      await run();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (error) {
      failures.push(name);
      console.error(`  ✗ ${name}`);
      console.error(error);
      for (const view of checkViews) {
        if (view.unrouted.length)
          console.error(`    not in the fixture: ${view.unrouted.join(", ")}`);
        if (!view.page.isClosed()) {
          console.error(`    location: ${await view.location().catch(() => "?")}`);
          await shot(view.page, `failed-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}`).catch(
            () => undefined,
          );
          await view.page.close().catch(() => undefined);
        }
      }
    }
  }

  async function shot(page: Page, name: string) {
    await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  }

  async function finish() {
    try {
      assert.deepEqual(pageErrors, [], `page errors:\n${pageErrors.join("\n")}`);
    } catch (error) {
      failures.push("no page errors");
      console.error(error);
    } finally {
      await browser.close();
      await fixture.close();
    }
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      console.error(`Failed: ${failures.join("; ")}`);
      process.exit(1);
    }
  }

  return { open, check, shot, finish };
}

/** The document never scrolls sideways at this width. */
export async function noSidewaysScroll(page: Page, label: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  assert.ok(overflow <= 0, `${label} scrolls sideways by ${overflow}px`);
}

/** The element that has keyboard focus, described for an assertion message. */
export async function focused(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "body";
    const label =
      el.getAttribute("aria-label") ??
      (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ??
      el.getAttribute("placeholder") ??
      el.textContent?.trim().slice(0, 40) ??
      "";
    return `${el.tagName.toLowerCase()}:${label}`;
  });
}

/** Wait until focus is on `locator` (or inside it). */
export async function waitForFocus(locator: Locator, message?: string) {
  const page = locator.page();
  const deadline = Date.now() + 5_000;
  // Re-resolve the locator each time: the element can be replaced (a pane
  // remounting) between the action and the focus landing.
  for (;;) {
    const has = await locator
      .evaluate(
        (target) => target === document.activeElement || target.contains(document.activeElement),
        undefined,
        { timeout: 1_000 },
      )
      .catch(() => false);
    if (has) return;
    if (Date.now() > deadline) {
      throw new assert.AssertionError({
        message: `${message ?? "focus is not on the expected element"} (focus: ${await focused(page)})`,
      });
    }
    await page.waitForTimeout(50);
  }
}
