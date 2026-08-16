import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  UNKNOWN_BROWSER_SESSION_HEALTH,
  blockClearedByManualSignIn,
  blockNeedsHuman,
  classifyBrowserBlock,
  cooldownForFailureCount,
  describeBrowserBlock,
  isCoolingDown,
  readSessionHealth,
  recordBrowserBlock,
  recordBrowserSessionOk,
  remedyForBlock,
  type BrowserBlockReason,
} from "./browserConnectionHealth.js";

const NOW = 1_700_000_000_000;

describe("classifyBrowserBlock", () => {
  /**
   * The real messages the X driver throws. If one of these stops mapping
   * to the right reason, an operator gets the wrong instructions — which is
   * the exact failure this module exists to prevent.
   */
  const cases: Array<[string, BrowserBlockReason]> = [
    [
      "X login page did not render the username field. The site may be showing a captcha or a temporary block.",
      "captcha",
    ],
    [
      "X is asking for a 2FA code. Browser-login mode does not support accounts with 2FA — turn off 2FA on this account or use the OAuth connection mode instead.",
      "two_factor",
    ],
    [
      'X is asking for an "unusual activity" verification (email or phone). Add a Verification value to the connection and try again.',
      "verification_required",
    ],
    [
      "playwright-core is not installed: Cannot find module. Browser-login connections require the App container to bundle Chromium.",
      "unavailable",
    ],
    ["X login failed: Wrong password!", "bad_credentials"],
    ["X login failed: Too many attempts, try again later", "rate_limited"],
    ["The saved session expired and the account was logged out", "session_expired"],
    [
      "X login timed out — the site did not advance to /home within 60s.",
      "captcha",
    ],
    ["Something nobody has ever seen before", "unknown"],
  ];

  for (const [message, expected] of cases) {
    test(`"${message.slice(0, 48)}…" → ${expected}`, () => {
      const result = classifyBrowserBlock(new Error(message));
      assert.equal(result.reason, expected);
      // The observed text is always preserved — an operator debugging a
      // drifted selector needs what the site actually said.
      assert.ok(result.message.startsWith(message.slice(0, 40)));
    });
  }

  test("a 2FA prompt outranks the word 'challenge' appearing alongside it", () => {
    assert.equal(
      classifyBrowserBlock(new Error("Enter the verification code from your challenge app")).reason,
      "two_factor",
    );
  });

  test("accepts non-Error values without throwing", () => {
    assert.equal(classifyBrowserBlock("plain string").reason, "unknown");
    assert.equal(classifyBrowserBlock(null).reason, "unknown");
    assert.equal(classifyBrowserBlock(undefined).message, "");
  });

  test("long site errors are truncated rather than stored whole", () => {
    const result = classifyBrowserBlock(new Error("x".repeat(5_000)));
    assert.equal(result.message.length, 500);
  });
});

describe("cooldown ladder", () => {
  test("climbs with consecutive failures and then holds at an hour", () => {
    assert.equal(cooldownForFailureCount(1), 60_000);
    assert.equal(cooldownForFailureCount(2), 5 * 60_000);
    assert.equal(cooldownForFailureCount(3), 15 * 60_000);
    assert.equal(cooldownForFailureCount(4), 60 * 60_000);
    assert.equal(cooldownForFailureCount(99), 60 * 60_000);
  });

  test("a zero or negative count still yields a real cooldown", () => {
    assert.equal(cooldownForFailureCount(0), 60_000);
    assert.equal(cooldownForFailureCount(-3), 60_000);
  });
});

describe("recordBrowserBlock", () => {
  test("first failure records the reason, the message and a cooldown", () => {
    const health = recordBrowserBlock({
      previous: undefined,
      error: new Error("X is asking for a 2FA code."),
      now: NOW,
    });
    assert.equal(health.state, "blocked");
    assert.equal(health.reason, "two_factor");
    assert.equal(health.failures, 1);
    assert.equal(health.retryAfter, NOW + 60_000);
    assert.equal(health.observedAt, NOW);
  });

  test("repeated failures of the same kind escalate the backoff", () => {
    let health = recordBrowserBlock({
      previous: undefined,
      error: new Error("captcha"),
      now: NOW,
    });
    health = recordBrowserBlock({ previous: health, error: new Error("captcha"), now: NOW + 1 });
    health = recordBrowserBlock({ previous: health, error: new Error("captcha"), now: NOW + 2 });
    assert.equal(health.failures, 3);
    assert.equal(health.retryAfter, NOW + 2 + 15 * 60_000);
  });

  test("a different failure mode restarts the ladder — it is new information", () => {
    const captcha = recordBrowserBlock({
      previous: undefined,
      error: new Error("captcha"),
      now: NOW,
    });
    const escalated = recordBrowserBlock({
      previous: captcha,
      error: new Error("captcha"),
      now: NOW,
    });
    assert.equal(escalated.failures, 2);
    const different = recordBrowserBlock({
      previous: escalated,
      error: new Error("Wrong password!"),
      now: NOW,
    });
    assert.equal(different.reason, "bad_credentials");
    assert.equal(different.failures, 1);
  });

  test("the last known-good timestamp survives a block", () => {
    const ok = recordBrowserSessionOk(NOW - 5_000);
    const blocked = recordBrowserBlock({ previous: ok, error: new Error("captcha"), now: NOW });
    assert.equal(blocked.lastOkAt, NOW - 5_000);
  });

  test("a success clears the block and the failure count", () => {
    const ok = recordBrowserSessionOk(NOW);
    assert.equal(ok.state, "ok");
    assert.equal(ok.failures, 0);
    assert.equal(ok.reason, undefined);
    assert.equal(ok.lastOkAt, NOW);
    assert.equal(isCoolingDown(ok, NOW), false);
  });
});

describe("isCoolingDown", () => {
  test("holds until retryAfter, then releases", () => {
    const health = recordBrowserBlock({
      previous: undefined,
      error: new Error("captcha"),
      now: NOW,
    });
    assert.equal(isCoolingDown(health, NOW), true);
    assert.equal(isCoolingDown(health, NOW + 59_999), true);
    assert.equal(isCoolingDown(health, NOW + 60_001), false);
  });

  test("a healthy or unseen connection never cools down", () => {
    assert.equal(isCoolingDown(undefined, NOW), false);
    assert.equal(isCoolingDown(UNKNOWN_BROWSER_SESSION_HEALTH, NOW), false);
    assert.equal(isCoolingDown(recordBrowserSessionOk(NOW), NOW), false);
  });
});

describe("who can clear a block", () => {
  test("challenges that need a person are named as such", () => {
    for (const reason of [
      "captcha",
      "two_factor",
      "verification_required",
      "bad_credentials",
    ] as BrowserBlockReason[]) {
      assert.equal(blockNeedsHuman(reason), true, reason);
    }
    for (const reason of ["session_expired", "rate_limited", "unknown"] as BrowserBlockReason[]) {
      assert.equal(blockNeedsHuman(reason), false, reason);
    }
    assert.equal(blockNeedsHuman(undefined), false);
  });

  test("a manual sign-in fixes everything except wrong credentials and a missing browser", () => {
    assert.equal(blockClearedByManualSignIn("captcha"), true);
    assert.equal(blockClearedByManualSignIn("two_factor"), true);
    assert.equal(blockClearedByManualSignIn("session_expired"), true);
    assert.equal(blockClearedByManualSignIn("bad_credentials"), false);
    assert.equal(blockClearedByManualSignIn("unavailable"), false);
  });
});

describe("remedyForBlock", () => {
  test("every reason produces concrete, site-named instructions", () => {
    const reasons: BrowserBlockReason[] = [
      "captcha",
      "two_factor",
      "verification_required",
      "bad_credentials",
      "rate_limited",
      "session_expired",
      "unavailable",
      "unknown",
    ];
    for (const reason of reasons) {
      const text = remedyForBlock({ reason, siteName: "X" });
      assert.ok(text.length > 40, `${reason} remedy is too thin`);
      assert.ok(text.includes("X"), `${reason} remedy does not name the site`);
    }
  });

  test("a captcha remedy never suggests Genosyn will solve it", () => {
    const text = remedyForBlock({ reason: "captcha", siteName: "X" });
    assert.match(text, /does not solve captchas/i);
    assert.match(text, /human/i);
  });

  test("wrong credentials point at Reconnect, not at a browser takeover", () => {
    const text = remedyForBlock({ reason: "bad_credentials", siteName: "X" });
    assert.match(text, /Reconnect/);
    assert.doesNotMatch(text, /Take over/);
  });

  test("the handoff copy adapts to whether Browser access is already on", () => {
    const withBrowser = remedyForBlock({
      reason: "captcha",
      siteName: "X",
      manualSignInAvailable: true,
    });
    const withoutBrowser = remedyForBlock({
      reason: "captcha",
      siteName: "X",
      manualSignInAvailable: false,
    });
    assert.match(withBrowser, /Ask the AI employee to open/);
    assert.match(withoutBrowser, /Turn on Browser access/);
    for (const text of [withBrowser, withoutBrowser]) {
      assert.match(text, /Take over/);
    }
  });
});

describe("describeBrowserBlock", () => {
  test("carries the observed error, the remedy, and the wait, in that order", () => {
    const health = recordBrowserBlock({
      previous: undefined,
      error: new Error("X login page did not render the username field."),
      now: NOW,
    });
    const text = describeBrowserBlock({ health, siteName: "X", now: NOW });
    assert.ok(text.startsWith("X login page did not render the username field."));
    assert.match(text, /does not solve captchas/i);
    assert.match(text, /will not retry the sign-in on its own for 1m/);
  });

  test("a machine-clearable block promises an automatic retry instead", () => {
    const health = recordBrowserBlock({
      previous: undefined,
      error: new Error("Too many requests, try again later"),
      now: NOW,
    });
    const text = describeBrowserBlock({ health, siteName: "X", now: NOW });
    assert.match(text, /retries automatically in 1m/);
    assert.doesNotMatch(text, /will not retry/);
  });

  test("the wait is dropped once the cooldown has lapsed", () => {
    const health = recordBrowserBlock({
      previous: undefined,
      error: new Error("captcha"),
      now: NOW,
    });
    const text = describeBrowserBlock({ health, siteName: "X", now: NOW + 10 * 60_000 });
    assert.doesNotMatch(text, /retry/i);
  });

  test("durations read in human units", () => {
    let health = recordBrowserBlock({ previous: undefined, error: new Error("captcha"), now: NOW });
    health = recordBrowserBlock({ previous: health, error: new Error("captcha"), now: NOW });
    assert.match(describeBrowserBlock({ health, siteName: "X", now: NOW }), /for 5m/);
    health = recordBrowserBlock({ previous: health, error: new Error("captcha"), now: NOW });
    health = recordBrowserBlock({ previous: health, error: new Error("captcha"), now: NOW });
    assert.match(describeBrowserBlock({ health, siteName: "X", now: NOW }), /for 1h/);
  });

  test("healthy and never-used sessions describe themselves plainly", () => {
    assert.match(
      describeBrowserBlock({ health: recordBrowserSessionOk(NOW), siteName: "X", now: NOW }),
      /signed in/,
    );
    assert.match(
      describeBrowserBlock({ health: UNKNOWN_BROWSER_SESSION_HEALTH, siteName: "X", now: NOW }),
      /has not been used yet/,
    );
  });

  test("a block with no captured message still says something useful", () => {
    const text = describeBrowserBlock({
      health: { state: "blocked", reason: "captcha" },
      siteName: "X",
      now: NOW,
    });
    assert.match(text, /blocked the browser sign-in/);
    assert.match(text, /does not solve captchas/i);
  });
});

describe("readSessionHealth", () => {
  test("round-trips a real record", () => {
    const health = recordBrowserBlock({
      previous: undefined,
      error: new Error("captcha"),
      now: NOW,
    });
    assert.deepEqual(readSessionHealth({ sessionHealth: health }), health);
  });

  test("a connection that predates health tracking reads as unknown, not as broken", () => {
    assert.deepEqual(readSessionHealth({ username: "a", password: "b" }), {
      state: "unknown",
    });
    assert.deepEqual(readSessionHealth(undefined), { state: "unknown" });
    assert.deepEqual(readSessionHealth(null), { state: "unknown" });
  });

  test("junk in the config never produces a fake block", () => {
    for (const junk of ["nope", 42, [], { state: "sideways" }, { state: null }]) {
      assert.deepEqual(readSessionHealth({ sessionHealth: junk }), { state: "unknown" });
    }
  });

  test("wrong-typed fields are dropped, not coerced", () => {
    const health = readSessionHealth({
      sessionHealth: {
        state: "blocked",
        reason: "captcha",
        message: 12,
        failures: "many",
        retryAfter: "soon",
        observedAt: null,
      },
    });
    assert.equal(health.state, "blocked");
    assert.equal(health.reason, "captcha");
    assert.equal(health.message, undefined);
    assert.equal(health.failures, undefined);
    assert.equal(health.retryAfter, undefined);
    // No retryAfter means nothing to wait for — we must not invent a hold.
    assert.equal(isCoolingDown(health, NOW), false);
  });
});
