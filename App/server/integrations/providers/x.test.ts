import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { xProvider } from "./x.js";
import { recordBrowserBlock, recordBrowserSessionOk } from "../../services/browserConnectionHealth.js";
import { injectChromiumLauncherForTests } from "../../services/browserProfile.js";
import type { IntegrationRuntimeContext } from "../types.js";

/**
 * A launcher that refuses to start, so tests can tell "the provider tried
 * to drive a browser" apart from "the provider rejected this before
 * launching" without a real Chromium anywhere near the suite.
 */
const LAUNCH_ATTEMPTED = "fake-chromium-launch-attempted";

function stubLauncher(): void {
  injectChromiumLauncherForTests({
    launch: async () => {
      throw new Error(LAUNCH_ATTEMPTED);
    },
  });
}

function restoreLauncher(): void {
  injectChromiumLauncherForTests(null);
}

/**
 * The X provider is the one integration that offers both a real API and a
 * browser-driven fallback, and the gap between them is what produced the
 * bug these tests guard: an employee saw the full OAuth tool list on a
 * browser-login connection, concluded it had a "direct integration", and
 * promised there would be no login page.
 */

const BROWSER_CREDENTIALS = { username: "oneuptimehq", password: "hunter2" };

function browserCtx(config: Record<string, unknown>): IntegrationRuntimeContext {
  return {
    authMode: "browser",
    config,
    setConfig() {
      /* not used by the paths under test */
    },
  };
}

describe("supportsTool", () => {
  test("browser mode advertises only what the web UI can actually drive", () => {
    const supported = xProvider.tools
      .map((t) => t.name)
      .filter((name) => xProvider.supportsTool!(name, "browser"));
    assert.deepEqual(supported.sort(), [
      "delete_tweet",
      "follow_user",
      "get_me",
      "like_tweet",
      "post_tweet",
      "retweet",
      "unfollow_user",
      "unlike_tweet",
    ]);
  });

  test("the API-only tools are hidden from browser connections", () => {
    for (const name of [
      "search_recent",
      "get_home_timeline",
      "get_user_tweets",
      "get_tweet",
      "get_user_by_username",
      "send_dm",
      "list_dm_events",
      "list_dm_conversations",
      "unretweet",
    ]) {
      assert.equal(xProvider.supportsTool!(name, "browser"), false, name);
    }
  });

  test("OAuth connections keep the full list", () => {
    for (const tool of xProvider.tools) {
      assert.equal(xProvider.supportsTool!(tool.name, "oauth2"), true, tool.name);
    }
  });

  /**
   * The set above must match what `invokeTool` actually implements — a tool
   * advertised with no implementation behind it is the same lie in a
   * different place.
   */
  test("every advertised browser tool reaches the driver, not the unsupported branch", async (t) => {
    t.after(restoreLauncher);
    stubLauncher();
    // Arguments each tool needs before it will even try to drive a browser.
    const args: Record<string, Record<string, unknown>> = {
      post_tweet: { text: "hello" },
      delete_tweet: { tweetId: "1" },
      like_tweet: { tweetId: "1" },
      unlike_tweet: { tweetId: "1" },
      retweet: { tweetId: "1" },
      follow_user: { handle: "jack" },
      unfollow_user: { handle: "jack" },
    };
    for (const tool of xProvider.tools) {
      if (!xProvider.supportsTool!(tool.name, "browser")) continue;
      if (tool.name === "get_me") continue; // answered from the health record

      const err = await xProvider
        .invokeTool(tool.name, args[tool.name] ?? {}, browserCtx({ ...BROWSER_CREDENTIALS }))
        .then(() => null, (e: unknown) => e);

      assert.ok(err instanceof Error, `${tool.name} should have thrown something`);
      assert.match(
        err.message,
        new RegExp(LAUNCH_ATTEMPTED),
        `${tool.name} is advertised in browser mode but never reaches the browser driver`,
      );
    }
  });

  test("an unadvertised tool invoked anyway explains where to get it", async () => {
    const err = await xProvider
      .invokeTool("search_recent", { query: "genosyn" }, browserCtx({ ...BROWSER_CREDENTIALS }))
      .then(() => null, (e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /not available on browser-login/);
    assert.match(err.message, /official API/);
  });
});

describe("describeAuthMode", () => {
  test("browser connections carry a caveat the model cannot miss", () => {
    const note = xProvider.describeAuthMode!("browser");
    assert.ok(note);
    assert.match(note, /not the X API/);
    assert.match(note, /captcha/i);
    // The specific instruction that would have prevented the bad promise.
    assert.match(note, /never promise this path avoids a login page/);
    // And the one that would have prevented the pointless retry.
    assert.match(note, /instead of\s+retrying/);
  });

  test("API connections get no caveat", () => {
    assert.equal(xProvider.describeAuthMode!("oauth2"), undefined);
  });
});

describe("checkStatus for browser connections", () => {
  test("missing credentials are still an error", async () => {
    const result = await xProvider.checkStatus!(browserCtx({ username: "", password: "" }));
    assert.equal(result.ok, false);
    assert.match(result.message!, /Missing username or password/);
  });

  test("a never-used connection is not reported as broken", async () => {
    const result = await xProvider.checkStatus!(browserCtx({ ...BROWSER_CREDENTIALS }));
    assert.equal(result.ok, true);
  });

  test("a healthy session reports connected", async () => {
    const result = await xProvider.checkStatus!(
      browserCtx({ ...BROWSER_CREDENTIALS, sessionHealth: recordBrowserSessionOk(Date.now()) }),
    );
    assert.equal(result.ok, true);
  });

  /**
   * The regression that started this: credentials were present, so the UI
   * said "Connected" while every post failed at a captcha.
   */
  test("a blocked session reports the block instead of claiming Connected", async () => {
    const result = await xProvider.checkStatus!(
      browserCtx({
        ...BROWSER_CREDENTIALS,
        sessionHealth: recordBrowserBlock({
          previous: undefined,
          error: new Error("X login page did not render the username field."),
          now: Date.now(),
        }),
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "error");
    assert.match(result.message!, /did not render the username field/);
    assert.match(result.message!, /does not solve captchas/i);
  });

  test("a merely lapsed session is 'expired', not 'error'", async () => {
    const result = await xProvider.checkStatus!(
      browserCtx({
        ...BROWSER_CREDENTIALS,
        sessionHealth: recordBrowserBlock({
          previous: undefined,
          error: new Error("session expired"),
          now: Date.now(),
        }),
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.status, "expired");
  });
});

describe("get_me on a browser connection", () => {
  test("reports the real session state rather than echoing the stored handle", async () => {
    const signedInAt = Date.now() - 60_000;
    const result = (await xProvider.invokeTool(
      "get_me",
      {},
      browserCtx({ ...BROWSER_CREDENTIALS, sessionHealth: recordBrowserSessionOk(signedInAt) }),
    )) as Record<string, unknown>;

    assert.equal(result.username, "oneuptimehq");
    assert.equal(result.authMode, "browser");
    const session = result.session as Record<string, unknown>;
    assert.equal(session.state, "ok");
    assert.equal(session.lastSignedInAt, new Date(signedInAt).toISOString());
  });

  /**
   * The preflight in the bug report. `x_get_me` returned a handle, the
   * employee read that as "the account is reachable", and the very next
   * call failed. Now the preflight itself carries the bad news.
   */
  test("a blocked session is visible at preflight, before anything is published", async () => {
    const result = (await xProvider.invokeTool(
      "get_me",
      {},
      browserCtx({
        ...BROWSER_CREDENTIALS,
        sessionHealth: recordBrowserBlock({
          previous: undefined,
          error: new Error("X login page did not render the username field."),
          now: Date.now(),
        }),
      }),
    )) as Record<string, unknown>;

    const session = result.session as Record<string, unknown>;
    assert.equal(session.state, "blocked");
    assert.equal(session.reason, "captcha");
    assert.match(String(session.detail), /does not solve captchas/i);
    assert.equal(session.lastSignedInAt, null);
  });

  test("does not launch a browser — a preflight has to stay cheap", async () => {
    // No Chromium is injected here; if `get_me` tried to launch one this
    // would throw or hang instead of returning.
    const result = (await xProvider.invokeTool(
      "get_me",
      {},
      browserCtx({ ...BROWSER_CREDENTIALS }),
    )) as Record<string, unknown>;
    assert.equal((result.session as Record<string, unknown>).state, "unknown");
  });

  test("a connection missing its credentials fails as a connection problem", async () => {
    const err = await xProvider
      .invokeTool("get_me", {}, browserCtx({ username: "", password: "" }))
      .then(() => null, (e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.equal(err.name, "ConnectionAuthError");
    assert.match(err.message, /reconnect from Settings/i);
  });
});

describe("follow_user across auth modes", () => {
  test("the schema accepts either a userId or a handle", () => {
    for (const name of ["follow_user", "unfollow_user"]) {
      const tool = xProvider.tools.find((t) => t.name === name)!;
      assert.ok(tool.inputSchema.properties.handle, `${name} must accept a handle`);
      assert.ok(tool.inputSchema.properties.userId, `${name} must accept a userId`);
      // Neither is individually required — browser mode can only supply a
      // handle, and the OAuth path resolves one into the other.
      assert.equal(tool.inputSchema.required, undefined);
    }
  });

  /**
   * Before this, browser mode demanded `handle` while the schema required
   * `userId` and forbade extra properties — so the tool was advertised and
   * literally uncallable.
   */
  test("browser mode says how to identify a person when given only a userId", async (t) => {
    t.after(restoreLauncher);
    stubLauncher();
    const err = await xProvider
      .invokeTool("follow_user", { userId: "12345" }, browserCtx({ ...BROWSER_CREDENTIALS }))
      .then(() => null, (e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, /identify people by `handle`/);
    // And it says so before paying for a browser start.
    assert.doesNotMatch(err.message, new RegExp(LAUNCH_ATTEMPTED));
  });

  test("a handle is accepted and reaches the browser driver", async (t) => {
    t.after(restoreLauncher);
    stubLauncher();
    const err = await xProvider
      .invokeTool("follow_user", { handle: "@jack" }, browserCtx({ ...BROWSER_CREDENTIALS }))
      .then(() => null, (e: unknown) => e);
    assert.ok(err instanceof Error);
    assert.match(err.message, new RegExp(LAUNCH_ATTEMPTED));
  });
});

describe("catalog copy", () => {
  test("the browser-login blurb is honest about challenges and names the remedy", () => {
    const blurb = xProvider.catalog.browserLogin!.description!;
    assert.match(blurb, /captcha/i);
    assert.match(blurb, /never solves a challenge/i);
    assert.match(blurb, /Take over/);
    // It should also be plain about what browser mode cannot do at all.
    assert.match(blurb, /search, timelines, and DMs need the OAuth mode/);
  });
});
