import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { looksLikeAuthWall, runWithXBrowser } from "./x-browser.js";
import { ConnectionAuthError, type IntegrationRuntimeContext } from "../types.js";
import { readSessionHealth, recordBrowserBlock } from "../../services/browserConnectionHealth.js";
import { injectChromiumLauncherForTests } from "../../services/browserProfile.js";

/**
 * These exercise the browser-login driver end to end against a fake
 * Playwright: launch options, which cookie jar it reaches for and in what
 * order, what it records when a site walls it off, and what it refuses to
 * do twice.
 *
 * The fake is deliberately literal about the Playwright surface the driver
 * touches — if the driver starts calling something new, the fake breaks
 * loudly rather than silently passing.
 */

// ---------- fake playwright ----------

type LaunchRecord = {
  options: Record<string, unknown>;
  contexts: ContextRecord[];
  closed: boolean;
};

type ContextRecord = {
  options: Record<string, unknown>;
  initScripts: string[];
  closed: boolean;
  storageStateOut: unknown;
};

type PageScript = {
  /** Whether `/home` shows a signed-in shell for this context. */
  loggedIn: boolean;
  /** Pins the URL the page reports, whatever it navigates to. Drives the
   * auth-wall detection; leave unset to let navigation behave normally. */
  url?: string;
  /** When set, the login form never renders — X served an interstitial. */
  loginError?: string;
  /** When true, X shows the "unusual activity" verification input. */
  verificationPrompt?: boolean;
  /** When true, the credential login never reaches /home. */
  loginNeverCompletes?: boolean;
};

class FakePlaywright {
  launches: LaunchRecord[] = [];
  /** One entry per context created, consumed in order. */
  scripts: PageScript[] = [];
  /** Records the storageState each context was created with. */
  restored: unknown[] = [];
  /** What every context reports back from `storageState()`. */
  storageStateOut: unknown = {
    cookies: [{ name: "auth_token", domain: ".x.com", path: "/", value: "fresh" }],
    origins: [],
  };

  constructor(scripts: PageScript[]) {
    this.scripts = [...scripts];
  }

  get chromium() {
    return {
      launch: async (options: Record<string, unknown>) => {
        const record: LaunchRecord = { options, contexts: [], closed: false };
        this.launches.push(record);
        return this.makeBrowser(record);
      },
    };
  }

  private makeBrowser(record: LaunchRecord) {
    return {
      newContext: async (options: Record<string, unknown>) => {
        const script = this.scripts.shift() ?? { loggedIn: true };
        this.restored.push(options.storageState);
        const ctx: ContextRecord = {
          options,
          initScripts: [],
          closed: false,
          storageStateOut: this.storageStateOut,
        };
        record.contexts.push(ctx);
        return this.makeContext(ctx, script);
      },
      close: async () => {
        record.closed = true;
      },
    };
  }

  private makeContext(ctx: ContextRecord, script: PageScript) {
    return {
      addInitScript: async (s: { content: string }) => {
        ctx.initScripts.push(s.content);
      },
      newPage: async () => this.makePage(script),
      storageState: async () => ctx.storageStateOut,
      close: async () => {
        ctx.closed = true;
      },
    };
  }

  /**
   * Models enough of x.com to drive the real code path: the compose button
   * only appears when signed in, the verification input only when the
   * script says X is challenging us, and a credential login lands on /home
   * once the password goes in.
   */
  private makePage(script: PageScript) {
    let currentUrl = script.url ?? "https://x.com/home";
    const navigate = (url: string): void => {
      currentUrl = script.url ?? url;
    };
    const isVisible = (selector: string): boolean => {
      if (selector.includes("ocfEnterTextTextInput")) return script.verificationPrompt === true;
      if (selector.includes("role=\"alert\"") || selector.includes('[data-testid="error"]')) {
        return false;
      }
      // Compose button, like/retweet controls, follow buttons: all of them
      // are only there for a signed-in session.
      return script.loggedIn;
    };
    return {
      goto: async (url: string) => {
        navigate(url);
        return undefined;
      },
      waitForSelector: async (_sel: string) => {
        if (script.loginError) throw new Error(script.loginError);
        return undefined;
      },
      fill: async (selector: string) => {
        // Submitting the password is what advances X to the timeline.
        if (selector.includes("password") && !script.loginNeverCompletes) {
          navigate("https://x.com/home");
        }
        return undefined;
      },
      click: async () => undefined,
      url: () => currentUrl,
      locator: (selector: string) => ({
        first: () => ({
          waitFor: async () => undefined,
          click: async () => undefined,
          fill: async () => undefined,
          press: async () => undefined,
          textContent: async () => "",
          isVisible: async () => isVisible(selector),
        }),
        count: async () => (isVisible(selector) ? 1 : 0),
      }),
      keyboard: { press: async () => undefined, type: async () => undefined },
      evaluate: async () => undefined,
      waitForLoadState: async () => undefined,
      waitForTimeout: async () => undefined,
      close: async () => undefined,
    };
  }
}

/**
 * The driver reaches Chromium through `browserProfile.loadChromiumLauncher`,
 * which carries a test seam for exactly this — see
 * `injectChromiumLauncherForTests`. Every test clears it again in `t.after`.
 */
function installFakePlaywright(fake: FakePlaywright): void {
  injectChromiumLauncherForTests(fake.chromium);
}

function restorePlaywright(): void {
  injectChromiumLauncherForTests(null);
}

// ---------- helpers ----------

type SharedJar = {
  state: unknown;
  loads: number;
  saves: unknown[];
  /** Domain scopes the driver asked the host to clip to. */
  loadDomains: string[][];
  saveDomains: string[][];
};

function makeCtx(opts: { shared?: SharedJar; config: Record<string, unknown> }): {
  ctx: IntegrationRuntimeContext;
  persisted: () => Record<string, unknown>;
} {
  let current = opts.config;
  const ctx: IntegrationRuntimeContext = {
    authMode: "browser",
    config: current,
    setConfig(next) {
      current = next as Record<string, unknown>;
    },
    employeeId: "emp-1",
    companyId: "co-1",
  };
  if (opts.shared) {
    const jar = opts.shared;
    ctx.sharedBrowserState = {
      async load(domains) {
        jar.loads += 1;
        jar.loadDomains.push(domains);
        return jar.state;
      },
      async save(state, domains) {
        jar.saves.push(state);
        jar.saveDomains.push(domains);
        jar.state = state;
      },
    };
  }
  return { ctx, persisted: () => current };
}

const CREDENTIALS = { username: "oneuptimehq", password: "hunter2" };

/** The bits of the page an action needs to simulate a mid-flight bounce. */
type ActionPage = { goto(url: string): Promise<unknown>; url(): string };

async function runDriver(args: {
  fake: FakePlaywright;
  ctx: IntegrationRuntimeContext;
  config: Record<string, unknown>;
  action?: (page: ActionPage) => Promise<string>;
}): Promise<string> {
  return runWithXBrowser({
    cfg: args.config as never,
    ctx: args.ctx,
    action: async (page) =>
      args.action ? args.action(page as unknown as ActionPage) : "posted",
  });
}

const SIGNED_IN_STATE = { cookies: [{ name: "auth_token", value: "human" }], origins: [] };

describe("looksLikeAuthWall", () => {
  test("recognises X's login, challenge and 2FA URLs", () => {
    for (const url of [
      "https://x.com/i/flow/login",
      "https://x.com/login",
      "https://x.com/i/flow/two_factor",
      "https://x.com/account/access",
      "https://x.com/challenge/abc",
    ]) {
      assert.equal(looksLikeAuthWall(url), true, url);
    }
  });

  test("leaves ordinary pages alone", () => {
    for (const url of [
      "https://x.com/home",
      "https://x.com/oneuptimehq",
      "https://x.com/i/web/status/1",
    ]) {
      assert.equal(looksLikeAuthWall(url), false, url);
    }
  });
});

describe("runWithXBrowser — disguise", () => {
  test("launches with the shared desktop-Chrome profile, not a Genosyn user agent", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS, storageStateJson: JSON.stringify(SIGNED_IN_STATE) };
    const { ctx } = makeCtx({ config });

    await runDriver({ fake, ctx, config });

    const launch = fake.launches[0];
    assert.ok(
      (launch.options.args as string[]).includes("--disable-blink-features=AutomationControlled"),
      "the automation tell must be stripped",
    );
    const contextOptions = launch.contexts[0].options;
    const ua = String(contextOptions.userAgent);
    assert.match(ua, /Chrome\/\d+/);
    assert.doesNotMatch(ua, /Genosyn/, "the driver must not announce itself to the site");
    assert.doesNotMatch(ua, /Headless/);
    const headers = contextOptions.extraHTTPHeaders as Record<string, string>;
    assert.match(headers["sec-ch-ua"], /Google Chrome/);
    // The webdriver mask has to be installed before the page loads.
    assert.equal(launch.contexts[0].initScripts.length, 1);
    assert.match(launch.contexts[0].initScripts[0], /webdriver/);
  });

  test("always closes the browser, even when the action throws", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS, storageStateJson: JSON.stringify(SIGNED_IN_STATE) };
    const { ctx } = makeCtx({ config });

    await assert.rejects(
      runDriver({
        fake,
        ctx,
        config,
        action: async () => {
          throw new Error("compose box moved");
        },
      }),
      /compose box moved/,
    );
    assert.equal(fake.launches[0].closed, true);
  });
});

describe("runWithXBrowser — where the session comes from", () => {
  test("uses the connection's own cookies when they still work", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const jar: SharedJar = { state: SIGNED_IN_STATE, loads: 0, saves: [], loadDomains: [], saveDomains: [] };
    const connectionState = { cookies: [{ name: "auth_token", value: "own" }], origins: [] };
    const config = { ...CREDENTIALS, storageStateJson: JSON.stringify(connectionState) };
    const { ctx, persisted } = makeCtx({ config, shared: jar });

    const result = await runDriver({ fake, ctx, config });

    assert.equal(result, "posted");
    assert.deepEqual(fake.restored[0], connectionState);
    assert.equal(fake.launches[0].contexts.length, 1, "no fallback context should be opened");
    assert.equal(readSessionHealth(persisted()).state, "ok");
  });

  /**
   * The scenario from the bug report: the connection's cookies are dead, but
   * a human just signed into X by hand in the live browser panel. That
   * session is the whole point of the handoff — the driver has to reach for
   * it before driving a credential login that will hit the same captcha.
   */
  test("falls back to the session a human established in the live browser", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([
      { loggedIn: false, url: "https://x.com/i/flow/login" }, // connection cookies are dead
      { loggedIn: true }, // the human's session works
    ]);
    installFakePlaywright(fake);
    const jar: SharedJar = { state: SIGNED_IN_STATE, loads: 0, saves: [], loadDomains: [], saveDomains: [] };
    const connectionState = { cookies: [{ name: "auth_token", value: "stale" }], origins: [] };
    const config = { ...CREDENTIALS, storageStateJson: JSON.stringify(connectionState) };
    const { ctx, persisted } = makeCtx({ config, shared: jar });

    const result = await runDriver({ fake, ctx, config });

    assert.equal(result, "posted");
    assert.equal(jar.loads, 1);
    assert.deepEqual(fake.restored[0], connectionState);
    assert.deepEqual(fake.restored[1], SIGNED_IN_STATE, "must retry with the human's session");
    assert.equal(fake.launches[0].contexts[0].closed, true, "the dead context is cleaned up");
    assert.equal(readSessionHealth(persisted()).state, "ok");
    // We took the session from the shared jar, so rewriting it is churn.
    assert.equal(jar.saves.length, 0);
  });

  /**
   * The jar holds every site the employee browses, and what this driver
   * persists lands on a Connection row other employees may hold a Grant on.
   * Both directions have to be clipped to X.
   */
  test("only X's cookies cross between the connection and the employee's jar", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    // The live context ends up holding cookies for several sites, the way a
    // real shared jar would.
    fake.storageStateOut = {
      cookies: [
        { name: "auth_token", domain: ".x.com", path: "/", value: "x" },
        { name: "SID", domain: ".google.com", path: "/", value: "g" },
      ],
      origins: [
        { origin: "https://x.com", localStorage: [] },
        { origin: "https://mail.google.com", localStorage: [] },
      ],
    };
    installFakePlaywright(fake);
    const jar: SharedJar = { state: undefined, loads: 0, saves: [], loadDomains: [], saveDomains: [] };
    const config = { ...CREDENTIALS };
    const { ctx, persisted } = makeCtx({ config, shared: jar });

    await runDriver({ fake, ctx, config });

    // Nothing but X reaches the Connection row.
    const stored = JSON.parse(String(persisted().storageStateJson)) as {
      cookies: Array<{ name: string }>;
      origins: Array<{ origin: string }>;
    };
    assert.deepEqual(stored.cookies.map((c) => c.name), ["auth_token"]);
    assert.deepEqual(stored.origins.map((o) => o.origin), ["https://x.com"]);

    // And the driver asks the host to scope both directions for it.
    assert.deepEqual(jar.saveDomains[0], ["x.com", "twitter.com"]);
    assert.deepEqual(jar.loadDomains[0], ["x.com", "twitter.com"]);
  });

  test("a login the driver managed itself is pushed back to the shared jar", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const jar: SharedJar = { state: undefined, loads: 0, saves: [], loadDomains: [], saveDomains: [] };
    const config = { ...CREDENTIALS };
    const { ctx } = makeCtx({ config, shared: jar });

    await runDriver({ fake, ctx, config });

    assert.equal(jar.saves.length, 1, "the employee should not have to sign in again separately");
    assert.deepEqual(jar.saves[0], {
      cookies: [{ name: "auth_token", domain: ".x.com", path: "/", value: "fresh" }],
      origins: [],
    });
  });

  test("works with no shared jar at all (a routine with no browser access)", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS, storageStateJson: JSON.stringify(SIGNED_IN_STATE) };
    const { ctx, persisted } = makeCtx({ config });

    assert.equal(await runDriver({ fake, ctx, config }), "posted");
    assert.equal(readSessionHealth(persisted()).state, "ok");
  });

  test("a shared jar that throws on read is an optimisation lost, not a failure", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS };
    const { ctx } = makeCtx({ config });
    ctx.sharedBrowserState = {
      load: async () => {
        throw new Error("disk gone");
      },
      save: async () => {
        throw new Error("disk gone");
      },
    };

    assert.equal(await runDriver({ fake, ctx, config }), "posted");
  });

  test("corrupt cached cookies fall through to a login instead of crashing", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS, storageStateJson: "{not json" };
    const { ctx } = makeCtx({ config });

    assert.equal(await runDriver({ fake, ctx, config }), "posted");
    assert.equal(fake.restored[0], undefined);
  });
});

describe("runWithXBrowser — being blocked", () => {
  test("a captcha at the login page is classified, recorded and explained", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([
      { loggedIn: false, url: "https://x.com/i/flow/login", loginError: "no username field" },
    ]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS };
    const { ctx, persisted } = makeCtx({ config });

    const err = await runDriver({ fake, ctx, config }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ConnectionAuthError, "must be a connection-level failure");
    assert.match(err.message, /did not render the username field/);
    assert.match(err.message, /does not solve captchas/i);
    assert.match(err.message, /Take over/);
    assert.equal(err.connectionStatus, "error");

    // Recorded on the config so the next call and the UI both see it.
    const health = readSessionHealth(persisted());
    assert.equal(health.state, "blocked");
    assert.equal(health.reason, "captcha");
    assert.equal(health.failures, 1);
    assert.ok((health.retryAfter ?? 0) > Date.now());
  });

  test("the cooldown refuses a second login attempt without launching a browser", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([]);
    installFakePlaywright(fake);
    const config = {
      ...CREDENTIALS,
      sessionHealth: recordBrowserBlock({
        previous: undefined,
        error: new Error("X login page did not render the username field."),
        now: Date.now(),
      }),
    };
    const { ctx } = makeCtx({ config });

    const err = await runDriver({ fake, ctx, config }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ConnectionAuthError);
    assert.match(err.message, /will not retry the sign-in on its own/);
    assert.equal(fake.launches.length, 0, "hammering a blocked login hardens the block");
  });

  test("once the cooldown lapses the driver tries again", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const stale = recordBrowserBlock({
      previous: undefined,
      error: new Error("captcha"),
      now: Date.now() - 10 * 60_000,
    });
    const config = { ...CREDENTIALS, sessionHealth: stale };
    const { ctx, persisted } = makeCtx({ config });

    assert.equal(await runDriver({ fake, ctx, config }), "posted");
    assert.equal(fake.launches.length, 1);
    assert.equal(readSessionHealth(persisted()).state, "ok", "success clears the block");
  });

  test("an expired session is reported as expired, not broken", async (t) => {
    t.after(restorePlaywright);
    // Signed-in enough to pass the probe, then bounced to login mid-action
    // with a "logged out" message — a lapsed session, not a wall.
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS, storageStateJson: JSON.stringify(SIGNED_IN_STATE) };
    const { ctx } = makeCtx({ config });

    const err = (await runDriver({
      fake,
      ctx,
      config,
      action: async (page) => {
        await page.goto("https://x.com/i/flow/login");
        throw new Error("The session expired and the account was logged out");
      },
    }).catch((e: unknown) => e)) as ConnectionAuthError;

    assert.ok(err instanceof ConnectionAuthError);
    assert.equal(err.connectionStatus, "expired");
    // An expired session is worth another automatic attempt; a captcha is not.
    assert.match(err.message, /retries automatically/);
  });

  test("an unusual-activity check with no stored verification value is named as such", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: false, verificationPrompt: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS };
    const { ctx, persisted } = makeCtx({ config });

    const err = (await runDriver({ fake, ctx, config }).catch(
      (e: unknown) => e,
    )) as ConnectionAuthError;

    assert.ok(err instanceof ConnectionAuthError);
    assert.equal(readSessionHealth(persisted()).reason, "verification_required");
    assert.match(err.message, /Add a Verification value/);
  });

  test("an unusual-activity check clears when the connection carries a verification value", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: false, verificationPrompt: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS, verification: "ops@example.com" };
    const { ctx, persisted } = makeCtx({ config });

    assert.equal(await runDriver({ fake, ctx, config }), "posted");
    assert.equal(readSessionHealth(persisted()).state, "ok");
  });

  test("a mid-action bounce to the login page is treated as a connection failure", async (t) => {
    t.after(restorePlaywright);
    // The cheap probe passes, but X bounces us to the login page while the
    // action is running — the session died under us.
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS, storageStateJson: JSON.stringify(SIGNED_IN_STATE) };
    const { ctx, persisted } = makeCtx({ config });

    const err = await runDriver({
      fake,
      ctx,
      config,
      action: async (page) => {
        await page.goto("https://x.com/i/flow/login");
        throw new Error("Timeout waiting for selector tweetTextarea_0");
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ConnectionAuthError);
    assert.equal(readSessionHealth(persisted()).state, "blocked");
  });

  test("an ordinary tool failure stays an ordinary tool failure", async (t) => {
    t.after(restorePlaywright);
    const fake = new FakePlaywright([{ loggedIn: true }]);
    installFakePlaywright(fake);
    const config = { ...CREDENTIALS, storageStateJson: JSON.stringify(SIGNED_IN_STATE) };
    const { ctx, persisted } = makeCtx({ config });

    const err = await runDriver({
      fake,
      ctx,
      config,
      action: async () => {
        throw new Error("tweet is over 280 characters");
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(!(err instanceof ConnectionAuthError), "must not blame the connection");
    assert.equal(
      readSessionHealth(persisted()).state,
      "unknown",
      "a bad argument should not mark the session blocked",
    );
  });

  test("a browser that will not launch is reported as a deployment problem", async (t) => {
    t.after(restorePlaywright);
    injectChromiumLauncherForTests({
      launch: async () => {
        throw new Error(
          "playwright-core is not installed: Cannot find module. Browser-login connections require the App container to bundle Chromium.",
        );
      },
    });
    const config = { ...CREDENTIALS };
    const { ctx, persisted } = makeCtx({ config });

    const err = await runWithXBrowser({
      cfg: config as never,
      ctx,
      action: async () => "never",
    }).then(
      () => null,
      (e: unknown) => e,
    );

    assert.ok(err instanceof ConnectionAuthError);
    assert.match(err.message, /browser is not available/);
    assert.equal(readSessionHealth(persisted()).reason, "unavailable");
  });
});
