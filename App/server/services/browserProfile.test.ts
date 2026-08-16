import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import {
  browserIdentity,
  chromeContextOptions,
  chromeMaskInitScript,
  chromiumLaunchOptions,
  injectBrowserIdentityForTests,
  parseBrowserVersion,
  secChUaFor,
  spoofedUserAgentFor,
  type BrowserIdentity,
} from "./browserProfile.js";

/**
 * The profile's whole job is to not contradict itself. These tests are written
 * against the specific contradictions the previous version shipped, because
 * every one of them is a documented bot-detection probe and every one of them
 * is a plausible thing to reintroduce by accident:
 *
 *   * a macOS user agent on a Linux browser,
 *   * `Sec-CH-UA-Platform` disagreeing with the user agent,
 *   * a user agent carrying a full build number Chrome stopped sending,
 *   * `navigator.webdriver` forced to `undefined` rather than `false`,
 *   * patched getters that print their own source when asked.
 */

function identity(overrides: Partial<BrowserIdentity> = {}): BrowserIdentity {
  return {
    executablePath: "/usr/bin/google-chrome-stable",
    isRealChrome: true,
    major: 141,
    versionString: "Google Chrome 141.0.7390.54",
    platform: "linux",
    headed: true,
    ...overrides,
  };
}

afterEach(() => {
  injectBrowserIdentityForTests(null);
});

describe("parseBrowserVersion", () => {
  test("recognises real Google Chrome", () => {
    const parsed = parseBrowserVersion("Google Chrome 141.0.7390.54");
    assert.equal(parsed.isRealChrome, true);
    assert.equal(parsed.major, 141);
  });

  test("recognises Chromium as not-Chrome", () => {
    const parsed = parseBrowserVersion("Chromium 120.0.6099.109");
    assert.equal(parsed.isRealChrome, false);
    assert.equal(parsed.major, 120);
  });

  test("falls back to assuming Chromium when the binary says nothing", () => {
    // Assuming less is the safe direction: a needless mask costs little, a
    // missing one costs a block.
    assert.equal(parseBrowserVersion("").isRealChrome, false);
    assert.equal(parseBrowserVersion("not a browser").isRealChrome, false);
  });

  test("keeps a plausible major version when parsing fails", () => {
    assert.ok(parseBrowserVersion("").major > 100);
  });
});

describe("spoofedUserAgentFor", () => {
  test("real headed Chrome claims nothing at all", () => {
    assert.equal(spoofedUserAgentFor(identity()), null);
  });

  test("headless real Chrome hides the HeadlessChrome token", () => {
    const ua = spoofedUserAgentFor(identity({ headed: false }));
    assert.ok(ua);
    assert.doesNotMatch(ua, /Headless/i);
  });

  test("bare Chromium claims Chrome", () => {
    const ua = spoofedUserAgentFor(identity({ isRealChrome: false, major: 120 }));
    assert.ok(ua);
    assert.match(ua, /Chrome\/120\.0\.0\.0/);
    assert.doesNotMatch(ua, /Chromium/);
  });

  test("uses the frozen build number modern Chrome actually sends", () => {
    // The old profile claimed `Chrome/134.0.6998.166`. Chrome's user agent
    // reduction stopped sending real build numbers, so that was an anomaly in
    // its own right.
    const ua = spoofedUserAgentFor(identity({ headed: false }));
    assert.ok(ua);
    assert.match(ua, /Chrome\/\d+\.0\.0\.0 Safari/);
  });

  test("the platform token matches the platform the browser runs on", () => {
    const linux = spoofedUserAgentFor(identity({ isRealChrome: false, platform: "linux" }));
    const macos = spoofedUserAgentFor(identity({ isRealChrome: false, platform: "macos" }));
    const windows = spoofedUserAgentFor(identity({ isRealChrome: false, platform: "windows" }));
    assert.match(String(linux), /X11; Linux x86_64/);
    assert.match(String(macos), /Macintosh; Intel Mac OS X/);
    assert.match(String(windows), /Windows NT 10\.0; Win64; x64/);
  });
});

describe("chromeContextOptions", () => {
  test("real headed Chrome overrides no part of its identity", async () => {
    injectBrowserIdentityForTests(identity());
    const options = await chromeContextOptions();
    assert.equal(options.userAgent, undefined);
    assert.equal(options.extraHTTPHeaders, undefined);
    // Headed Chrome paints into a real window; forcing a viewport desyncs the
    // page from the window it lives in.
    assert.equal(options.viewport, null);
  });

  test("headless gets an explicit viewport, since it has no window", async () => {
    injectBrowserIdentityForTests(identity({ headed: false }));
    const options = await chromeContextOptions();
    const viewport = options.viewport as { width: number; height: number };
    assert.ok(viewport.width > 0 && viewport.height > 0);
  });

  test("client hints agree with the user agent on every platform", async () => {
    const expected = {
      linux: { ua: /X11; Linux x86_64/, ch: '"Linux"' },
      macos: { ua: /Macintosh/, ch: '"macOS"' },
      windows: { ua: /Windows NT/, ch: '"Windows"' },
    } as const;

    for (const platform of ["linux", "macos", "windows"] as const) {
      injectBrowserIdentityForTests(identity({ isRealChrome: false, platform }));
      const options = await chromeContextOptions();
      const headers = options.extraHTTPHeaders as Record<string, string>;
      assert.match(String(options.userAgent), expected[platform].ua);
      assert.equal(headers["sec-ch-ua-platform"], expected[platform].ch);
    }
  });

  test("the Sec-CH-UA brand version matches the user agent version", async () => {
    injectBrowserIdentityForTests(identity({ isRealChrome: false, major: 133 }));
    const options = await chromeContextOptions();
    const headers = options.extraHTTPHeaders as Record<string, string>;
    assert.match(String(options.userAgent), /Chrome\/133\.0\.0\.0/);
    assert.match(headers["sec-ch-ua"], /"Google Chrome";v="133"/);
  });
});

describe("secChUaFor", () => {
  test("always includes a Google Chrome brand", () => {
    // Sites that key off Client Hints rather than the user agent string read
    // this list; a Chrome claim with no Chrome brand is a contradiction.
    assert.match(secChUaFor(identity({ major: 141 })), /"Google Chrome";v="141"/);
  });
});

describe("chromeMaskInitScript", () => {
  test("is empty on real headed Chrome", async () => {
    injectBrowserIdentityForTests(identity());
    assert.equal(await chromeMaskInitScript(), "");
  });

  test("runs on bare Chromium", async () => {
    injectBrowserIdentityForTests(identity({ isRealChrome: false }));
    assert.ok((await chromeMaskInitScript()).length > 0);
  });

  test("reports navigator.webdriver as false, never undefined", async () => {
    injectBrowserIdentityForTests(identity({ isRealChrome: false }));
    const script = await chromeMaskInitScript();
    assert.match(script, /'webdriver',\s*\(\)\s*=>\s*false/);
    assert.doesNotMatch(script, /webdriver[\s\S]{0,80}=>\s*undefined/);
  });

  test("makes its own patches print as native code", async () => {
    injectBrowserIdentityForTests(identity({ isRealChrome: false }));
    const script = await chromeMaskInitScript();
    assert.match(script, /\[native code\]/);
    assert.match(script, /Function\.prototype\.toString = patchedToString/);
  });

  test("patches Notification.permission and permissions.query together", async () => {
    injectBrowserIdentityForTests(identity({ isRealChrome: false }));
    const script = await chromeMaskInitScript();
    // Patching one and not the other invents `denied` + `prompt`, a pairing
    // that occurs in no real browser.
    assert.match(script, /'permission',\s*\(\)\s*=>\s*'default'/);
    assert.match(script, /state:\s*'prompt'/);
  });

  test("keeps navigator.platform consistent with the claimed user agent", async () => {
    injectBrowserIdentityForTests(identity({ isRealChrome: false, platform: "linux" }));
    const script = await chromeMaskInitScript();
    assert.match(script, /'platform'/);
    assert.match(script, /Linux x86_64/);
  });
});

describe("chromiumLaunchOptions", () => {
  test("headed identity launches with a window", async () => {
    injectBrowserIdentityForTests(identity({ headed: true }));
    assert.equal((await chromiumLaunchOptions()).headless, false);
  });

  test("headless identity launches headless", async () => {
    injectBrowserIdentityForTests(identity({ headed: false }));
    assert.equal((await chromiumLaunchOptions()).headless, true);
  });

  test("drops the automation switch that sets navigator.webdriver", async () => {
    injectBrowserIdentityForTests(identity());
    const options = await chromiumLaunchOptions();
    assert.deepEqual(options.ignoreDefaultArgs, ["--enable-automation"]);
    assert.ok(
      (options.args as string[]).includes("--disable-blink-features=AutomationControlled"),
    );
  });

  test("passes the detected executable through", async () => {
    injectBrowserIdentityForTests(identity({ executablePath: "/opt/google/chrome/chrome" }));
    assert.equal((await chromiumLaunchOptions()).executablePath, "/opt/google/chrome/chrome");
  });
});

describe("browserIdentity", () => {
  test("returns the injected identity without probing a binary", async () => {
    injectBrowserIdentityForTests(identity({ versionString: "Google Chrome 200.0.0.0" }));
    const resolved = await browserIdentity();
    assert.equal(resolved.versionString, "Google Chrome 200.0.0.0");
  });
});
