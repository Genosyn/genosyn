import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { config } from "../../config.js";
import { AIEmployee } from "../db/entities/AIEmployee.js";
import { BrowserSession } from "../db/entities/BrowserSession.js";
import { Company } from "../db/entities/Company.js";
import { closeTestDb, initTestDb, insert, resetTestDb } from "../test/dbHarness.js";
import {
  acquirePage,
  liveProfileCountForTests,
  releaseAllPages,
  releasePage,
  setProfileLingerForTests,
} from "./browserChromium.js";
import { injectChromiumLauncherForTests } from "./browserProfile.js";
import { removeBrowserStorageForEmployee } from "./browserStorage.js";
import { employeeBrowserProfileDir, employeeBrowserStateFile } from "./paths.js";

/**
 * The employee's browser is now one shared Chrome per employee, holding a real
 * on-disk profile, with a window per session inside it. Three properties carry
 * the whole design and none of them are observable from a unit test of a pure
 * function, so this suite drives `acquirePage`/`releasePage` against a fake
 * Playwright and asserts on what the fake was asked to do:
 *
 *   1. **One Chrome per employee.** A `user-data-dir` is single-writer, so a
 *      second launch against a live profile is corruption, not a slow path.
 *   2. **A window, not a tab, per session.** Chrome only emits screencast
 *      frames for a page it composites, so sharing a window would silently
 *      freeze every live viewer but one.
 *   3. **Nobody closes anyone else's browser.** The context outlives every
 *      individual session that borrows it.
 */

const originalDataDir = config.dataDir;
const mutableConfig = config as unknown as { dataDir: string };
let tempDir = "";

// ---------- fake playwright ----------

type FakePage = {
  kind: "window" | "tab";
  closed: boolean;
  openerPage: FakePage | null;
  ctx: FakeContext;
  listeners: Map<string, Array<(arg: unknown) => void>>;
  context: () => FakeContext;
  on: (ev: string, cb: (arg: unknown) => void) => void;
  isClosed: () => boolean;
  close: () => Promise<void>;
  url: () => string;
  opener: () => Promise<FakePage | null>;
  goto: (url: string) => Promise<void>;
  evaluate: (fn: string, arg?: unknown) => Promise<unknown>;
  waitForLoadState: (state: string, opts?: unknown) => Promise<void>;
  visited: string[];
};

type FakeContext = {
  id: string;
  userDataDir: string | null;
  closed: boolean;
  pagesList: FakePage[];
  routes: string[];
  initScripts: string[];
  addedCookies: unknown[];
  storageStateCalls: number;
  listeners: Map<string, Array<(arg: unknown) => void>>;
  browserRef: FakeBrowser | null;
  route: (url: string, handler: unknown) => Promise<void>;
  addInitScript: (script: { content: string }) => Promise<void>;
  on: (ev: string, cb: (arg: unknown) => void) => void;
  emit: (ev: string, arg: unknown) => void;
  browser: () => FakeBrowser | null;
  newPage: () => Promise<FakePage>;
  newCDPSession: (page: unknown) => Promise<FakeCdp>;
  pages: () => FakePage[];
  addCookies: (cookies: unknown[]) => Promise<void>;
  storageState: () => Promise<{ cookies: unknown[]; origins: unknown[] }>;
  close: () => Promise<void>;
};

type FakeBrowser = {
  closed: boolean;
  /** The context this browser owns, so a browser-level CDP session targets it. */
  ownContext: FakeContext | null;
  newBrowserCDPSession: () => Promise<FakeCdp>;
  newContext: (opts: unknown) => Promise<FakeContext>;
  close: () => Promise<void>;
};

type FakeCdp = {
  sent: Array<{ method: string; params: unknown }>;
  send: (method: string, params?: unknown) => Promise<unknown>;
  detach: () => Promise<void>;
};

type Harness = {
  chromium: {
    launch: (opts: Record<string, unknown>) => Promise<FakeBrowser>;
    launchPersistentContext?: (
      dir: string,
      opts: Record<string, unknown>,
    ) => Promise<FakeContext>;
  };
  persistentLaunches: Array<{ dir: string; opts: Record<string, unknown> }>;
  targetRequests: Array<Record<string, unknown>>;
  ephemeralLaunches: number;
  contexts: FakeContext[];
  /** Make the next N persistent launches fail, to exercise the fallback. */
  failPersistent: boolean;
  /** Resolve to let a stalled launch proceed, for race tests. */
  gate: { promise: Promise<void>; open: () => void } | null;
};

let pageSeq = 0;

function makeCdp(
  ctx: FakeContext,
  onCreateTarget: (params: Record<string, unknown>) => void,
): FakeCdp {
  const cdp: FakeCdp = {
    sent: [],
    async send(method, params) {
      cdp.sent.push({ method, params });
      if (method === "Target.createTarget") {
        const p = (params ?? {}) as Record<string, unknown>;
        onCreateTarget(p);
        return { targetId: `target-${ctx.pagesList.length}` };
      }
      if (method === "Page.getLayoutMetrics") {
        return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 } };
      }
      return {};
    },
    async detach() {},
  };
  return cdp;
}

function makeHarness(): Harness {
  const h: Harness = {
    chromium: { launch: async () => makeBrowser(null) },
    persistentLaunches: [],
    targetRequests: [],
    ephemeralLaunches: 0,
    contexts: [],
    failPersistent: false,
    gate: null,
  };

  function makePage(ctx: FakeContext, kind: "window" | "tab", opener: FakePage | null): FakePage {
    pageSeq += 1;
    const page: FakePage = {
      kind,
      closed: false,
      openerPage: opener,
      ctx,
      listeners: new Map(),
      visited: [],
      context: () => ctx,
      on(ev, cb) {
        const list = page.listeners.get(ev) ?? [];
        list.push(cb);
        page.listeners.set(ev, list);
      },
      isClosed: () => page.closed,
      async close() {
        page.closed = true;
        ctx.pagesList = ctx.pagesList.filter((p) => p !== page);
      },
      url: () => `https://example.test/${pageSeq}`,
      async opener() {
        return page.openerPage;
      },
      async goto(url) {
        page.visited.push(url);
      },
      async evaluate() {
        return undefined;
      },
      async waitForLoadState() {},
    };
    ctx.pagesList.push(page);
    return page;
  }

  function makeContext(userDataDir: string | null, browser: FakeBrowser | null): FakeContext {
    const ctx: FakeContext = {
      id: `ctx-${h.contexts.length + 1}`,
      userDataDir,
      closed: false,
      pagesList: [],
      routes: [],
      initScripts: [],
      addedCookies: [],
      storageStateCalls: 0,
      listeners: new Map(),
      browserRef: browser,
      async route(url) {
        ctx.routes.push(url);
      },
      async addInitScript(script) {
        ctx.initScripts.push(script.content);
      },
      on(ev, cb) {
        const list = ctx.listeners.get(ev) ?? [];
        list.push(cb);
        ctx.listeners.set(ev, list);
      },
      emit(ev, arg) {
        for (const cb of ctx.listeners.get(ev) ?? []) cb(arg);
      },
      browser: () => ctx.browserRef,
      async newPage() {
        const p = makePage(ctx, "tab", null);
        ctx.emit("page", p);
        return p;
      },
      async newCDPSession() {
        return makeCdp(ctx, (params) => {
          const p = makePage(ctx, params.newWindow ? "window" : "tab", null);
          // Chrome surfaces the target asynchronously; the profile listener is
          // what turns it into this session's page.
          setImmediate(() => ctx.emit("page", p));
        });
      },
      pages: () => [...ctx.pagesList],
      async addCookies(cookies) {
        ctx.addedCookies.push(...cookies);
      },
      async storageState() {
        ctx.storageStateCalls += 1;
        return { cookies: [], origins: [] };
      },
      async close() {
        ctx.closed = true;
        for (const p of [...ctx.pagesList]) await p.close();
        ctx.emit("close", undefined);
      },
    };
    h.contexts.push(ctx);
    return ctx;
  }

  function makeBrowser(userDataDir: string | null): FakeBrowser {
    const browser: FakeBrowser = {
      closed: false,
      ownContext: null,
      async newBrowserCDPSession() {
        const ctx = browser.ownContext;
        if (!ctx) throw new Error("no context on this browser");
        return makeCdp(ctx, (params) => {
          h.targetRequests.push(params);
          const p = makePage(ctx, params.newWindow ? "window" : "tab", null);
          setImmediate(() => ctx.emit("page", p));
        });
      },
      async newContext() {
        const ctx = makeContext(userDataDir, browser);
        browser.ownContext = ctx;
        return ctx;
      },
      async close() {
        browser.closed = true;
      },
    };
    return browser;
  }

  h.chromium = {
    async launch() {
      h.ephemeralLaunches += 1;
      return makeBrowser(null);
    },
    async launchPersistentContext(dir, opts) {
      if (h.gate) await h.gate.promise;
      if (h.failPersistent) throw new Error("profile locked by another process");
      h.persistentLaunches.push({ dir, opts });
      const browser = makeBrowser(dir);
      const ctx = makeContext(dir, browser);
      browser.ownContext = ctx;
      // Chrome always opens a window at launch; the profile is expected to hand
      // that one out before asking for another.
      const initial = makePage(ctx, "window", null);
      void initial;
      return ctx;
    },
  };

  // Expose the page factory for popup simulation.
  (h as unknown as { makePopup: (ctx: FakeContext, opener: FakePage) => FakePage }).makePopup = (
    ctx,
    opener,
  ) => {
    const p = makePage(ctx, "tab", opener);
    ctx.emit("page", p);
    return p;
  };
  return h;
}

// ---------- fixtures ----------

let harness: Harness;

async function seedCompanyEmployee(companyId: string, employeeId: string): Promise<void> {
  await insert(Company, {
    id: companyId,
    name: `Company ${companyId}`,
    slug: `${companyId}-slug`,
    ownerId: "owner",
  });
  await insert(AIEmployee, {
    id: employeeId,
    companyId,
    name: `Employee ${employeeId}`,
    slug: `${employeeId}-slug`,
    role: "Researcher",
  });
}

/**
 * Wait for a condition rather than for a duration.
 *
 * Teardown here is a timer that starts an async chain — a DB lookup, a cookie
 * export, a file write — so any fixed sleep is either flaky or slow. Poll.
 */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

let sessionSeq = 0;
async function seedSession(companyId: string, employeeId: string): Promise<string> {
  sessionSeq += 1;
  const id = `session-${sessionSeq}`;
  await insert(BrowserSession, {
    id,
    companyId,
    employeeId,
    status: "pending",
    mcpToken: `token-${sessionSeq}`,
    mcpTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  return id;
}

before(async () => {
  await initTestDb();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "genosyn-browser-profile-"));
  mutableConfig.dataDir = tempDir;
});

beforeEach(async () => {
  await resetTestDb();
  await fs.rm(path.join(tempDir, ".private"), { recursive: true, force: true });
  harness = makeHarness();
  injectChromiumLauncherForTests(harness.chromium as never);
  setProfileLingerForTests(20);
});

afterEach(async () => {
  await releaseAllPages("shutdown").catch(() => {});
  injectChromiumLauncherForTests(null);
  setProfileLingerForTests(null);
});

after(async () => {
  mutableConfig.dataDir = originalDataDir;
  await closeTestDb();
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------- the profile directory ----------

describe("the profile directory", () => {
  test("lives under .private, not in the employee's workspace", async () => {
    await seedCompanyEmployee("acme", "ada");
    const session = await seedSession("acme", "ada");
    await acquirePage(session);

    const dir = employeeBrowserProfileDir("acme", "ada");
    assert.equal(harness.persistentLaunches.length, 1);
    assert.equal(harness.persistentLaunches[0].dir, dir);
    // `.private` is the tree an employee's own coding tools cannot read. A raw
    // Chrome profile holds a live session for every site they have signed into.
    assert.ok(dir.includes(`${path.sep}.private${path.sep}`), dir);
    assert.ok(dir.startsWith(tempDir));
    const stat = await fs.stat(dir);
    assert.equal(stat.mode & 0o777, 0o700);
  });

  test("is distinct per employee and per company", async () => {
    await seedCompanyEmployee("acme", "ada");
    await seedCompanyEmployee("globex", "ada");
    assert.notEqual(
      employeeBrowserProfileDir("acme", "ada"),
      employeeBrowserProfileDir("globex", "ada"),
    );
    assert.notEqual(
      employeeBrowserProfileDir("acme", "ada"),
      employeeBrowserProfileDir("acme", "grace"),
    );
  });

  test("is deleted with the employee", async () => {
    await seedCompanyEmployee("acme", "ada");
    const dir = employeeBrowserProfileDir("acme", "ada");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "Cookies"), "sqlite");
    await fs.mkdir(path.dirname(employeeBrowserStateFile("acme", "ada")), { recursive: true });
    await fs.writeFile(employeeBrowserStateFile("acme", "ada"), "{}");

    await removeBrowserStorageForEmployee("acme", "ada");

    await assert.rejects(fs.stat(dir), /ENOENT/);
    await assert.rejects(fs.stat(employeeBrowserStateFile("acme", "ada")), /ENOENT/);
  });
});

// ---------- one Chrome per employee ----------

describe("one Chrome per employee", () => {
  test("two sessions for one employee share a single context", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");

    const pageA = (await acquirePage(a)) as FakePage;
    const pageB = (await acquirePage(b)) as FakePage;

    assert.equal(harness.persistentLaunches.length, 1, "launched Chrome more than once");
    assert.equal(pageA.ctx, pageB.ctx, "sessions did not share a context");
    assert.notEqual(pageA, pageB, "sessions shared a page");
  });

  test("different employees never share a context", async () => {
    await seedCompanyEmployee("acme", "ada");
    await seedCompanyEmployee("acme", "grace");
    const a = await seedSession("acme", "ada");
    const g = await seedSession("acme", "grace");

    const pageA = (await acquirePage(a)) as FakePage;
    const pageG = (await acquirePage(g)) as FakePage;

    assert.equal(harness.persistentLaunches.length, 2);
    assert.notEqual(pageA.ctx, pageG.ctx, "two employees shared one cookie jar");
  });

  test("different companies never share a context", async () => {
    await seedCompanyEmployee("acme", "ada");
    await seedCompanyEmployee("globex", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("globex", "ada");

    const pageA = (await acquirePage(a)) as FakePage;
    const pageB = (await acquirePage(b)) as FakePage;

    assert.notEqual(pageA.ctx, pageB.ctx);
    assert.equal(harness.persistentLaunches.length, 2);
  });

  test("concurrent cold starts launch Chrome exactly once", async () => {
    // The corruption case: a chat and a Routine Run cold-starting together. A
    // user-data-dir is single-writer, so a second launch is not a slow path.
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");

    let open!: () => void;
    harness.gate = {
      promise: new Promise<void>((resolve) => {
        open = resolve;
      }),
      open: () => open(),
    };

    const both = Promise.all([acquirePage(a), acquirePage(b)]);
    harness.gate.open();
    const [pageA, pageB] = (await both) as FakePage[];

    assert.equal(harness.persistentLaunches.length, 1, "raced into two Chromes on one profile");
    assert.equal(pageA.ctx, pageB.ctx);
  });

  test("repeated acquires for one session do not re-launch or re-open", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const first = await acquirePage(a);
    const second = await acquirePage(a);
    assert.equal(first, second);
    assert.equal(harness.persistentLaunches.length, 1);
  });
});

// ---------- a window per session ----------

describe("a window per session", () => {
  test("each session gets its own OS window, not a tab", async () => {
    // Chrome only emits Page.screencastFrame for a page it is compositing, so
    // two sessions sharing a window would freeze one viewer with no error.
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");

    const pageA = (await acquirePage(a)) as FakePage;
    const pageB = (await acquirePage(b)) as FakePage;

    assert.equal(pageA.kind, "window");
    assert.equal(pageB.kind, "window");
  });

  test("sizes every additional OS window to the App browser default", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");

    await acquirePage(a);
    await acquirePage(b);

    assert.deepEqual(harness.targetRequests, [
      {
        url: "about:blank",
        newWindow: true,
        width: 1600,
        height: 1000,
      },
    ]);
  });

  test("falls back to a tab when there is no browser-level CDP session", async () => {
    await seedCompanyEmployee("acme", "ada");
    delete (harness.chromium as { launchPersistentContext?: unknown }).launchPersistentContext;
    const a = await seedSession("acme", "ada");
    const page = (await acquirePage(a)) as FakePage;
    assert.equal(page.kind, "tab");
    assert.equal(harness.ephemeralLaunches, 1);
  });
});

// ---------- teardown ----------

describe("teardown", () => {
  test("releasing one session leaves the other's browser running", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");
    const pageA = (await acquirePage(a)) as FakePage;
    const pageB = (await acquirePage(b)) as FakePage;
    const ctx = pageA.ctx;

    await releasePage(a, "idle");

    assert.equal(ctx.closed, false, "one session's idle timeout closed the shared Chrome");
    assert.equal(pageA.closed, true, "the released session's window stayed open");
    assert.equal(pageB.closed, false, "released a sibling session's window");
  });

  test("the last session out closes the browser after the linger", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const pageA = (await acquirePage(a)) as FakePage;
    const ctx = pageA.ctx;

    await releasePage(a, "idle");
    assert.equal(ctx.closed, false, "closed immediately instead of lingering");

    await waitFor("the shared Chrome to close", () => ctx.closed);
    await waitFor("the profile registry to drain", () => liveProfileCountForTests() === 0);
  });

  test("a re-acquire inside the linger window reuses the same Chrome", async () => {
    // Every turn boundary of a chat is a /close followed by the next tool call.
    // Cycling Chrome there would make the profile-lock race the normal path.
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");
    const pageA = (await acquirePage(a)) as FakePage;
    await releasePage(a, "manual");

    const pageB = (await acquirePage(b)) as FakePage;
    assert.equal(harness.persistentLaunches.length, 1, "relaunched inside the linger window");
    assert.equal(pageB.ctx, pageA.ctx);

    // Outlast the linger the release started, and confirm the re-acquire
    // cancelled it rather than merely outrunning it.
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(pageB.ctx.closed, false, "the linger timer closed a re-acquired profile");
  });

  test("shutdown closes every profile without waiting for the linger", async () => {
    await seedCompanyEmployee("acme", "ada");
    await seedCompanyEmployee("acme", "grace");
    const a = await seedSession("acme", "ada");
    const g = await seedSession("acme", "grace");
    const pageA = (await acquirePage(a)) as FakePage;
    const pageG = (await acquirePage(g)) as FakePage;

    await releaseAllPages("shutdown");

    assert.equal(pageA.ctx.closed, true);
    assert.equal(pageG.ctx.closed, true);
    assert.equal(liveProfileCountForTests(), 0);
  });

  test("a Chrome that dies under us releases its sessions and is not reused", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");
    const pageA = (await acquirePage(a)) as FakePage;
    await acquirePage(b);
    const ctx = pageA.ctx;

    // An OOM kill, a crash, an operator closing the window.
    await ctx.close();
    await waitFor(
      "the dead profile to leave the registry",
      () => liveProfileCountForTests() === 0,
    );

    const c = await seedSession("acme", "ada");
    const pageC = (await acquirePage(c)) as FakePage;
    assert.equal(harness.persistentLaunches.length, 2, "handed out the dead context");
    assert.notEqual(pageC.ctx, ctx);
  });
});

// ---------- popup attribution ----------

describe("popup attribution", () => {
  test("a popup goes to the session whose page opened it", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");
    const pageA = (await acquirePage(a)) as FakePage;
    const pageB = (await acquirePage(b)) as FakePage;

    const makePopup = (harness as unknown as {
      makePopup: (ctx: FakeContext, opener: FakePage) => FakePage;
    }).makePopup;
    const popup = makePopup(pageA.ctx, pageA);
    await waitFor("session A to adopt its own popup", () => (pageA.ctx.pagesList.includes(popup)));
    await new Promise((r) => setTimeout(r, 30));

    // A's tools follow the popup; B keeps driving its own window.
    assert.equal(await acquirePage(a), popup, "the opener's session did not adopt its popup");
    assert.equal(await acquirePage(b), pageB, "a sibling session was moved onto someone else's tab");
  });

  test("an openerless page is never adopted by anyone", async () => {
    // A restored tab, an extension page, a window we did not ask for. Adopting
    // it would point a model and a live viewer at a page nobody opened.
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const pageA = (await acquirePage(a)) as FakePage;

    pageA.ctx.emit("page", {
      ...pageA,
      openerPage: null,
      opener: async () => null,
      isClosed: () => false,
    });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(await acquirePage(a), pageA, "adopted a page with no opener");
  });
});

// ---------- the cookie snapshot ----------

describe("the cookie snapshot", () => {
  test("a brand-new profile is seeded from the existing snapshot", async () => {
    // Without this, shipping the persistent profile signs every employee out of
    // every site — and it reads as the sites breaking, not as an upgrade bug.
    await seedCompanyEmployee("acme", "ada");
    const file = employeeBrowserStateFile("acme", "ada");
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      file,
      JSON.stringify({
        cookies: [{ name: "sid", value: "abc", domain: ".x.com", path: "/" }],
        origins: [{ origin: "https://x.com", localStorage: [{ name: "k", value: "v" }] }],
      }),
      { mode: 0o600 },
    );

    const a = await seedSession("acme", "ada");
    const page = (await acquirePage(a)) as FakePage;

    assert.equal(page.ctx.addedCookies.length, 1);
    assert.deepEqual(
      (page.ctx.addedCookies[0] as { name: string }).name,
      "sid",
    );
  });

  test("an existing profile is not re-seeded", async () => {
    await seedCompanyEmployee("acme", "ada");
    const dir = employeeBrowserProfileDir("acme", "ada");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    // Chrome has written here before.
    await fs.writeFile(path.join(dir, "Local State"), "{}");
    const file = employeeBrowserStateFile("acme", "ada");
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      file,
      JSON.stringify({ cookies: [{ name: "stale", value: "1", domain: ".x.com", path: "/" }] }),
      { mode: 0o600 },
    );

    const a = await seedSession("acme", "ada");
    const page = (await acquirePage(a)) as FakePage;

    assert.equal(page.ctx.addedCookies.length, 0, "a stale snapshot overwrote the live profile");
  });

  test("is exported on teardown so the next session still sees the jar", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const page = (await acquirePage(a)) as FakePage;

    await releasePage(a, "manual");
    await waitFor(
      "the cookie jar to be exported",
      () => page.ctx.storageStateCalls > 0,
    );
  });

  test("is not exported when the context died under us", async () => {
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const page = (await acquirePage(a)) as FakePage;
    const before = page.ctx.storageStateCalls;

    await releasePage(a, "error");

    assert.equal(
      page.ctx.storageStateCalls,
      before,
      "overwrote the last good snapshot from a crashed context",
    );
  });
});

// ---------- fallback ----------

describe("fallback", () => {
  test("a Playwright without launchPersistentContext still works", async () => {
    await seedCompanyEmployee("acme", "ada");
    delete (harness.chromium as { launchPersistentContext?: unknown }).launchPersistentContext;
    const a = await seedSession("acme", "ada");
    const page = (await acquirePage(a)) as FakePage;
    assert.ok(page);
    assert.equal(harness.ephemeralLaunches, 1);
    assert.equal(harness.persistentLaunches.length, 0);
  });

  test("a profile we cannot open degrades instead of failing the Run", async () => {
    await seedCompanyEmployee("acme", "ada");
    harness.failPersistent = true;
    const a = await seedSession("acme", "ada");
    const page = (await acquirePage(a)) as FakePage;
    assert.ok(page, "a locked profile killed the browser tool outright");
    assert.equal(harness.ephemeralLaunches, 1);
  });

  test("the ephemeral fallback is still shared between sessions", async () => {
    await seedCompanyEmployee("acme", "ada");
    harness.failPersistent = true;
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");
    const pageA = (await acquirePage(a)) as FakePage;
    const pageB = (await acquirePage(b)) as FakePage;
    assert.equal(pageA.ctx, pageB.ctx);
    assert.equal(harness.ephemeralLaunches, 1);
  });
});

// ---------- context-wide wiring ----------

describe("context-wide wiring", () => {
  test("the request marker is installed once per profile, not once per session", async () => {
    // N sessions each registering `**/*` on one context retains a handler per
    // session for the life of the browser, including dead ones.
    await seedCompanyEmployee("acme", "ada");
    const a = await seedSession("acme", "ada");
    const b = await seedSession("acme", "ada");
    const pageA = (await acquirePage(a)) as FakePage;
    await acquirePage(b);
    assert.equal(pageA.ctx.routes.length, 1, "registered the route once per session");
  });
});
